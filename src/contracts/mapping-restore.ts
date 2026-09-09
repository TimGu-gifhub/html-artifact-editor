import { isMappingIdentity } from './mapping.ts';
import type { MappingApplyOutcome, MappingIdentity } from './mapping.ts';
import { isTransactionId } from './save-record.ts';
import { MAX_SOURCE_BYTES } from './source-tree.ts';
import { MAX_DRAFT_INTENTS } from './draft-checkpoint.ts';

export const MAPPING_RESTORE = 'hae:mapping-restore';
export const MAPPING_RESTORE_RESULT = 'hae:mapping-restore-result';
export type MappingRestoreChange = Readonly<{ nodeId: string; expectedText: string; newText: string }>;
export type MappingRestore = Readonly<{
  identity: MappingIdentity; requestId: string; revision: number; changes: readonly MappingRestoreChange[];
}>;
export type MappingRestoreResult = Readonly<{
  identity: MappingIdentity; requestId: string; revision: number; nextRevision: number; outcome: MappingApplyOutcome;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const base = (value: Record<string, unknown>): boolean => isMappingIdentity(value.identity) && isTransactionId(value.requestId) && value.revision === 1;
export function isMappingRestore(value: unknown): value is MappingRestore {
  if (!object(value) || Object.keys(value).length !== 4 || !base(value) || !Array.isArray(value.changes)
    || value.changes.length < 1 || value.changes.length > MAX_DRAFT_INTENTS) return false;
  let oldSize = 0; let newSize = 0; const ids = new Set<string>();
  for (const change of value.changes) {
    if (!object(change) || Object.keys(change).length !== 3 || typeof change.nodeId !== 'string' || !/^n[0-9]{1,6}$/u.test(change.nodeId)
      || ids.has(change.nodeId) || typeof change.expectedText !== 'string' || typeof change.newText !== 'string'
      || change.expectedText === change.newText || change.newText.length > 64 * 1024 || /[\u0000\r\uD800-\uDFFF]/u.test(change.newText)) return false;
    oldSize += change.expectedText.length; newSize += change.newText.length;
    if (oldSize > MAX_SOURCE_BYTES || newSize > MAX_SOURCE_BYTES) return false;
    ids.add(change.nodeId);
  }
  return true;
}
export function isMappingRestoreResult(value: unknown): value is MappingRestoreResult {
  return object(value) && Object.keys(value).length === 5 && base(value)
    && Number.isSafeInteger(value.nextRevision) && (value.nextRevision as number) > 0
    && ['applied', 'rejected', 'unknown'].includes(value.outcome as string);
}
