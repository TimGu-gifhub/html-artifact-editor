import { randomUUID } from 'node:crypto';
import { isDraftCheckpoint, isDraftCheckpointSeal, MAX_DRAFT_RECORD_BYTES } from '../../contracts/draft-checkpoint.ts';
import type { DraftCheckpoint, DraftCheckpointSeal } from '../../contracts/draft-checkpoint.ts';
import { isSaveIntent, isTransactionId, sameStoredIdentity } from '../../contracts/save-record.ts';
import type { RecoveryState } from '../../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { captureTextIntents, rebuildCheckpoint } from '../../core/history/checkpoint.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import type { SourceIndex } from '../../core/parser/source-index.ts';
import { checkedDirectory, digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import type { SaveSource, SaveTargetState } from '../../platform/save-source.ts';
import type { createSavePreparationStore } from './preparation.ts';

const STORE_LIMIT = 200 * 1024 * 1024;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const freeze = (value: DraftCheckpoint): DraftCheckpoint => Object.freeze({ ...value,
  identity: Object.freeze({ ...value.identity }), intents: Object.freeze(value.intents.map(intent => Object.freeze({ ...intent }))) });
type SaveRecords = Awaited<ReturnType<typeof createSavePreparationStore>>;
type OwnedLock = Awaited<ReturnType<CheckedDirectory['writeNew']>>;
export type CheckpointInspection = Readonly<{
  checkpointId: string; phase: 'complete' | 'incomplete' | 'invalid'; state: RecoveryState;
  checkpoint: DraftCheckpoint | null;
}>;
export type CheckpointWrite = Readonly<{
  status: 'persisted' | 'failed' | 'unknown'; checkpointId: string | null; draftRevision: number;
  resultHash: string; code: string | null; cleanupPending: boolean;
}>;
const errorCode = (error: unknown): string => {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === 'EEXIST') return 'DRAFT_STORAGE_LOCKED';
  if (value?.code === 'ENOSPC') return 'DRAFT_STORAGE_FULL';
  if (value?.code === 'EACCES' || value?.code === 'EPERM') return 'DRAFT_STORAGE_PERMISSION_DENIED';
  return /^DRAFT_[A-Z_]+$/u.test(value?.message ?? '') ? value!.message! : 'DRAFT_STORAGE_FAILED';
};

