import { randomUUID } from 'node:crypto';
import { CHECKPOINT_FILES, COMPACTION_LIMIT, isCheckpointCompaction } from '../../contracts/checkpoint-compaction.ts';
import type { CheckpointAnchor, CheckpointCompaction, ObsoleteCheckpoint } from '../../contracts/checkpoint-compaction.ts';
import type { DraftCheckpoint } from '../../contracts/draft-checkpoint.ts';
import { MAX_DRAFT_RECORD_BYTES } from '../../contracts/draft-checkpoint.ts';
import { sameStoredIdentity } from '../../contracts/save-record.ts';
import { checkpointRemoval, removalIdentity } from '../../platform/checkpoint-removal.ts';
import { digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { readDraftRetirement } from './draft-records.ts';

type Evidence = Readonly<{ checkpoint: DraftCheckpoint; recordHash: string }>;
type CompactionResult = Readonly<{ status: 'unchanged' | 'compacted' | 'failed' | 'unknown'; code: string | null;
  removed: number; retainLock: boolean }>;
const anchor = (value: Evidence): CheckpointAnchor => Object.freeze({ checkpointId: value.checkpoint.checkpointId,
  draftRevision: value.checkpoint.draftRevision, recordHash: value.recordHash });

// Called only by the owning v2 checkpoint writer under its existing global lock.
// Every retained point is independently replayable; the journal preserves exact
// deletion intent if interruption leaves an obsolete directory only half removed.
export async function compactCheckpoints(root: CheckedDirectory, points: readonly Evidence[], load: (id: string) => Promise<Evidence>,
  verifyLock: () => Promise<void>, onStep: (step: string) => Promise<void>, availableBytes: number): Promise<CompactionResult> {
  let journaling = false; let removing = false; let removed = 0;
  try {
    const sorted = [...points].sort((a, b) => b.checkpoint.draftRevision - a.checkpoint.draftRevision);
    const first = sorted[0]; const second = sorted.find(row => row.checkpoint.draftRevision < (first?.checkpoint.draftRevision ?? 0));
    const obsolete = sorted.filter(row => row.checkpoint.draftRevision < (second?.checkpoint.draftRevision ?? 0));
    if (!first || !second || !obsolete.length) return Object.freeze({ status: 'unchanged', code: null, removed, retainLock: false });
    const retained = [first, second].map(anchor); const sessionId = first.checkpoint.sessionId;
    const sameBinding = (record: DraftCheckpoint): boolean => record.version === 2 && record.sessionId === sessionId
      && record.targetKey === first.checkpoint.targetKey && record.baseHash === first.checkpoint.baseHash
      && sameStoredIdentity(record.identity, first.checkpoint.identity);
    const verifyPoint = async (expected: CheckpointAnchor): Promise<void> => {
      const value = await load(expected.checkpointId); const folder = await root.directory(expected.checkpointId);
      if (!sameBinding(value.checkpoint) || value.recordHash !== expected.recordHash || value.checkpoint.draftRevision !== expected.draftRevision
        || await readDraftRetirement({ folder, checkpoint: value.checkpoint, hash: value.recordHash })) throw new Error('DRAFT_COMPACTION_CHANGED');
    };
    const protect = async (): Promise<void> => { await verifyLock(); for (const keep of retained) await verifyPoint(keep); };
    await protect(); const discarded: ObsoleteCheckpoint[] = [];
    for (const value of obsolete) {
      const expected = anchor(value); await verifyPoint(expected);
      const folder = await root.directory(expected.checkpointId); const names = await folder.entries(5);
      if (names.length !== 4 || names.some(file => file.kind !== 'file' || !CHECKPOINT_FILES.includes(file.name as typeof CHECKPOINT_FILES[number]))) throw new Error('DRAFT_COMPACTION_CHANGED');
      const files = [];
      for (const name of CHECKPOINT_FILES) {
        const file = await folder.read(name, MAX_DRAFT_RECORD_BYTES);
        files.push(Object.freeze({ name, hash: file.hash, size: file.bytes.length, identity: removalIdentity(file.stat) }));
      }
      await verifyPoint(expected);
      discarded.push(Object.freeze({ ...expected, directory: folder.identityChain.at(-1)!, files: Object.freeze(files) }));
    }
    const journal: CheckpointCompaction = Object.freeze({ version: 1, compactionId: randomUUID(), sessionId, createdAt: Date.now(),
      retained: Object.freeze(retained), obsolete: Object.freeze(discarded) });
    const bytes = new TextEncoder().encode(`${JSON.stringify(journal)}\n`);
    if (!isCheckpointCompaction(journal) || bytes.length > COMPACTION_LIMIT || !Number.isSafeInteger(availableBytes)
      || bytes.length > availableBytes) throw new Error('DRAFT_COMPACTION_INVALID');
    await protect(); journaling = true;
    const written = await root.writeNew('compaction.json', bytes, step => onStep(`compaction-${step}`));
    const proof = { hash: written.hash, size: bytes.length, identity: written.identity };
    const verifyJournal = async (): Promise<void> => {
      await written.verifyOwned(); const actual = await root.read('compaction.json', COMPACTION_LIMIT);
      if (actual.hash !== digest(bytes) || !isCheckpointCompaction(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(actual.bytes)))) throw new Error('DRAFT_COMPACTION_CHANGED');
    };
    await verifyJournal(); await onStep('compaction-ready');
    const removal = checkpointRemoval(root);
    const beforeRemoval = async (label: string): Promise<void> => {
      await onStep(`compaction-before-${label}`); await protect(); await verifyJournal();
    };
    for (const item of discarded) {
      await verifyPoint(item); removing = true;
      for (const file of item.files) {
        await removal.file(item.checkpointId, item.directory, file, () => beforeRemoval(file.name));
        await onStep(`compaction-after-${file.name}`);
      }
      await removal.empty(item.checkpointId, item.directory, () => beforeRemoval('directory'));
      removed++; await onStep('compaction-after-directory');
    }
    await protect(); await verifyJournal();
    await removal.journal(proof, async () => { await onStep('compaction-before-journal'); await protect(); await verifyJournal(); });
    await onStep('compaction-finished');
    return Object.freeze({ status: 'compacted', code: null, removed, retainLock: false });
  } catch {
    return Object.freeze({ status: journaling || removing ? 'unknown' : 'failed', code: journaling || removing
      ? 'DRAFT_COMPACTION_UNKNOWN' : 'DRAFT_COMPACTION_FAILED', removed, retainLock: journaling || removing });
  }
}
