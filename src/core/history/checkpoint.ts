import { isDraftCheckpoint } from '../../contracts/draft-checkpoint.ts';
import type { DraftCheckpoint, StoredTextIntent } from '../../contracts/draft-checkpoint.ts';
import { buildPatchCandidate, buildTextIntentCandidate } from '../patch/engine.ts';
import type { PatchCandidate } from '../patch/engine.ts';
import type { HashBytes, SourceIndex } from '../parser/source-index.ts';

export function captureTextIntents(source: SourceIndex, candidate: PatchCandidate, hash: HashBytes): readonly StoredTextIntent[] {
  // v1 cannot retain the origin proof or the operation/Redo branch. Refuse it
  // before storage can claim durability for an incomplete history checkpoint.
  if (source.lineage !== undefined) throw new Error('DRAFT_HISTORY_UNSUPPORTED');
  const verified = buildPatchCandidate(source, candidate.patches, hash);
  if (candidate.baseHash !== source.baseHash || candidate.resultHash !== verified.resultHash || hash(candidate.bytes) !== verified.resultHash
    || candidate.identity.projectId !== source.identity.projectId || candidate.identity.documentId !== source.identity.documentId
    || candidate.identity.generation !== source.identity.generation) throw new Error('DRAFT_CHECKPOINT_MISMATCH');
  return Object.freeze(verified.patches.map(patch => Object.freeze({ nodeId: patch.nodeId, expectedText: patch.expectedText,
    newText: patch.newText, rawSliceHash: patch.oldSliceHash, contextFingerprint: patch.contextFingerprint })));
}

export function rebuildCheckpoint(source: SourceIndex, checkpoint: DraftCheckpoint, hash: HashBytes): PatchCandidate {
  if (source.lineage !== undefined) throw new Error('DRAFT_HISTORY_UNSUPPORTED');
  if (!isDraftCheckpoint(checkpoint) || checkpoint.baseHash !== source.baseHash || checkpoint.baseSize !== source.bytes.length) throw new Error('DRAFT_CHECKPOINT_MISMATCH');
  const candidate = buildTextIntentCandidate(source, checkpoint.intents, hash);
  if (candidate.resultHash !== checkpoint.resultHash) throw new Error('DRAFT_CHECKPOINT_MISMATCH');
  return candidate;
}
