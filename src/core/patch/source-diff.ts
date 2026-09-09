import type { SourceDiff } from '../../contracts/source-diff.ts';
import type { HashBytes, SourceIndex } from '../parser/source-index.ts';
import { buildPatchCandidate } from './engine.ts';
import type { PatchCandidate } from './engine.ts';
import { decodeUtf8 } from '../parser/utf8.ts';

// Compile only to validate the supplied frozen candidate. Display slices come
// from its actual bytes, never from decoded Text or another encoding pass.
export function buildSourceDiff(source: SourceIndex, candidate: PatchCandidate, hash: HashBytes): SourceDiff {
  const original = source.bytes; const bytes = candidate.bytes;
  const verified = buildPatchCandidate(source, candidate.patches, hash);
  if (candidate.baseHash !== source.baseHash || candidate.resultHash !== verified.resultHash || hash(bytes) !== verified.resultHash
    || candidate.identity.projectId !== source.identity.projectId || candidate.identity.documentId !== source.identity.documentId
    || candidate.identity.generation !== source.identity.generation) throw new Error('SOURCE_DIFF_MISMATCH');
  // Preserve an actual U+FEFF at the start of a Text slice; stripping
  // it here would conceal source bytes even though it is not the file BOM.
  const decode = (value: Uint8Array): string => { const decoded = decodeUtf8(value); return (decoded.hasBom ? '\ufeff' : '') + decoded.text; };
  const changes: SourceDiff['changes'][number][] = [];
  let oldEnd = 0; let newEnd = 0; let unchangedBytes = 0;
  for (const patch of verified.patches) {
    const gap = patch.startByte - oldEnd; const startByte = newEnd + gap;
    const endByte = startByte + patch.replacementBytes.length;
    changes.push(Object.freeze({ nodeId: patch.nodeId,
      before: Object.freeze({ startByte: patch.startByte, endByte: patch.endByte, text: decode(original.subarray(patch.startByte, patch.endByte)) }),
      after: Object.freeze({ startByte, endByte, text: decode(bytes.subarray(startByte, endByte)) }),
      lineEnding: patch.lineEnding === '\r\n' ? 'crlf' : patch.lineEnding === '\r' ? 'cr' : 'lf',
      mixedLineEndings: patch.mixedLineEndings, leadingLfCompensation: patch.leadingLfCompensation,
    }));
    unchangedBytes += gap; oldEnd = patch.endByte; newEnd = endByte;
  }
  return Object.freeze({ baseHash: source.baseHash, candidateHash: candidate.resultHash,
    baseSize: original.length, candidateSize: bytes.length, unchangedBytes: unchangedBytes + original.length - oldEnd,
    changes: Object.freeze(changes) });
}
