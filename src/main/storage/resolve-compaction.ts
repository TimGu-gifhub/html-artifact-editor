import { COMPACTION_LIMIT, CHECKPOINT_FILES, isCheckpointCompaction } from '../../contracts/checkpoint-compaction.ts';
import type { CheckpointCompaction, ObsoleteCheckpoint } from '../../contracts/checkpoint-compaction.ts';
import { RESOLUTION_LIMIT, isCheckpointWriteLock, isCompactionResolution, resolutionName } from '../../contracts/compaction-resolution.ts';
import type { CompactionResolution, CompactionResolutionSeal, RemovalProof } from '../../contracts/compaction-resolution.ts';
import { sameStoredIdentity } from '../../contracts/save-record.ts';
import { checkedDirectory, digest, sameVersion } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { checkpointRemoval, removalIdentity } from '../../platform/checkpoint-removal.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import { createDraftCheckpointStore } from './checkpoints.ts';
import { readCompactionResolutions } from './compaction-resolutions.ts';
import { draftOwnership } from './draft-ownership.ts';

type Snapshot = Awaited<ReturnType<CheckedDirectory['read']>>;
type ResolutionResult = Readonly<{ status: 'resolved' | 'failed' | 'unknown'; code: string | null }>;
const text = (file: Snapshot): string => new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
const proof = (file: Snapshot): RemovalProof => Object.freeze({ size: file.bytes.length, hash: file.hash, identity: removalIdentity(file.stat) });
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const matches = (file: Snapshot, expected: RemovalProof): boolean => file.hash === expected.hash && file.bytes.length === expected.size
  && sameStoredIdentity(removalIdentity(file.stat), expected.identity);
const changed = (): never => { throw new Error('DRAFT_COMPACTION_RECOVERY_CHANGED'); };

