import { isMappingCheck, isMappingIdentity } from './mapping.ts';
import type { MappingCheck, MappingIdentity } from './mapping.ts';

export const MAPPING_EDIT = 'hae:mapping-edit';
export const MAPPING_EDIT_RESULT = 'hae:mapping-edit-result';
export const MAPPING_EDIT_INTENT = 'hae:mapping-edit-intent';
export type EditDecision = 'stay' | 'release' | 'accept';
export type MappingEditRequest = MappingCheck & (
  | Readonly<{ kind: 'begin' }>
  | Readonly<{ kind: 'finish'; editToken: string; intentSequence: number | null; decision: EditDecision }>
);
export type MappingEditResult = MappingCheck & Readonly<{
  kind: 'begin' | 'finish'; accepted: boolean; editToken: string | null;
  nextRevision: number; nextNodeId: string | null;
}>;
export type MappingEditIntent = Readonly<{
  identity: MappingIdentity; editToken: string; sequence: number; nodeId: string | null;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const token = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const target = (value: unknown): boolean => value === null || (typeof value === 'string' && /^n[0-9]{1,6}$/u.test(value));
const check = (value: Record<string, unknown>): boolean => isMappingCheck({ identity: value.identity,
  requestId: value.requestId, nodeId: value.nodeId, revision: value.revision });
export function isMappingEditRequest(value: unknown): value is MappingEditRequest {
  if (!object(value) || !check(value)) return false;
  if (value.kind === 'begin') return Object.keys(value).length === 5;
  return value.kind === 'finish' && Object.keys(value).length === 8 && token(value.editToken)
    && (value.intentSequence === null || positive(value.intentSequence))
    && ['stay', 'release', 'accept'].includes(value.decision as string);
}
export function isMappingEditResult(value: unknown): value is MappingEditResult {
  return object(value) && Object.keys(value).length === 9 && check(value)
    && ['begin', 'finish'].includes(value.kind as string) && typeof value.accepted === 'boolean'
    && (value.editToken === null || token(value.editToken)) && positive(value.nextRevision) && target(value.nextNodeId);
}
export function isMappingEditIntent(value: unknown): value is MappingEditIntent {
  return object(value) && Object.keys(value).length === 4 && isMappingIdentity(value.identity)
    && token(value.editToken) && positive(value.sequence) && target(value.nodeId);
}
