import { isEditorCommand } from './editor.ts';
import type { EditorCommand, EditorCopyResult } from './editor.ts';
import type { WorkspaceSnapshot } from './workspace.ts';

export const WORKSPACE_CONNECT = 'hae:workspace-connect';
export const WORKSPACE_COMMAND = 'hae:workspace-command';
export const WORKSPACE_STATE = 'hae:workspace-state';
export type DocumentCommand = Exclude<EditorCommand, Readonly<{ kind: 'read' }>>;
export type WorkspaceCommand = Readonly<{ kind: 'read' }>
  | Readonly<{ kind: 'open' | 'open-directory'; stateRevision: number }>
  | Readonly<{ kind: 'switch-entry' | 'save'; stateRevision: number; documentId: string }>
  | Readonly<{ kind: 'retry-persistence'; draftRevision: number; documentId: string }>
  | Readonly<{ kind: 'edit'; documentId: string; value: DocumentCommand }>;
export type WorkspaceRequest = Readonly<{ sessionId: string; sequence: number; command: WorkspaceCommand }>;
export type WorkspaceResult = Readonly<{
  ok: boolean; code: string | null; state: WorkspaceSnapshot | null;
  documentId: string | null; copy: EditorCopyResult | null; outcome: 'opened' | 'cancelled' | 'saved' | 'unchanged' | 'rebase-required' | null;
}>;
export type WorkspaceConnection = Readonly<{ sessionId: string; state: WorkspaceSnapshot }>;
export type WorkspaceReply = Readonly<{ sessionId: string; sequence: number; result: WorkspaceResult }>;
export type WorkspaceAPI = Readonly<{
  read: () => Promise<WorkspaceResult>;
  open: (stateRevision: number) => Promise<WorkspaceResult>;
  openDirectory: (stateRevision: number) => Promise<WorkspaceResult>;
  switchEntry: (documentId: string, stateRevision: number) => Promise<WorkspaceResult>;
  save: (documentId: string, stateRevision: number) => Promise<WorkspaceResult>;
  retryPersistence: (documentId: string, draftRevision: number) => Promise<WorkspaceResult>;
  edit: (documentId: string, value: DocumentCommand) => Promise<WorkspaceResult>;
  onState: (listener: (state: WorkspaceSnapshot) => void) => () => void;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export function isWorkspaceCommand(value: unknown): value is WorkspaceCommand {
  if (!object(value)) return false;
  const count = Object.keys(value).length;
  switch (value.kind) {
    case 'read': return count === 1;
    case 'open':
    case 'open-directory': return count === 2 && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'save':
    case 'switch-entry': return count === 3 && identity(value.documentId)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'retry-persistence': return count === 3 && identity(value.documentId)
      && Number.isSafeInteger(value.draftRevision) && (value.draftRevision as number) > 0;
    case 'edit': return count === 3 && identity(value.documentId) && isEditorCommand(value.value) && value.value.kind !== 'read';
    default: return false;
  }
}
export function isWorkspaceRequest(value: unknown): value is WorkspaceRequest {
  return object(value) && Object.keys(value).length === 3 && identity(value.sessionId)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && isWorkspaceCommand(value.command);
}
