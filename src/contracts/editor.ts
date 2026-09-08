import { isInputBegin, isInputChange, isInputResolution, isInputVersion } from './input.ts';
import type { InputBegin, InputChange, InputResolution, InputSnapshot, InputVersion } from './input.ts';

export const EDITOR_URL = 'editor://app/index.html';
export const EDITOR_CONNECT = 'hae:editor-connect';
export const EDITOR_COMMAND = 'hae:editor-command';
export const EDITOR_STATE = 'hae:editor-state';
export type EditorCommand = Readonly<{ kind: 'read' }>
  | Readonly<{ kind: 'begin'; value: InputBegin }>
  | Readonly<{ kind: 'change'; value: InputChange }>
  | Readonly<{ kind: 'apply'; value: InputVersion }>
  | Readonly<{ kind: 'resolve'; value: InputResolution }>
  | Readonly<{ kind: 'save-copy'; stateRevision: number }>;
export type EditorRequest = Readonly<{ sessionId: string; sequence: number; command: EditorCommand }>;
export type EditorCopyResult = NonNullable<InputSnapshot['lastCopy']> | Readonly<{ status: 'cancelled' }>;
export type EditorResult = Readonly<{ ok: boolean; code: string | null; state: InputSnapshot | null; copy: EditorCopyResult | null }>;
export type EditorConnection = Readonly<{ sessionId: string; state: InputSnapshot }>;
export type EditorReply = Readonly<{ sessionId: string; sequence: number; result: EditorResult }>;
export type EditorAPI = Readonly<{
  read: () => Promise<EditorResult>;
  begin: (value: InputBegin) => Promise<EditorResult>;
  change: (value: InputChange) => Promise<EditorResult>;
  apply: (value: InputVersion) => Promise<EditorResult>;
  resolve: (value: InputResolution) => Promise<EditorResult>;
  saveCopy: (stateRevision: number) => Promise<EditorResult>;
  onState: (listener: (state: InputSnapshot) => void) => () => void;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isEditorCommand(value: unknown): value is EditorCommand {
  if (!object(value)) return false;
  const count = Object.keys(value).length;
  if (value.kind === 'read') return count === 1;
  if (count !== 2) return false;
  switch (value.kind) {
    case 'begin': return isInputBegin(value.value);
    case 'change': return isInputChange(value.value);
    case 'apply': return isInputVersion(value.value);
    case 'resolve': return isInputResolution(value.value);
    case 'save-copy': return Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    default: return false;
  }
}
export function isEditorRequest(value: unknown): value is EditorRequest {
  return object(value) && Object.keys(value).length === 3 && typeof value.sessionId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.sessionId)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && isEditorCommand(value.command);
}
