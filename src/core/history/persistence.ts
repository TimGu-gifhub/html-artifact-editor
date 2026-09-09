import { isDraftCheckpoint } from '../../contracts/draft-checkpoint.ts';
import type { HistoryDraftCheckpoint, StoredTextIntent } from '../../contracts/draft-checkpoint.ts';
import type { HashBytes, SourceIdentity, SourceIndex } from '../parser/source-index.ts';
import { buildPatchCandidate } from '../patch/engine.ts';
import type { PatchCandidate } from '../patch/engine.ts';
import { createTextHistory } from './timeline.ts';
import type { HistoryCheckpoint } from './timeline.ts';

const intentsFor = (candidate: PatchCandidate): readonly StoredTextIntent[] => Object.freeze(candidate.patches.map(patch =>
  Object.freeze({ nodeId: patch.nodeId, expectedText: patch.expectedText, newText: patch.newText,
    rawSliceHash: patch.oldSliceHash, contextFingerprint: patch.contextFingerprint })));
const mismatch = (): never => { throw new Error('DRAFT_HISTORY_MISMATCH'); };

// v2 stores the full logical chain, including Redo and an independent savepoint.
// Neither its intents nor origin target names authorize a source position.
export function captureHistoryIntents(source: SourceIndex, candidate: PatchCandidate, checkpoint: HistoryCheckpoint,
  hash: HashBytes): readonly StoredTextIntent[] {
  const rebuilt = createTextHistory(source.bytes, source.identity, hash, checkpoint).candidate;
  const verified = buildPatchCandidate(source, candidate.patches, hash);
  if (candidate.baseHash !== source.baseHash || candidate.identity.projectId !== source.identity.projectId
    || candidate.identity.documentId !== source.identity.documentId || candidate.identity.generation !== source.identity.generation
    || candidate.resultHash !== rebuilt.resultHash || verified.resultHash !== rebuilt.resultHash
    || hash(candidate.bytes) !== rebuilt.resultHash || JSON.stringify(intentsFor(verified)) !== JSON.stringify(intentsFor(rebuilt))) return mismatch();
  return intentsFor(rebuilt);
}

export function rebuildHistoryCheckpoint(bytes: Uint8Array, identity: SourceIdentity, record: HistoryDraftCheckpoint,
  originBytes: Uint8Array, hash: HashBytes) {
  if (!isDraftCheckpoint(record) || record.version !== 2) return mismatch();
  const history = createTextHistory(bytes, identity, hash, { originBytes, record: record.history });
  if (JSON.stringify(intentsFor(history.candidate)) !== JSON.stringify(record.intents)) return mismatch();
  return history;
}
