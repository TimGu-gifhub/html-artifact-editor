import { MAX_SOURCE_BYTES } from './source-tree.ts';
import { MAX_DRAFT_INTENTS } from './draft-checkpoint.ts';

// UTF-8 source slices for display only. No command accepts these byte ranges as
// write authority; the editor must render text literally, never as HTML.
export type SourceSlice = Readonly<{ startByte: number; endByte: number; text: string }>;
export type SourceDiff = Readonly<{
  baseHash: string; candidateHash: string; baseSize: number; candidateSize: number; unchangedBytes: number;
  changes: readonly Readonly<{
    nodeId: string; before: SourceSlice; after: SourceSlice;
    lineEnding: 'lf' | 'crlf' | 'cr'; mixedLineEndings: boolean; leadingLfCompensation: boolean;
  }>[];
}>;
export type DiffReview = Readonly<{ draftRevision: number; candidateHash: string }>;
export type WorkspaceDiff = SourceDiff & DiffReview & Readonly<{ documentId: string }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SOURCE_BYTES;
export function isDiffReview(value: unknown): value is DiffReview {
  return object(value) && Object.keys(value).length === 2 && Number.isSafeInteger(value.draftRevision)
    && (value.draftRevision as number) > 0 && hex(value.candidateHash);
}
const byteLength = (text: string): number => {
  let size = 0;
  for (const character of text) { const scalar = character.codePointAt(0)!; size += scalar < 0x80 ? 1 : scalar < 0x800 ? 2 : scalar < 0x10000 ? 3 : 4; }
  return size;
};
const slice = (value: unknown): value is SourceSlice => object(value) && Object.keys(value).length === 3
  && count(value.startByte) && count(value.endByte) && value.endByte >= value.startByte
  && typeof value.text === 'string' && value.text.length <= MAX_SOURCE_BYTES
  && !/[\uD800-\uDFFF]/u.test(value.text) && byteLength(value.text) === value.endByte - value.startByte;
export function isSourceDiff(value: unknown): value is SourceDiff {
  if (!object(value) || Object.keys(value).length !== 6 || !hex(value.baseHash) || !hex(value.candidateHash)
    || !count(value.baseSize) || !count(value.candidateSize) || !count(value.unchangedBytes)
    || !Array.isArray(value.changes) || value.changes.length > MAX_DRAFT_INTENTS
    || (!value.changes.length && value.baseHash !== value.candidateHash)) return false;
  let oldEnd = 0; let newEnd = 0; let unchanged = 0; const ids = new Set<string>();
  for (const change of value.changes) {
    if (!object(change) || Object.keys(change).length !== 6 || typeof change.nodeId !== 'string' || !/^n[0-9]{1,6}$/u.test(change.nodeId)
      || ids.has(change.nodeId) || !slice(change.before) || !slice(change.after) || change.before.startByte === change.before.endByte
      || change.before.text === change.after.text || change.before.startByte < oldEnd || change.after.startByte !== newEnd + change.before.startByte - oldEnd
      || change.before.endByte > value.baseSize || change.after.endByte > value.candidateSize
      || !['lf', 'crlf', 'cr'].includes(change.lineEnding as string) || typeof change.mixedLineEndings !== 'boolean'
      || typeof change.leadingLfCompensation !== 'boolean') return false;
    unchanged += change.before.startByte - oldEnd; oldEnd = change.before.endByte; newEnd = change.after.endByte; ids.add(change.nodeId);
  }
  return value.baseSize - oldEnd === value.candidateSize - newEnd && unchanged + value.baseSize - oldEnd === value.unchangedBytes;
}
