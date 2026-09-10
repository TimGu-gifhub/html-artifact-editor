import { isEditorCommand } from './editor.ts';
import type { EditorCommand, EditorCopyResult } from './editor.ts';
import type { WorkspaceSnapshot } from './workspace.ts';
import type { WorkspaceRecoveryCatalog } from './recovery.ts';
import { isDiffReview } from './source-diff.ts';
import type { DiffReview, WorkspaceDiff } from './source-diff.ts';
import { isRestoreReference } from './save-record.ts';
import type { WorkspaceBackupCatalog } from './backup.ts';
import type { RestoreReference } from './save-record.ts';
import { isDesktopCommand } from './desktop.ts';
import type { DesktopCommand } from './desktop.ts';
import type { PreviewMode } from './preview.ts';

export const WORKSPACE_CONNECT = 'hae:workspace-connect';
export const WORKSPACE_COMMAND = 'hae:workspace-command';
export const WORKSPACE_STATE = 'hae:workspace-state';
export type DocumentCommand = Exclude<EditorCommand, Readonly<{ kind: 'read' }>>;
export type WorkspaceCommand = Readonly<{ kind: 'read' | 'recovery-list' }>
  | Readonly<{ kind: 'desktop'; value: DesktopCommand }>
  | Readonly<{ kind: 'open' | 'open-directory'; stateRevision: number }>
  | Readonly<{ kind: 'restore'; stateRevision: number; recoverySessionId: string; sourceMode: 'file' | 'directory' }>
  | Readonly<{ kind: 'switch-entry'; stateRevision: number; documentId: string }>
  | Readonly<{ kind: 'switch-mode'; stateRevision: number; documentId: string; mode: PreviewMode }>
  | Readonly<{ kind: 'save'; stateRevision: number; documentId: string; review?: DiffReview }>
  | Readonly<{ kind: 'backup-list'; documentId: string }>
  | Readonly<{ kind: 'backup-restore'; stateRevision: number; documentId: string; reference: RestoreReference }>
  | Readonly<{ kind: 'source-diff'; documentId: string; draftRevision: number; candidateHash: string }>
  | Readonly<{ kind: 'retry-persistence'; draftRevision: number; documentId: string }>
  | Readonly<{ kind: 'edit'; documentId: string; value: DocumentCommand }>;
export type WorkspaceRequest = Readonly<{ sessionId: string; sequence: number; command: WorkspaceCommand }>;
export type WorkspaceResult = Readonly<{
  ok: boolean; code: string | null; state: WorkspaceSnapshot | null;
  documentId: string | null; copy: EditorCopyResult | null; outcome: 'opened' | 'restored' | 'backup-restored' | 'cancelled' | 'saved' | 'unchanged' | 'rebase-required' | null;
  backups?: WorkspaceBackupCatalog | null;
  recovery?: WorkspaceRecoveryCatalog | null;
  diff?: WorkspaceDiff | null;
}>;
export type WorkspaceConnection = Readonly<{ sessionId: string; state: WorkspaceSnapshot }>;
export type WorkspaceReply = Readonly<{ sessionId: string; sequence: number; result: WorkspaceResult }>;
export type WorkspaceAPI = Readonly<{
  read: () => Promise<WorkspaceResult>;
  listRecovery: () => Promise<WorkspaceResult>;
  restore: (recoverySessionId: string, stateRevision: number, sourceMode?: 'file' | 'directory') => Promise<WorkspaceResult>;
  open: (stateRevision: number) => Promise<WorkspaceResult>;
  openDirectory: (stateRevision: number) => Promise<WorkspaceResult>;
  switchEntry: (documentId: string, stateRevision: number) => Promise<WorkspaceResult>;
  switchMode: (documentId: string, stateRevision: number, mode: PreviewMode) => Promise<WorkspaceResult>;
  readDiff: (documentId: string, draftRevision: number, candidateHash: string) => Promise<WorkspaceResult>;
  save: (documentId: string, stateRevision: number, review?: DiffReview) => Promise<WorkspaceResult>;
  listBackups: (documentId: string) => Promise<WorkspaceResult>;
  restoreBackup: (documentId: string, stateRevision: number, reference: RestoreReference) => Promise<WorkspaceResult>;
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
    case 'desktop': return count === 2 && isDesktopCommand(value.value);
    case 'read':
    case 'recovery-list': return count === 1;
    case 'restore': return count === 4 && identity(value.recoverySessionId)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0
      && (value.sourceMode === 'file' || value.sourceMode === 'directory');
    case 'open':
    case 'open-directory': return count === 2 && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'source-diff': return count === 4 && identity(value.documentId)
      && isDiffReview({ draftRevision: value.draftRevision, candidateHash: value.candidateHash });
    case 'save': return (count === 3 || (count === 4 && isDiffReview(value.review))) && identity(value.documentId)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'backup-list': return count === 2 && identity(value.documentId);
    case 'backup-restore': return count === 4 && identity(value.documentId) && isRestoreReference(value.reference)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'switch-entry': return count === 3 && identity(value.documentId)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0;
    case 'switch-mode': return count === 4 && identity(value.documentId)
      && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) > 0
      && (value.mode === 'proofread' || value.mode === 'interactive');
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
