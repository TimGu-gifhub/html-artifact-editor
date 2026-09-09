import { randomUUID } from 'node:crypto';
import { isDraftCheckpoint, isDraftCheckpointSeal, MAX_DRAFT_RECORD_BYTES } from '../../contracts/draft-checkpoint.ts';
import type { DraftCheckpoint, DraftCheckpointSeal, DraftRetirement } from '../../contracts/draft-checkpoint.ts';
import { isSaveIntent, isTransactionId, sameStoredIdentity } from '../../contracts/save-record.ts';
import type { RecoveryState } from '../../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { captureTextIntents, rebuildCheckpoint } from '../../core/history/checkpoint.ts';
import { captureHistoryIntents, rebuildHistoryCheckpoint } from '../../core/history/persistence.ts';
import type { HistoryCheckpoint } from '../../core/history/timeline.ts';
import { createTextHistory } from '../../core/history/timeline.ts';
import { freezeHistoryCheckpoint } from '../draft/history.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import type { SourceIndex } from '../../core/parser/source-index.ts';
import { checkedDirectory, digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import type { SaveSource, SaveTargetState } from '../../platform/save-source.ts';
import type { createSavePreparationStore } from './preparation.ts';
import { readDraftHeader, readDraftRetirement, freezeDraftCheckpoint as freeze } from './draft-records.ts';
import { draftOwnership } from './draft-ownership.ts';
import { compactCheckpoints } from './checkpoint-compaction.ts';
import { COMPACTION_LIMIT } from '../../contracts/checkpoint-compaction.ts';
import { resolutionFile } from '../../contracts/compaction-resolution.ts';
import { readCompactionResolutions } from './compaction-resolutions.ts';
import { saveResolutionFile } from '../../contracts/save-resolution.ts';
import { readSaveResolutions } from './save-resolutions.ts';

const STORE_LIMIT = 200 * 1024 * 1024;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const historyHash = (value: DraftCheckpoint): string | null => value.version === 2 ? digest(encode(value.history)) : null;
type SaveRecords = Awaited<ReturnType<typeof createSavePreparationStore>>;
type OwnedLock = Awaited<ReturnType<CheckedDirectory['writeNew']>>;
export type CheckpointInspection = Readonly<{
  checkpointId: string; phase: 'complete' | 'incomplete' | 'invalid'; state: RecoveryState;
  checkpoint: DraftCheckpoint | null; recordHash: string | null;
}>;
export type CheckpointWrite = Readonly<{
  status: 'persisted' | 'failed' | 'unknown'; checkpointId: string | null; draftRevision: number;
  resultHash: string; code: string | null; cleanupPending: boolean;
}>;
export type CheckpointRetirement = Readonly<{
  status: 'retired' | 'empty' | 'failed' | 'unknown'; checkpointId: string | null;
  code: string | null; cleanupPending: boolean;
}>;
export type CheckpointGroup = Readonly<{
  sessionId: string; targetKey: string; name: string; draftRevision: number; checkpointId: string | null;
  status: 'dirty' | 'clean' | 'retired' | 'incomplete' | 'invalid' | 'ambiguous' | 'saved';
  targetState: RecoveryState; retirement: DraftRetirement['reason'] | null;
  resultHash: string | null; recordHash: string | null;
  historyAvailable: boolean;
}>;
const errorCode = (error: unknown): string => {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === 'EEXIST') return 'DRAFT_STORAGE_LOCKED';
  if (value?.message === 'STORAGE_MAINTENANCE') return 'DRAFT_STORAGE_MAINTENANCE';
  if (value?.code === 'ENOSPC') return 'DRAFT_STORAGE_FULL';
  if (value?.code === 'EACCES' || value?.code === 'EPERM') return 'DRAFT_STORAGE_PERMISSION_DENIED';
  return /^DRAFT_[A-Z_]+$/u.test(value?.message ?? '') ? value!.message! : 'DRAFT_STORAGE_FAILED';
};