// Main-owned private checkpoints. HTML is never written here. Each checkpoint
// is independently sealed; incomplete writes cannot replace an earlier one.
export async function createDraftCheckpointStore(path: string, onStep: (step: string) => Promise<void> = async () => {}, saves?: SaveRecords) {
  const root = await checkedDirectory(path); let busy = false;
  if (saves && (saves.namespace.length !== root.identityChain.length || saves.namespace.some((entry, index) =>
    entry.dev !== root.identityChain[index]!.dev || entry.ino !== root.identityChain[index]!.ino))) throw new Error('DRAFT_STORAGE_ROOT_MISMATCH');
  const load = async (checkpointId: string) => {
    if (!isTransactionId(checkpointId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const folder = await root.directory(checkpointId);
    const file = await folder.read('record.json', MAX_DRAFT_RECORD_BYTES);
    const value = decode(file.bytes);
    if (!isDraftCheckpoint(value) || value.checkpointId !== checkpointId) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const checkpoint = freeze(value);
    const baseline = await folder.read('baseline.bin', MAX_SOURCE_BYTES);
    const sealed = await folder.read('complete.json', 1024); const seal = decode(sealed.bytes);
    if (!isDraftCheckpointSeal(seal) || seal.checkpointId !== checkpointId || seal.recordHash !== file.hash
      || baseline.hash !== checkpoint.baseHash || baseline.bytes.length !== checkpoint.baseSize) throw new Error('DRAFT_CHECKPOINT_INVALID');
    const source = createSourceIndex(baseline.bytes, { projectId: 'checkpoint', documentId: checkpointId, generation: 1 }, digest);
    rebuildCheckpoint(source, checkpoint, digest);
    await folder.verify(); await root.verify();
    return { checkpoint, baseline: baseline.bytes, recordHash: file.hash };
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
      const { checkpoint } = await load(checkpointId);
      return Object.freeze({ checkpointId, checkpoint, phase: 'complete', state: await classify(checkpoint, readTarget) });
    } catch (error) {
      const phase = (error as { code?: string }).code === 'ENOENT' ? 'incomplete' : 'invalid';
      return Object.freeze({ checkpointId, checkpoint: null, phase, state: phase });
    }
  };
  const inventory = async () => {
    const items = await root.entries(512); let used = 0;
    const entries: { name: string; type: 'draft' | 'save' | 'unknown' | 'lock' }[] = [];
    for (const item of items) {
      if (item.name === 'active.lock' && item.kind === 'file') { used += item.size; entries.push({ name: item.name, type: 'lock' }); continue; }
      if (item.kind !== 'directory' || !isTransactionId(item.name)) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
      const folder = await root.directory(item.name);
      const files = await folder.entries(7); const saved = files.some(file => file.name === 'intent.json');
      const type = saved ? 'save' : files.some(file => file.name === 'record.json') ? 'draft' : 'unknown';
      const allowed = saved ? ['intent.json', 'backup.bin', 'candidate.bin', 'prepared.json', 'cancelled.json', 'replacing.json', 'committed.json']
        : ['record.json', 'baseline.bin', 'complete.json'];
      for (const file of files) {
        if (file.kind !== 'file' || !allowed.includes(file.name)) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
        used += file.size;
      }
      entries.push({ name: item.name, type });
      if (used > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
    }
    return { entries, used };
  };
  return Object.freeze({ inspect,
    async scan() {
      const { entries } = await inventory(); const records = [];
      for (const item of entries) {
        if (item.type === 'lock' || item.type === 'save') continue;
        const result = await inspect(item.name); const checkpoint = result.checkpoint;
        // Listing retains metadata and counts, not every document's text/bytes.
        const summary = checkpoint ? Object.freeze({ checkpointId: checkpoint.checkpointId, sessionId: checkpoint.sessionId,
          draftRevision: checkpoint.draftRevision, createdAt: checkpoint.createdAt, targetKey: checkpoint.targetKey,
          name: checkpoint.name, baseHash: checkpoint.baseHash, resultHash: checkpoint.resultHash, changeCount: checkpoint.intents.length }) : null;
        records.push(Object.freeze({ checkpointId: item.name, phase: result.phase, summary }));
      }
      return Object.freeze({ records: Object.freeze(records), locked: entries.some(item => item.name === 'active.lock') });
    },
    async write(source: SaveSource, index: SourceIndex, candidate: PatchCandidate, sessionId: string, draftRevision: number): Promise<CheckpointWrite> {
      let checkpointId: string | null = null; let lock: OwnedLock | undefined; let sealing = false; let acquiringLock = false;
      let resultHash = ''; let persisted = false; let cleanupPending = false; let code: string | null = null;
      if (busy) return Object.freeze({ status: 'failed', checkpointId, draftRevision, resultHash, code: 'DRAFT_STORAGE_BUSY', cleanupPending });
      busy = true;
      try {
        // Freeze/validate synchronously before awaiting I/O. An external source
        // edit must not prevent retaining a draft of the originally opened bytes.
        const intents = captureTextIntents(index, candidate, digest); const baseline = source.bytes;
        if (source.baseHash !== index.baseHash || digest(baseline) !== index.baseHash) throw new Error('DRAFT_CHECKPOINT_MISMATCH');
        resultHash = candidate.resultHash;
        const id = randomUUID(); const record = freeze({ version: 1, checkpointId: id, sessionId, draftRevision, createdAt: Date.now(),
          targetKey: source.targetKey, name: source.name, identity: source.identity, baseHash: source.baseHash,
          baseSize: baseline.length, resultHash, intents });
        if (!isDraftCheckpoint(record)) throw new Error('DRAFT_CHECKPOINT_INVALID');
        const bytes = encode(record); if (bytes.length > MAX_DRAFT_RECORD_BYTES) throw new Error('DRAFT_STORAGE_LIMIT');
        acquiringLock = true;
        lock = await root.writeNew('active.lock', encode({ version: 1, checkpointId: id }), step => onStep(`lock-${step}`));
        acquiringLock = false;
        const { entries, used } = await inventory(); let count = 0; let existingId: string | null = null;
        for (const item of entries) {
          if (item.type === 'lock') continue;
          const folder = await root.directory(item.name);
          const prior = decode((await folder.read(item.type === 'save' ? 'intent.json' : 'record.json',
            item.type === 'save' ? 16 * 1024 : MAX_DRAFT_RECORD_BYTES)).bytes);
          if (item.type === 'save') {
            if (!isSaveIntent(prior) || prior.transactionId !== item.name) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
            if (prior.targetKey === source.targetKey) count++;
            continue;
          }
          if (!isDraftCheckpoint(prior) || prior.checkpointId !== item.name) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
          if (prior.targetKey === source.targetKey) count++;
          if (prior.sessionId === sessionId && prior.draftRevision > draftRevision) throw new Error('DRAFT_CHECKPOINT_STALE');
          if (prior.sessionId === sessionId && prior.draftRevision === draftRevision) {
            if (prior.targetKey !== record.targetKey || prior.baseHash !== record.baseHash || prior.resultHash !== record.resultHash
              || !sameStoredIdentity(prior.identity, record.identity)) throw new Error('DRAFT_CHECKPOINT_STALE');
            const existing = await inspect(item.name);
            if (existing.phase === 'complete') {
              const actual = existing.checkpoint!;
              if (actual.sessionId !== sessionId || actual.draftRevision !== draftRevision || actual.targetKey !== record.targetKey
                || actual.baseHash !== record.baseHash || actual.resultHash !== resultHash
                || !sameStoredIdentity(actual.identity, record.identity)) throw new Error('DRAFT_CHECKPOINT_STALE');
              existingId = item.name;
            }
          }
        }
        if (existingId) { await lock.verifyOwned(); checkpointId = existingId; persisted = true; }
        else {
          if (count >= 20 || used + baseline.length + bytes.length + 1024 > STORE_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
          const folder = await root.directory(id, true); checkpointId = id;
          await onStep('directory');
          const header = await folder.writeNew('record.json', bytes, step => onStep(`record-${step}`));
          await folder.writeNew('baseline.bin', baseline, step => onStep(`baseline-${step}`));
          if ((await folder.read('record.json', MAX_DRAFT_RECORD_BYTES)).hash !== header.hash
            || (await folder.read('baseline.bin', MAX_SOURCE_BYTES)).hash !== record.baseHash) throw new Error('DRAFT_CHECKPOINT_INVALID');
          await lock.verifyOwned();
          const seal: DraftCheckpointSeal = Object.freeze({ version: 1, checkpointId: id, recordHash: header.hash });
          sealing = true; await folder.writeNew('complete.json', encode(seal), step => onStep(`complete-${step}`));
          const observed = await load(id);
          if (observed.recordHash !== header.hash) throw new Error('DRAFT_CHECKPOINT_CHANGED');
          await folder.verify(); await lock.verifyOwned(); persisted = true;
        }
      } catch (error) { code = errorCode(error); }
      finally {
        if (lock) {
          try { await onStep('release-lock'); await lock.removeOwned(); }
          catch { cleanupPending = true; code = 'DRAFT_CLEANUP_PENDING'; }
        }
        else if (acquiringLock && code !== 'DRAFT_STORAGE_LOCKED') cleanupPending = true;
        busy = false;
      }
      return Object.freeze({ status: persisted ? 'persisted' : sealing ? 'unknown' : 'failed', checkpointId, draftRevision, resultHash, code, cleanupPending });
    },
    async restoreCandidate(checkpointId: string, source: SaveSource, index: SourceIndex): Promise<PatchCandidate> {
      const { checkpoint } = await load(checkpointId);
      const state = await classify(checkpoint, source.current);
      if (state === 'committed-matches') throw new Error('DRAFT_ALREADY_SAVED');
      if (state !== 'baseline-matches' || index.baseHash !== source.baseHash) throw new Error('DRAFT_RECOVERY_CONFLICT');
      await source.verify(); const candidate = rebuildCheckpoint(index, checkpoint, digest); await source.verify();
      return candidate;
    },
  });
}
