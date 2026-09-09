import { MAX_SOURCE_BYTES } from './source-tree.ts';
import { isContentHash } from './save-record.ts';

export const MAX_HISTORY_STEPS = 1000;
export const MAX_HISTORY_TEXT_BYTES = 8 * 1024 * 1024;
export type HistoryOperation = Readonly<{ target: string; before: string; after: string }>;
export type HistoryRecord = Readonly<{
  version: 1; originHash: string; originSize: number; baseHash: string; baseSize: number; candidateHash: string;
  revision: number; cursor: number; operations: readonly HistoryOperation[];
  savedValues: readonly Readonly<{ nodeId: string; text: string }>[];
}>;
const keys = (value: unknown, names: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const count = (value: unknown, max: number): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const target = (value: unknown): boolean => typeof value === 'string' && /^n(?:0|[1-9][0-9]{0,4})$/u.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 * 1024 && !/[\u0000\r\uD800-\uDFFF]/u.test(value);
// Structural/quota preflight only. Core must still verify the original bytes,
// complete source proof, every operation's logical chain and the candidate hash.
export function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!keys(value, ['version', 'originHash', 'originSize', 'baseHash', 'baseSize', 'candidateHash', 'revision', 'cursor', 'operations', 'savedValues'])
    || value.version !== 1 || !isContentHash(value.originHash) || !isContentHash(value.baseHash) || !isContentHash(value.candidateHash)
    || !count(value.originSize, MAX_SOURCE_BYTES) || !count(value.baseSize, MAX_SOURCE_BYTES)
    || !Array.isArray(value.operations) || value.operations.length > MAX_HISTORY_STEPS || !count(value.cursor, value.operations.length)
    || !count(value.revision, Number.MAX_SAFE_INTEGER - 1) || (value.revision as number) <= value.operations.length
    || !Array.isArray(value.savedValues) || value.savedValues.length > MAX_HISTORY_STEPS) return false;
  let units = 0; const targets = new Set<string>(); const saved = new Set<string>();
  for (const operation of value.operations) {
    if (!keys(operation, ['target', 'before', 'after']) || !target(operation.target) || !text(operation.before)
      || !text(operation.after) || operation.before === operation.after) return false;
    units += operation.before.length + operation.after.length; targets.add(operation.target as string);
  }
  for (const entry of value.savedValues) {
    if (!keys(entry, ['nodeId', 'text']) || !target(entry.nodeId) || !text(entry.text) || saved.has(entry.nodeId as string)) return false;
    saved.add(entry.nodeId as string); targets.add(entry.nodeId as string); units += entry.text.length;
  }
  return units <= MAX_HISTORY_TEXT_BYTES && targets.size <= MAX_HISTORY_STEPS;
}

export function freezeHistoryRecord(record: HistoryRecord): HistoryRecord {
  return Object.freeze({ ...record, operations: Object.freeze(record.operations.map(operation => Object.freeze({ ...operation }))),
    savedValues: Object.freeze(record.savedValues.map(value => Object.freeze({ ...value }))) });
}