// Only the Electron Main wrapper supplies verifyProfile. Unit storage tests use
// this lower-level port; they do not stand in for actual profile ownership.
export async function prepareCompactionResolution(path: string, source: SaveSource, verifyProfile: () => void,
  onStep: (step: string) => Promise<void> = async () => {}) {
  verifyProfile(); const root = await checkedDirectory(path);
  const release = draftOwnership(root.identityChain.map(value => `${value.dev}:${value.ino}`).join('/')).claimMaintenance();
  let cancelled = false; let commitment: Promise<ResolutionResult> | undefined;
  try {
    const store = await createDraftCheckpointStore(path);
    const names = async () => (await root.entries(512)).map(item => item.name);
    const initialNames = await names();
    const lock = await root.read('active.lock', 1024); const lockValue: unknown = JSON.parse(text(lock));
    if (!isCheckpointWriteLock(lockValue)) throw new Error('DRAFT_COMPACTION_RECOVERY_UNAVAILABLE');
    const receipts = await readCompactionResolutions(root, initialNames);
    const original = initialNames.includes('compaction.json') ? await root.read('compaction.json', COMPACTION_LIMIT) : null;
    let journal: CheckpointCompaction; let record: CompactionResolution;
    let receipt: Snapshot | null; let completed: Snapshot | null;
    if (original) {
      const value: unknown = JSON.parse(text(original));
      if (!isCheckpointCompaction(value)) throw new Error('DRAFT_COMPACTION_RECOVERY_UNAVAILABLE');
      journal = value;
      const previous = receipts.find(row => row.record.compactionId === journal.compactionId);
      record = previous?.record ?? Object.freeze({ version: 1, compactionId: journal.compactionId, createdAt: Date.now(),
        journalText: text(original), lockText: text(lock), journal: proof(original), lock: proof(lock) });
      if (!isCompactionResolution(record) || !matches(original, record.journal) || !matches(lock, record.lock)
        || record.journalText !== text(original) || record.lockText !== text(lock)) changed();
      receipt = previous?.file ?? null; completed = previous?.seal ?? null;
    } else {
      const previous = receipts.filter(row => matches(lock, row.record.lock));
      if (previous.length !== 1 || !previous[0]!.seal) throw new Error('DRAFT_COMPACTION_RECOVERY_UNAVAILABLE');
      record = previous[0]!.record; journal = JSON.parse(record.journalText) as CheckpointCompaction;
      receipt = previous[0]!.file; completed = previous[0]!.seal;
    }
    const receiptName = resolutionName(journal.compactionId); const completeName = resolutionName(journal.compactionId, true);
    let journalRemoved = !original;
    const checkFile = async (name: string, expected: RemovalProof): Promise<void> => {
      if (!matches(await root.read(name, expected.size), expected)) changed();
    };
    const verify = async (): Promise<void> => {
      if (cancelled) throw new Error('DRAFT_COMPACTION_RECOVERY_CANCELLED');
      verifyProfile(); await source.verify(); await root.verify(); await checkFile('active.lock', record.lock);
      const currentNames = await names();
      if (lockValue.checkpointId !== journal.retained[0]!.checkpointId && currentNames.includes(lockValue.checkpointId)) changed();
      if (journalRemoved) { if (currentNames.includes('compaction.json') || !completed) changed(); }
      else await checkFile('compaction.json', record.journal);
      if (receipt) {
        const actual = await root.read(receiptName, RESOLUTION_LIMIT);
        if (!sameVersion(actual.stat, receipt.stat) || actual.hash !== receipt.hash) changed();
      } else if (currentNames.includes(receiptName)) changed();
      if (completed) {
        const actual = await root.read(completeName, 1024);
        if (!sameVersion(actual.stat, completed.stat) || actual.hash !== completed.hash) changed();
      } else if (currentNames.includes(completeName)) changed();
      const catalog = await store.catalog(source.current);
      const allowed = new Set(['compaction.json', receiptName, ...journal.obsolete.map(item => item.checkpointId)]);
      if (catalog.unclassified.some(name => !allowed.has(name))) throw new Error('DRAFT_STORAGE_REVIEW_REQUIRED');
      const group = catalog.groups.find(row => row.sessionId === journal.sessionId);
      if (!group || !['dirty', 'clean'].includes(group.status) || group.draftRevision !== journal.retained[0]!.draftRevision
        || group.targetState !== 'baseline-matches' || !group.historyAvailable) changed();
      for (const keep of journal.retained) {
        const value = await store.inspect(keep.checkpointId); const point = value.checkpoint;
        if (value.phase !== 'complete' || value.recordHash !== keep.recordHash || point?.version !== 2
          || point.sessionId !== journal.sessionId || point.draftRevision !== keep.draftRevision
          || point.baseHash !== source.baseHash || point.targetKey !== source.targetKey || !sameStoredIdentity(point.identity, source.identity)) changed();
      }
      await source.verify(); verifyProfile();
    };
    const remaining = async (item: ObsoleteCheckpoint) => {
      if (!(await names()).includes(item.checkpointId)) return null;
      const folder = await root.directory(item.checkpointId); const identity = folder.identityChain.at(-1)!;
      if (identity.dev !== item.directory.dev || identity.ino !== item.directory.ino) changed();
      const entries = await folder.entries(5); const present = new Set(entries.map(entry => entry.name));
      const first = CHECKPOINT_FILES.findIndex(name => present.has(name));
      if (entries.some(entry => entry.kind !== 'file') || entries.length !== (first < 0 ? 0 : CHECKPOINT_FILES.length - first)
        || entries.some(entry => !CHECKPOINT_FILES.includes(entry.name as typeof CHECKPOINT_FILES[number]))) changed();
      const files = item.files.filter(file => present.has(file.name));
      for (const file of files) if (!matches(await folder.read(file.name, file.size), file)) changed();
      return files;
    };
    const absentObsolete = async (): Promise<void> => {
      const currentNames = await names(); if (journal.obsolete.some(item => currentNames.includes(item.checkpointId))) changed();
    };
    await verify();
    for (const item of journal.obsolete) { const files = await remaining(item); if (completed && files !== null) changed(); }
    const recordBytes = encode(record);
    if (recordBytes.length > RESOLUTION_LIMIT) throw new Error('DRAFT_STORAGE_LIMIT');
    const capacity = async (files: number, bytes: number): Promise<void> => {
      const entries = await root.entries(512); let used = 0;
      for (const item of entries) used += item.kind === 'file' ? item.size
        : (await (await root.directory(item.name)).entries(7)).reduce((sum, file) => sum + file.size, 0);
      if (entries.length + files > 512 || used + bytes > 200 * 1024 * 1024) throw new Error('DRAFT_STORAGE_LIMIT');
    };
    await onStep('recovery-prepared'); await verify();
    return Object.freeze({ status: 'prepared' as const,
      summary: Object.freeze({ name: source.name, sessionId: journal.sessionId, draftRevision: journal.retained[0]!.draftRevision,
        obsoleteCount: journal.obsolete.length }),
      cancel(): boolean { if (commitment) return false; cancelled = true; release(); return true; },
      commit(): Promise<ResolutionResult> {
        commitment ??= (async (): Promise<ResolutionResult> => {
          let started = false; let resolved = false;
          try {
            await verify();
            const before = async (label: string): Promise<void> => { await onStep(`recovery-before-${label}`); await verify(); };
            if (!receipt) {
              await before('record'); await capacity(2, recordBytes.length + 1024); started = true;
              await root.writeNew(receiptName, recordBytes, step => onStep(`recovery-record-${step}`));
              receipt = await root.read(receiptName, RESOLUTION_LIMIT);
              if (receipt.hash !== digest(recordBytes)) changed();
            }
            await verify(); await onStep('recovery-record-ready');
            const removal = checkpointRemoval(root);
            for (const item of journal.obsolete) {
              const files = await remaining(item);
              if (completed && files !== null) changed();
              if (files === null) continue;
              for (const file of files) {
                started = true;
                await removal.file(item.checkpointId, item.directory, file, () => before(file.name));
                await onStep(`recovery-after-${file.name}`);
              }
              started = true; await removal.empty(item.checkpointId, item.directory, () => before('directory'));
              await onStep('recovery-after-directory');
            }
            await verify(); await absentObsolete();
            if (!completed) {
              const seal: CompactionResolutionSeal = { version: 1, compactionId: journal.compactionId, resolutionHash: receipt.hash, phase: 'complete' };
              await before('complete'); await capacity(1, 1024); started = true;
              await root.writeNew(completeName, encode(seal), step => onStep(`recovery-complete-${step}`));
              completed = await root.read(completeName, 1024);
              if (completed.hash !== digest(encode(seal))) changed();
            }
            await onStep('recovery-complete-ready'); await verify(); await absentObsolete();
            if (!journalRemoved) {
              started = true;
              await removal.journal(record.journal, async () => { await before('journal'); await absentObsolete(); });
              journalRemoved = true; await onStep('recovery-after-journal');
            }
            started = true;
            await removal.recoveryLock(record.lock, async () => { await before('lock'); await absentObsolete(); });
            resolved = true; await onStep('recovery-after-lock');
            return Object.freeze({ status: 'resolved', code: null });
          } catch (error) {
            const message = error instanceof Error && /^DRAFT_[A-Z_]+$/u.test(error.message) ? error.message : 'DRAFT_COMPACTION_RECOVERY_FAILED';
            return Object.freeze({ status: resolved ? 'resolved' : started ? 'unknown' : 'failed',
              code: resolved ? 'DRAFT_COMPACTION_RECOVERY_CONFIRMED_WITH_WARNING' : message });
          } finally { release(); }
        })();
        return commitment;
      },
    });
  } catch (error) { release(); throw error; }
}
