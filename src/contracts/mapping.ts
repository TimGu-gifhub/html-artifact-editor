import { isPreviewIdentity } from './preview.ts';
import type { PreviewIdentity } from './preview.ts';
import type { SourceTree } from './source-tree.ts';

export const MAPPING_INSTALL = 'hae:mapping-install';
export const MAPPING_REVOKE = 'hae:mapping-revoke';
export const MAPPING_EVENT = 'hae:mapping-event';
export const MAPPING_CHECK = 'hae:mapping-check';
export const MAPPING_CHECK_RESULT = 'hae:mapping-check-result';
export type MappingIdentity = Readonly<{ preview: PreviewIdentity; documentId: string; baseHash: string }>;
export type MappingInstall = Readonly<{ identity: MappingIdentity; tree: SourceTree }>;
export type MappingEvent = Readonly<{ identity: MappingIdentity; revision: number }> & (
  | Readonly<{ kind: 'ready'; editableCount: number }>
  | Readonly<{ kind: 'invalidated'; reason: MappingFailure }>
  | Readonly<{ kind: 'selection'; nodeId: string | null }>
);
export type MappingFailure = 'TREE_MISMATCH' | 'DOM_MUTATED' | 'UNSUPPORTED_DOM' | 'CLOSED';
export type MappingSelection = Readonly<{ identity: MappingIdentity; revision: number; nodeId: string }>;
export type MappingCheck = MappingSelection & Readonly<{ requestId: string }>;
export type MappingCheckResult = MappingCheck & Readonly<{ valid: boolean }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const nodeId = (value: unknown): value is string => typeof value === 'string' && /^n[0-9]{1,6}$/.test(value);
const revision = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;

export function isMappingIdentity(value: unknown): value is MappingIdentity {
  return object(value) && Object.keys(value).length === 3 && isPreviewIdentity(value.preview)
    && value.preview.mode === 'proofread' && uuid(value.documentId)
    && typeof value.baseHash === 'string' && /^[a-f0-9]{64}$/.test(value.baseHash);
}
export function sameMapping(a: MappingIdentity, b: MappingIdentity): boolean {
  return a.documentId === b.documentId && a.baseHash === b.baseHash
    && a.preview.sessionId === b.preview.sessionId && a.preview.generation === b.preview.generation
    && a.preview.mode === b.preview.mode && a.preview.version === b.preview.version;
}
export function isMappingEvent(value: unknown): value is MappingEvent {
  if (!object(value) || !isMappingIdentity(value.identity) || !revision(value.revision) || Object.keys(value).length !== 4) return false;
  if (value.kind === 'ready') return Number.isSafeInteger(value.editableCount) && (value.editableCount as number) >= 0 && (value.editableCount as number) <= 100_000;
  if (value.kind === 'selection') return value.nodeId === null || nodeId(value.nodeId);
  return value.kind === 'invalidated' && ['TREE_MISMATCH', 'DOM_MUTATED', 'UNSUPPORTED_DOM', 'CLOSED'].includes(value.reason as string);
}
export function isMappingCheck(value: unknown): value is MappingCheck {
  return object(value) && Object.keys(value).length === 4 && isMappingIdentity(value.identity)
    && revision(value.revision) && nodeId(value.nodeId) && uuid(value.requestId);
}
export function isMappingCheckResult(value: unknown): value is MappingCheckResult {
  return object(value) && Object.keys(value).length === 5 && typeof value.valid === 'boolean'
    && isMappingCheck({ identity: value.identity, revision: value.revision, nodeId: value.nodeId, requestId: value.requestId });
}