// Main-owned private checkpoints. HTML is never written here. Each checkpoint
// is independently sealed; incomplete writes cannot replace an earlier one.
export async function createDraftCheckpointStore(path: string, onStep: (step: string) => Promise<void> = async () => {}, saves?: SaveRecords) {
  const root = await checkedDirectory(path); let busy = false;
  const ownership = draftOwnership(root.identityChain.map(value => `${value.dev}:${value.ino}`).join('/'));
  if (saves && (saves.namespace.length !== root.identityChain.length || saves.namespace.some((entry, index) =>
    entry.dev !== root.identityChain[index]!.dev || entry.ino !== root.identityChain[index]!.ino))) throw new Error('DRAFT_STORAGE_ROOT_MISMATCH');
  const load = async (checkpointId: string) => {
    if (!isTransactionId(checkpointId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const folder = await root.directory(checkpointId);
    const file = await folder.read('record.json', MAX_DRAFT_RECORD_BYTES);
    const value = decode(file.bytes);
    if (!isDraftCheckpoint(value) || value.checkpointId !== checkpointId) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const checkpoint = freeze(value);
    const files = await folder.entries(5);
    const allowed = ['record.json', 'baseline.bin', 'complete.json', 'retired.json', ...(checkpoint.version === 2 ? ['origin.bin'] : [])];
    if (files.some(file => file.kind !== 'file' || !allowed.includes(file.name))) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const baseline = await folder.read('baseline.bin', MAX_SOURCE_BYTES);
    const sealed = await folder.read('complete.json', 1024); const seal = decode(sealed.bytes);
    if (!isDraftCheckpointSeal(seal) || seal.checkpointId !== checkpointId || seal.recordHash !== file.hash
      || baseline.hash !== checkpoint.baseHash || baseline.bytes.length !== checkpoint.baseSize) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const identity = { projectId: 'checkpoint', documentId: checkpointId, generation: 1 };
    let history: HistoryCheckpoint | null = null;
    if (checkpoint.version === 2) {
      const origin = await folder.read('origin.bin', MAX_SOURCE_BYTES);
      history = freezeHistoryCheckpoint(rebuildHistoryCheckpoint(baseline.bytes, identity, checkpoint, origin.bytes, digest).capture());
    } else rebuildCheckpoint(createSourceIndex(baseline.bytes, identity, digest), checkpoint, digest);
    await folder.verify(); await root.verify();
    return { checkpoint, baseline: baseline.bytes, recordHash: file.hash, history };
  };
  const classify = async (checkpoint: DraftCheckpoint, readTarget?: () => Promise<SaveTargetState>): Promise<RecoveryState> => {
    if (!readTarget) return 'unavailable';
    let target: SaveTargetState;
    try { target = await readTarget(); } catch { return 'unavailable'; }
    if (target.targetKey !== checkpoint.targetKey) return 'wrong-target';
    if (target.hash === checkpoint.baseHash && sameStoredIdentity(target.identity, checkpoint.identity)) return 'baseline-matches';
    if (target.hash !== checkpoint.resultHash) return 'conflict';
    if (saves) try {
      // A crash can happen after committed.json but before draft retirement.
      // Correlate the exact old version and new bytes, then verify that commit's
      // actual target version. Matching candidate bytes alone is insufficient.
      const scan = await saves.scan();
      for (const item of scan.records) {
        const intent = item.intent;
        if (item.phase === 'committed' && intent?.targetKey === checkpoint.targetKey && intent.oldHash === checkpoint.baseHash
          && intent.newHash === checkpoint.resultHash && sameStoredIdentity(intent.identity, checkpoint.identity)
          && (await saves.inspect(item.transactionId, readTarget)).state === 'committed-matches') return 'committed-matches';
      }
    } catch { /* The checkpoint is valid, but a save cannot be confirmed. */ }
    return 'candidate-on-disk';
  };
  const inspect = async (checkpointId: string, readTarget?: () => Promise<SaveTargetState>): Promise<CheckpointInspection> => {
    try {
      const { checkpoint, recordHash } = await load(checkpointId);
      return Object.freeze({ checkpointId, checkpoint, recordHash, phase: 'complete', state: await classify(checkpoint, readTarget) });
    } catch (error) {
      const phase = (error as { code?: string }).code === 'ENOENT' ? 'incomplete' : 'invalid';
      return Object.freeze({ checkpointId, checkpoint: null, recordHash: null, phase, state: phase });
    }
  };
  const inventory = async () => {
    const items = await root.entries(512); let used = 0;
    const resolutions = await readCompactionResolutions(root, items.map(item => item.name));
    const saveResolutions = await readSaveResolutions(root, items.map(item => item.name));
    const entries: { name: string; type: 'draft' | 'save' | 'unknown' | 'lock' | 'compaction' | 'resolution' }[] = [];
    for (const item of items) {
      if (resolutionFile(item.name) || saveResolutionFile(item.name)) { used += item.size; entries.push({ name: item.name, type: 'resolution' }); continue; }
      if (item.name === 'active.lock' && item.kind === 'file') { used += item.size; entries.push({ name: item.name, type: 'lock' }); continue; }
      if (item.name === 'compaction.json' && item.kind === 'file') {
        if (item.size > COMPACTION_LIMIT) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        used += item.size; entries.push({ name: item.name, type: 'compaction' }); continue;
      }
      if (item.kind !== 'directory' || !isTransactionId(item.name)) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
      const folder = await root.directory(item.name);
      const files = await folder.entries(7); const saved = files.some(file => file.name === 'intent.json');
      const type = saved ? 'save' : files.some(file => file.name === 'record.json') ? 'draft' : 'unknown';
      const allowed = saved ? ['intent.json', 'backup.bin', 'candidate.bin', 'prepared.json', 'cancelled.json', 'replacing.json', 'committed.json']
        : ['record.json', 'baseline.bin', 'origin.bin', 'complete.json', 'retired.json'];
      for (const file of files) {
        if (file.kind !== 'file' || !allowed.includes(file.name)) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        used += file.size;
      }
      entries.push({ name: item.name, type });
      if (used > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
    }
    if (used > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
    return { entries, used, resolutions: [...resolutions, ...saveResolutions] };
  };
  const records = async () => {
    const { entries, used, resolutions } = await inventory(); const known = [];
    const unclassified: string[] = resolutions.filter(row => !row.seal).map(row => row.name);
    for (const item of entries) {
      if (item.type === 'lock' || item.type === 'save' || item.type === 'resolution') continue;
      if (item.type === 'compaction') { unclassified.push(item.name); continue; }
      try {
        const header = await readDraftHeader(root, item.name);
        let retirement: DraftRetirement | null = null; let invalidRetirement = false;
        try { retirement = await readDraftRetirement(header); } catch { invalidRetirement = true; }
        // A damaged anchor can obscure which session was ended. Do not let a
        // different/older header make that session look recoverable again.
        if (invalidRetirement) unclassified.push(item.name);
        // Keep only binding metadata across records, not all documents' intents.
        const { history: omittedHistory, ...envelope } = header.checkpoint.version === 2 ? header.checkpoint : { ...header.checkpoint, history: undefined };
        const { intents, ...binding } = envelope;
        known.push({ header: { folder: header.folder, checkpoint: Object.freeze(binding), hash: header.hash },
          changeCount: intents.length, historyHash: historyHash(header.checkpoint), retirement, invalidRetirement });
      } catch { unclassified.push(item.name); }
    }
    await root.verify();
    return { known, unclassified, used, locked: entries.some(item => item.type === 'lock') };
  };
  const retirementFor = (rows: Awaited<ReturnType<typeof records>>['known'], sessionId: string) => {
    const matches = rows.filter(row => row.header.checkpoint.sessionId === sessionId);
    if (matches.some(row => row.invalidRetirement)) throw new Error('DRAFT_RETIREMENT_INVALID');
    const closed = matches.filter(row => row.retirement !== null);
    if (closed.length > 1) throw new Error('DRAFT_RETIREMENT_INVALID');
    const retirement = closed[0]?.retirement ?? null;
    if (retirement && matches.some(row => row.header.checkpoint.draftRevision > retirement.draftRevision)) throw new Error('DRAFT_RETIREMENT_INVALID');
    return retirement;
  };
  const compactOwned = async (sessionId: string, lock: OwnedLock) => {
    const all = await records();
    if (all.unclassified.length) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
    if (retirementFor(all.known, sessionId)) throw new Error('DRAFT_SESSION_RETIRED');
    const rows = all.known.filter(row => row.header.checkpoint.sessionId === sessionId);
    const maximum = Math.max(0, ...rows.map(row => row.header.checkpoint.draftRevision));
    const ambiguous = new Set<number>(); const bindings = new Map<number, string>();
    for (const row of rows) {
      const revision = row.header.checkpoint.draftRevision; const binding = `${row.header.checkpoint.resultHash}:${row.historyHash}`;
      if (bindings.has(revision) && bindings.get(revision) !== binding) ambiguous.add(revision);
      bindings.set(revision, binding);
    }
    const points = [];
    for (const row of rows) {
      if (ambiguous.has(row.header.checkpoint.draftRevision)) continue;
      const value = await inspect(row.header.checkpoint.checkpointId);
      if (value.phase !== 'complete') continue; // Failed/incomplete evidence is retained.
      if (value.recordHash !== row.header.hash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
      if (value.checkpoint!.version === 2) points.push({ checkpoint: value.checkpoint!, recordHash: value.recordHash! });
    }
    // Never remove older complete points when the newest revision is incomplete.
    if (!points.some(point => point.checkpoint.draftRevision === maximum)) return null;
    return compactCheckpoints(root, points, load, lock.verifyOwned, onStep, STORE_LIMIT - all.used);
  };
  const selectLatest = async (sessionId: string, source: SaveSource, allowSaved = false): Promise<CheckpointGroup> => {
    if (!isTransactionId(sessionId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const catalog = await operations.catalog(source.current);
    if (catalog.locked) throw new Error('DRAFT_STORAGE_LOCKED');
    if (catalog.unclassified.length) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
    const group = catalog.groups.find(group => group.sessionId === sessionId);
    const saved = allowSaved && group?.status === 'saved' && group.historyAvailable && group.targetState === 'committed-matches';
    if (!group || (!saved && ((group.status !== 'dirty' && !(group.status === 'clean' && group.historyAvailable))
      || group.targetState !== 'baseline-matches')) || !group.checkpointId) throw new Error('DRAFT_RECOVERY_UNAVAILABLE');
    return group;
  };
  const committedProof = async (checkpoint: DraftCheckpoint, source: SaveSource) => {
    if (!saves) throw new Error('DRAFT_SAVED_HISTORY_UNCONFIRMED');
    const scan = await saves.scan();
    if (scan.unrecognized) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
    const matches: string[] = [];
    for (const row of scan.records) {
      if (row.phase !== 'committed' || row.intent?.targetKey !== checkpoint.targetKey || row.intent.oldHash !== checkpoint.baseHash
        || row.intent.newHash !== checkpoint.resultHash) continue;
      const value = await saves.inspect(row.transactionId, source.current); const intent = value.intent;
      if (value.state !== 'committed-matches' || !intent || intent.targetKey !== checkpoint.targetKey
        || intent.oldHash !== checkpoint.baseHash || intent.oldSize !== checkpoint.baseSize || intent.newHash !== checkpoint.resultHash
        || intent.newSize !== source.size || !sameStoredIdentity(intent.identity, checkpoint.identity)) continue;
      const folder = await root.directory(row.transactionId);
      const header = await folder.read('intent.json', 16 * 1024); const commit = await folder.read('committed.json', 16 * 1024);
      matches.push(`${row.transactionId}:${header.hash}:${commit.hash}`);
    }
    if (matches.length !== 1) throw new Error('DRAFT_SAVED_HISTORY_UNCONFIRMED');
    return matches[0]!;
  };
  const operations = { inspect, claimSession: ownership.claim, isSessionActive: ownership.isActive,
    async catalog(readTarget?: () => Promise<SaveTargetState>) {
      const all = await records(); const groups: CheckpointGroup[] = [];
      const sessions = new Set(all.known.map(row => row.header.checkpoint.sessionId));
      for (const sessionId of [...sessions].sort()) {
        const rows = all.known.filter(row => row.header.checkpoint.sessionId === sessionId);
        const first = rows[0]!.header.checkpoint;
        const revision = Math.max(...rows.map(row => row.header.checkpoint.draftRevision));
        const latest = rows.filter(row => row.header.checkpoint.draftRevision === revision);
        const latestValue = latest[0]!.header.checkpoint;
        const summary = { sessionId, targetKey: first.targetKey, name: first.name, draftRevision: revision };
        let status: CheckpointGroup['status'] = 'incomplete'; let checkpointId: string | null = null;
        let targetState: RecoveryState = 'incomplete'; let retirement: DraftRetirement['reason'] | null = null;
        let resultHash: string | null = null; let recordHash: string | null = null;
        let historyAvailable = false;
        try {
          if (rows.some(row => row.header.checkpoint.targetKey !== first.targetKey || row.header.checkpoint.baseHash !== first.baseHash
            || !sameStoredIdentity(row.header.checkpoint.identity, first.identity))
            || latest.some(row => row.header.checkpoint.resultHash !== latestValue.resultHash
              || row.historyHash !== latest[0]!.historyHash)) throw new Error('DRAFT_CHECKPOINT_AMBIGUOUS');
          const terminal = retirementFor(all.known, sessionId);
          if (terminal) { status = 'retired'; retirement = terminal.reason; targetState = 'unavailable'; }
          else {
            let invalid = false;
            for (const row of latest.sort((a, b) => a.header.checkpoint.checkpointId.localeCompare(b.header.checkpoint.checkpointId))) {
              const value = await inspect(row.header.checkpoint.checkpointId, readTarget);
              if (value.phase === 'complete' && value.recordHash === row.header.hash) {
                checkpointId = value.checkpointId; targetState = value.state;
                resultHash = value.checkpoint!.resultHash; recordHash = value.recordHash;
                historyAvailable = value.checkpoint!.version === 2;
                status = value.state === 'committed-matches' ? 'saved' : value.checkpoint!.intents.length ? 'dirty' : 'clean'; break;
              }
              invalid ||= value.phase !== 'incomplete';
            }
            if (!checkpointId && invalid) { status = 'invalid'; targetState = 'invalid'; }
          }
        } catch (error) {
          status = error instanceof Error && error.message === 'DRAFT_CHECKPOINT_AMBIGUOUS' ? 'ambiguous' : 'invalid'; targetState = 'invalid';
        }
        groups.push(Object.freeze({ ...summary, checkpointId, status, targetState, retirement, resultHash, recordHash, historyAvailable }));
      }
      return Object.freeze({ groups: Object.freeze(groups), unclassified: Object.freeze(all.unclassified), locked: all.locked,
        reviewRequired: all.unclassified.length > 0 || groups.some(group => ['invalid', 'incomplete', 'ambiguous'].includes(group.status)) });
    },
    async scan() {
      const { entries } = await inventory(); const records = [];
      for (const item of entries) {
        if (item.type === 'lock' || item.type === 'save' || item.type === 'compaction' || item.type === 'resolution') continue;
        const result = await inspect(item.name); const checkpoint = result.checkpoint;
        // Listing retains metadata and counts, not every document's text/bytes.
        const summary = checkpoint ? Object.freeze({ checkpointId: checkpoint.checkpointId, sessionId: checkpoint.sessionId,
          draftRevision: checkpoint.draftRevision, createdAt: checkpoint.createdAt, targetKey: checkpoint.targetKey,
          name: checkpoint.name, baseHash: checkpoint.baseHash, resultHash: checkpoint.resultHash, changeCount: checkpoint.intents.length }) : null;
        records.push(Object.freeze({ checkpointId: item.name, phase: result.phase, summary }));
      }
      return Object.freeze({ records: Object.freeze(records), locked: entries.some(item => item.name === 'active.lock') });
    },
    async write(source: SaveSource, index: SourceIndex, candidate: PatchCandidate, sessionId: string, draftRevision: number,
      fullHistory?: HistoryCheckpoint): Promise<CheckpointWrite> {
      let checkpointId: string | null = null; let lock: OwnedLock | undefined; let sealing = false; let acquiringLock = false;
      let resultHash = ''; let persisted = false; let cleanupPending = false; let code: string | null = null; let retainLock = false;
      let releaseOperation: (() => void) | undefined;
      if (busy) return Object.freeze({ status: 'failed', checkpointId, draftRevision, resultHash, code: 'DRAFT_STORAGE_BUSY', cleanupPending });
      busy = true;
      try {
        releaseOperation = ownership.claimOperation();
        // Freeze/validate synchronously before awaiting I/O. An external source
        // edit must not prevent retaining a draft of the originally opened bytes.
        const history = fullHistory === undefined ? undefined : freezeHistoryCheckpoint(fullHistory);
        const intents = history ? captureHistoryIntents(index, candidate, history, digest) : captureTextIntents(index, candidate, digest);
        const baseline = source.bytes;
        if (source.baseHash !== index.baseHash || digest(baseline) !== index.baseHash) throw new Error('DRAFT_CHECKPOINT_MISMATCH');
        resultHash = candidate.resultHash;
        const id = randomUUID(); const record = freeze({ checkpointId: id, sessionId, draftRevision, createdAt: Date.now(),
          targetKey: source.targetKey, name: source.name, identity: source.identity, baseHash: source.baseHash,
          baseSize: baseline.length, resultHash, intents, ...(history ? { version: 2 as const, history: history.record } : { version: 1 as const }) });
        if (!isDraftCheckpoint(record)) throw new Error('DRAFT_CHECKPOINT_INVALID');
        const bytes = encode(record); if (bytes.length > MAX_DRAFT_RECORD_BYTES) throw new Error('DRAFT_STORAGE_LIMIT');
        acquiringLock = true;
        lock = await root.writeNew('active.lock', encode({ version: 1, checkpointId: id }), step => onStep(`lock-${step}`));
        acquiringLock = false;
        const compact = async (): Promise<void> => {
          if (!history || !ownership.isActive(sessionId)) return;
          try {
            const result = await compactOwned(sessionId, lock!);
            if (result?.status === 'failed' || result?.status === 'unknown') { retainLock = result.retainLock; throw new Error(result.code!); }
          } catch (error) { cleanupPending = true; throw error; }
        };
        let { entries, used, resolutions } = await inventory(); let count = 0; let existingId: string | null = null;
        if (resolutions.some(row => !row.seal)) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        for (const item of entries) {
          if (item.type === 'lock' || item.type === 'resolution') continue;
          if (item.type === 'compaction') throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
          const folder = await root.directory(item.name);
          const priorFile = await folder.read(item.type === 'save' ? 'intent.json' : 'record.json',
            item.type === 'save' ? 16 * 1024 : MAX_DRAFT_RECORD_BYTES);
          const prior = decode(priorFile.bytes);
          if (item.type === 'save') {
            if (!isSaveIntent(prior) || prior.transactionId !== item.name) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
            if (prior.targetKey === source.targetKey) count++;
            continue;
          }
          if (!isDraftCheckpoint(prior) || prior.checkpointId !== item.name) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
          if (prior.version === 1 && (await folder.entries(5)).some(file => file.name === 'origin.bin')) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
          const retirement = await readDraftRetirement({ folder, checkpoint: prior, hash: priorFile.hash });
          if (prior.sessionId === sessionId) {
            if (prior.targetKey !== source.targetKey || prior.baseHash !== source.baseHash
              || !sameStoredIdentity(prior.identity, source.identity)) throw new Error('DRAFT_SESSION_MISMATCH');
            if (retirement) throw new Error('DRAFT_SESSION_RETIRED');
          }
          if (prior.targetKey === source.targetKey) count++;
          if (prior.sessionId === sessionId && prior.draftRevision > draftRevision) throw new Error('DRAFT_CHECKPOINT_STALE');
          if (prior.sessionId === sessionId && prior.draftRevision === draftRevision) {
            if (prior.targetKey !== record.targetKey || prior.baseHash !== record.baseHash || prior.resultHash !== record.resultHash
              || historyHash(prior) !== historyHash(record) || !sameStoredIdentity(prior.identity, record.identity)) throw new Error('DRAFT_CHECKPOINT_STALE');
            const existing = await inspect(item.name);
            if (existing.phase === 'complete') {
              const actual = existing.checkpoint!;
              if (actual.sessionId !== sessionId || actual.draftRevision !== draftRevision || actual.targetKey !== record.targetKey
                || actual.baseHash !== record.baseHash || actual.resultHash !== resultHash
                || historyHash(actual) !== historyHash(record) || !sameStoredIdentity(actual.identity, record.identity)) throw new Error('DRAFT_CHECKPOINT_STALE');
              existingId = item.name;
            }
          }
        }
        if (existingId) { await lock.verifyOwned(); checkpointId = existingId; persisted = true; }
        else {
          if (count >= 20 || used + baseline.length + (history?.record.originSize ?? 0) + bytes.length + 1024 > STORE_LIMIT) {
            await compact();
            const fresh = await inventory(); used = fresh.used;
            // Only this session's confirmed older points could have been removed.
            count -= entries.filter(item => item.type === 'draft' && !fresh.entries.some(row => row.name === item.name)).length;
            entries = fresh.entries;
          }
          if (count >= 20 || used + baseline.length + (history?.record.originSize ?? 0) + bytes.length + 1024 > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
          const folder = await root.directory(id, true); checkpointId = id;
          await onStep('directory');
          const header = await folder.writeNew('record.json', bytes, step => onStep(`record-${step}`));
          await folder.writeNew('baseline.bin', baseline, step => onStep(`baseline-${step}`));
          if (history) {
            await folder.writeNew('origin.bin', history.originBytes, step => onStep(`origin-${step}`));
            if ((await folder.read('origin.bin', MAX_SOURCE_BYTES)).hash !== history.record.originHash) throw new Error('DRAFT_CHECKPOINT_INVALID');
          }
          if ((await folder.read('record.json', MAX_DRAFT_RECORD_BYTES)).hash !== header.hash
            || (await folder.read('baseline.bin', MAX_SOURCE_BYTES)).hash !== record.baseHash) throw new Error('DRAFT_CHECKPOINT_INVALID');
          await lock.verifyOwned();
          const seal: DraftCheckpointSeal = Object.freeze({ version: 1, checkpointId: id, recordHash: header.hash });
          sealing = true; await folder.writeNew('complete.json', encode(seal), step => onStep(`complete-${step}`));
          const observed = await load(id);
          if (observed.recordHash !== header.hash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
          await folder.verify(); await lock.verifyOwned(); persisted = true;
        }
        await compact();
      } catch (error) { code = errorCode(error); }
      finally {
        if (lock && !retainLock) {
          try { await onStep('release-lock'); await lock.removeOwned(); }
          catch { cleanupPending = true; code = 'DRAFT_CLEANUP_PENDING'; }
        }
        else if (retainLock || (acquiringLock && code !== 'DRAFT_STORAGE_LOCKED')) cleanupPending = true;
        busy = false; releaseOperation?.();
      }
      return Object.freeze({ status: persisted ? 'persisted' : sealing ? 'unknown' : 'failed', checkpointId, draftRevision, resultHash, code, cleanupPending });
    },
    async restoreCandidate(checkpointId: string, source: SaveSource, index: SourceIndex): Promise<PatchCandidate> {
      const { checkpoint, history } = await load(checkpointId);
      const assertActive = async (): Promise<void> => {
        const all = await records();
        if (all.unclassified.length) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        if (retirementFor(all.known, checkpoint.sessionId)) throw new Error('DRAFT_SESSION_RETIRED');
      };
      await assertActive();
      const state = await classify(checkpoint, source.current);
      if (state === 'committed-matches') throw new Error('DRAFT_ALREADY_SAVED');
      if (state !== 'baseline-matches' || index.baseHash !== source.baseHash) throw new Error('DRAFT_RECOVERY_CONFLICT');
      await source.verify();
      const candidate = checkpoint.version === 2
        ? rebuildHistoryCheckpoint(index.bytes, index.identity, checkpoint, history!.originBytes, digest).candidate
        : rebuildCheckpoint(index, checkpoint, digest);
      if (history) captureHistoryIntents(index, candidate, history, digest);
      await source.verify(); await assertActive();
      return candidate;
    },
    // Main preflights lineage before creating the unpublished Preview mapping.
    // The later resolveLatest call reselects/revalidates the complete checkpoint.
    async readLatestHistory(sessionId: string, source: SaveSource) {
      const before = await selectLatest(sessionId, source); await source.verify();
      const loaded = await load(before.checkpointId!); await source.verify();
      if (loaded.recordHash !== before.recordHash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
      return loaded.history;
    },
    // A saved v2 point supplies history, never a candidate to replay. The caller
    // owns both sessions and must seal the new clean point before installation.
    // Existing continuation evidence (even incomplete/retired) prevents fallback.
    async prepareRecovery(sessionId: string, source: SaveSource, continuationSessionId: string) {
      if (!isTransactionId(continuationSessionId) || continuationSessionId === sessionId) throw new Error('DRAFT_SESSION_MISMATCH');
      const before = await selectLatest(sessionId, source, true);
      if (before.status !== 'saved') return Object.freeze({ kind: 'draft' as const, sessionId,
        history: await operations.readLatestHistory(sessionId, source),
        resolve: (index: SourceIndex) => operations.resolveLatest(sessionId, source, index) });
      const verifySource = async (): Promise<void> => {
        try { await source.verify(); } catch { throw new Error('DRAFT_RECOVERY_CONFLICT'); }
      };
      await verifySource(); const loaded = await load(before.checkpointId!);
      if (loaded.recordHash !== before.recordHash || !loaded.history) throw new Error('DRAFT_CHECKPOINT_CHANGED');
      const proof = await committedProof(loaded.checkpoint, source);
      const prior = createTextHistory(loaded.baseline, { projectId: 'checkpoint', documentId: before.checkpointId!, generation: 1 }, digest, loaded.history);
      const history = freezeHistoryCheckpoint(prior.rebaseSaved(source.bytes,
        { projectId: 'recovery', documentId: continuationSessionId, generation: 1 }).capture());
      const verify = async (): Promise<void> => {
        await verifySource(); const after = await selectLatest(sessionId, source, true);
        if (after.status !== 'saved' || before.checkpointId !== after.checkpointId || before.recordHash !== after.recordHash
          || before.draftRevision !== after.draftRevision || before.resultHash !== after.resultHash
          || proof !== await committedProof(loaded.checkpoint, source)) throw new Error('DRAFT_CHECKPOINT_CHANGED');
        const all = await records();
        if (all.locked) throw new Error('DRAFT_STORAGE_LOCKED');
        if (all.unclassified.length) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        for (const row of all.known) {
          const record = row.header.checkpoint;
          if (record.sessionId === sessionId || record.targetKey !== source.targetKey || record.baseHash !== source.baseHash
            || !sameStoredIdentity(record.identity, source.identity)) continue;
          if (record.sessionId !== continuationSessionId) throw new Error('DRAFT_SAVED_HISTORY_SUPERSEDED');
          if (record.draftRevision !== history.record.revision || record.resultHash !== source.baseHash
            || row.historyHash !== digest(encode(history.record)) || row.retirement || row.invalidRetirement) throw new Error('DRAFT_CHECKPOINT_CHANGED');
          const value = await inspect(record.checkpointId);
          if (value.phase !== 'complete' || value.recordHash !== row.header.hash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
        }
        await verifySource();
      };
      await verify();
      return Object.freeze({ kind: 'saved' as const, sessionId: continuationSessionId, history,
        async resolve(index: SourceIndex) {
          const candidate = createTextHistory(index.bytes, index.identity, digest, history).candidate;
          captureHistoryIntents(index, candidate, history, digest);
          if (index.baseHash !== source.baseHash || candidate.patches.length) throw new Error('DRAFT_HISTORY_MISMATCH');
          await verify();
          return Object.freeze({ candidate, history, sessionId: continuationSessionId,
            checkpointId: null, draftRevision: history.record.revision, verify });
        } });
    },
    async resolveLatest(sessionId: string, source: SaveSource, index: SourceIndex) {
      const select = () => selectLatest(sessionId, source);
      const before = await select(); const candidate = await operations.restoreCandidate(before.checkpointId!, source, index);
      const loaded = await load(before.checkpointId!);
      if (loaded.recordHash !== before.recordHash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
      const verifySource = async (): Promise<void> => {
        try { await source.verify(); } catch { throw new Error('DRAFT_RECOVERY_CONFLICT'); }
      };
      const verify = async (): Promise<void> => {
        await verifySource(); const after = await select(); await verifySource();
        if (before.checkpointId !== after.checkpointId || before.draftRevision !== after.draftRevision
          || before.recordHash !== after.recordHash || candidate.resultHash !== after.resultHash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
      };
      await verify();
      return Object.freeze({ candidate, history: loaded.history, sessionId, checkpointId: before.checkpointId!, draftRevision: before.draftRevision, verify });
    },
    async restoreLatest(sessionId: string, source: SaveSource, index: SourceIndex): Promise<PatchCandidate> {
      return (await operations.resolveLatest(sessionId, source, index)).candidate;
    },
    // Main calls this only after an explicit discard or verified save-copy
    // decision, with that session's writes drained and further edits frozen.
    // It retires private recovery data; it never saves or deletes HTML/bytes.
    async retire(source: SaveSource, sessionId: string, draftRevision: number, reason: DraftRetirement['reason']): Promise<CheckpointRetirement> {
      let lock: OwnedLock | undefined; let acquiringLock = false; let writing = false;
      let releaseOperation: (() => void) | undefined;
      let checkpointId: string | null = null; let status: CheckpointRetirement['status'] = 'failed';
      let code: string | null = null; let cleanupPending = false;
      if (busy) return Object.freeze({ status, checkpointId, code: 'DRAFT_STORAGE_BUSY', cleanupPending });
      busy = true;
      try {
        releaseOperation = ownership.claimOperation();
        if (!isTransactionId(sessionId) || !Number.isSafeInteger(draftRevision) || draftRevision < 1
          || !['discarded', 'copied'].includes(reason)) throw new Error('DRAFT_RETIREMENT_INVALID');
        acquiringLock = true;
        lock = await root.writeNew('active.lock', encode({ version: 1, retirementId: randomUUID() }), step => onStep(`lock-${step}`));
        acquiringLock = false;
        const all = await records();
        if (all.unclassified.length) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        const matching = all.known.filter(row => row.header.checkpoint.sessionId === sessionId);
        if (!matching.length) status = 'empty';
        else {
          if (matching.some(row => row.header.checkpoint.targetKey !== source.targetKey || row.header.checkpoint.baseHash !== source.baseHash
            || !sameStoredIdentity(row.header.checkpoint.identity, source.identity))) throw new Error('DRAFT_SESSION_MISMATCH');
          const existing = retirementFor(all.known, sessionId);
          if (existing) {
            if (existing.draftRevision !== draftRevision || existing.reason !== reason) throw new Error('DRAFT_SESSION_RETIRED');
            checkpointId = existing.checkpointId; status = 'retired';
          } else {
            matching.sort((a, b) => b.header.checkpoint.draftRevision - a.header.checkpoint.draftRevision
              || a.header.checkpoint.checkpointId.localeCompare(b.header.checkpoint.checkpointId));
            const anchor = matching[0]!.header;
            if (anchor.checkpoint.draftRevision > draftRevision) throw new Error('DRAFT_RETIREMENT_STALE');
            if (all.used + 2048 > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
            const retirement: DraftRetirement = Object.freeze({ version: 1, checkpointId: anchor.checkpoint.checkpointId,
              recordHash: anchor.hash, sessionId, draftRevision, reason, createdAt: Date.now() });
            checkpointId = retirement.checkpointId;
            await lock.verifyOwned(); writing = true;
            const written = await anchor.folder.writeNew('retired.json', encode(retirement), step => onStep(`retirement-${step}`));
            const fresh = await readDraftHeader(root, checkpointId);
            const observed = await readDraftRetirement(fresh);
            if (fresh.hash !== anchor.hash || JSON.stringify(observed) !== JSON.stringify(retirement)
              || (await fresh.folder.read('retired.json', 2048)).hash !== written.hash) throw new Error('DRAFT_RETIREMENT_CHANGED');
            status = 'retired';
          }
        }
        await lock.verifyOwned();
      } catch (error) { code = errorCode(error); status = writing ? 'unknown' : 'failed'; }
      finally {
        if (lock) {
          try { await onStep('release-lock'); await lock.removeOwned(); }
          catch { cleanupPending = true; code = 'DRAFT_CLEANUP_PENDING'; }
        } else if (acquiringLock && code !== 'DRAFT_STORAGE_LOCKED') cleanupPending = true;
        busy = false; releaseOperation?.();
      }
      return Object.freeze({ status, checkpointId, code, cleanupPending });
    },
  };
  return Object.freeze(operations);
}
