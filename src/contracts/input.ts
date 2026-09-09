import { isMappingSelection } from './mapping.ts';
import type { MappingSelection } from './mapping.ts';

export type InputBegin = Readonly<{ selection: MappingSelection; draftRevision: number }>;
export type InputVersion = Readonly<{ editToken: string; inputRevision: number }>;
export type InputChange = InputVersion & Readonly<{ newText: string; composing: boolean }>;
export type InputResolution = InputVersion & Readonly<{ decision: 'stay' | 'discard' | 'apply'; intentSequence: number | null }>;
export type InputHistory = Readonly<{ stateRevision: number; draftRevision: number; direction: 'undo' | 'redo' }>;
export type ActiveInput = Readonly<{
  editToken: string; nodeId: string; revision: number; text: string; appliedText: string; composing: boolean;
}>;
export type InputPhase = 'idle' | 'beginning' | 'applying' | 'resolving' | 'history' | 'saving' | 'leaving' | 'closed';
export type InputSnapshot = Readonly<{
  stateRevision: number; phase: InputPhase; mappingStatus: 'binding' | 'ready' | 'invalidated' | 'closed'; mappingReason: string | null;
  selection: Readonly<{ reference: MappingSelection; text: string }> | null;
  input: ActiveInput | null; hasUnappliedInput: boolean;
  intent: Readonly<{ sequence: number; nodeId: string | null; text: string | null }> | null;
  draftRevision: number; draftPhase: 'idle' | 'preparing' | 'applying' | 'saving' | 'uncertain' | 'closed'; candidateHash: string;
  changes: readonly Readonly<{ nodeId: string; oldText: string; newText: string }>[];
  lastCopy: Readonly<{ status: 'created' | 'failed' | 'unknown'; name: string; expectedHash: string; code: string | null }> | null;
  canApply: boolean; canSaveCopy: boolean;
  history: Readonly<{ undoCount: number; redoCount: number; canUndo: boolean; canRedo: boolean }> | null;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const version = (value: Record<string, unknown>): boolean => typeof value.editToken === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.editToken) && positive(value.inputRevision);
export function isInputBegin(value: unknown): value is InputBegin {
  return object(value) && Object.keys(value).length === 2 && isMappingSelection(value.selection) && positive(value.draftRevision);
}
export function isInputVersion(value: unknown): value is InputVersion {
  return object(value) && Object.keys(value).length === 2 && version(value);
}
export function isInputChange(value: unknown): value is InputChange {
  return object(value) && Object.keys(value).length === 4 && version(value)
    && typeof value.newText === 'string' && value.newText.length <= 128 * 1024 && typeof value.composing === 'boolean';
}
export function isInputResolution(value: unknown): value is InputResolution {
  return object(value) && Object.keys(value).length === 4 && version(value)
    && ['stay', 'discard', 'apply'].includes(value.decision as string)
    && (value.intentSequence === null || positive(value.intentSequence));
}
export function isInputHistory(value: unknown): value is InputHistory {
  return object(value) && Object.keys(value).length === 3 && positive(value.stateRevision) && positive(value.draftRevision)
    && (value.direction === 'undo' || value.direction === 'redo');
}
