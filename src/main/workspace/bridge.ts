import type { WebContents } from 'electron';
import { app } from 'electron';
import { WORKSPACE_COMMAND, WORKSPACE_CONNECT, WORKSPACE_STATE, isWorkspaceRequest } from '../../contracts/workspace-editor.ts';
import type { WorkspaceResult } from '../../contracts/workspace-editor.ts';
import { executeEditorCommand } from '../editor/commands.ts';
import { createEditorTransport } from '../editor/transport.ts';
import type { Workspace } from './controller.ts';
import { chooseProjectDirectory, chooseProjectEntry } from './project-choice.ts';
import type { ProjectChoices } from './project-choice.ts';

const publicErrors = new Set(['WORKSPACE_BUSY', 'STALE_WORKSPACE', 'DOCUMENT_BUSY', 'INPUT_COMPOSING',
  'DOCUMENT_RECOVERY_REQUIRED', 'DOCUMENT_CLEANUP_REQUIRED', 'STALE_DOCUMENT_REVIEW', 'WORKSPACE_CANCELLED',
  'DOCUMENT_ACTIVATION_FAILED', 'DOCUMENT_ACTIVATION_UNKNOWN', 'STALE_DOCUMENT',
  'SAVE_PLATFORM_UNSUPPORTED', 'UNAPPLIED_INPUT',
  'DRAFT_PERSISTENCE_UNAVAILABLE', 'DRAFT_PERSISTENCE_RETRY_UNAVAILABLE', 'STALE_DRAFT_REQUEST',
  'DRAFT_PERSISTENCE_REQUIRED', 'DRAFT_RETIREMENT_FAILED', 'DRAFT_RETIREMENT_UNKNOWN',
  'DRAFT_PROFILE_IN_USE', 'DRAFT_SESSION_ACTIVE', 'DRAFT_RECOVERY_UNAVAILABLE', 'DRAFT_RECOVERY_CONFLICT',
  'DRAFT_STORAGE_LOCKED', 'DRAFT_STORAGE_REVIEW_REQUIRED', 'DRAFT_CHECKPOINT_CHANGED', 'DRAFT_CHECKPOINT_INVALID',
  'DRAFT_SAVED_HISTORY_SUPERSEDED', 'DRAFT_SAVED_HISTORY_UNCONFIRMED',
  'DRAFT_RESTORE_UNAVAILABLE', 'DRAFT_RESTORE_REJECTED', 'DRAFT_RESTORE_OUTCOME_UNKNOWN',
  'STALE_SOURCE_DIFF', 'SOURCE_DIFF_CANCELLED', 'SOURCE_DIFF_FAILED', 'SOURCE_DIFF_TIMEOUT', 'SOURCE_DIFF_STOP_FAILED', 'DRAFT_UNAVAILABLE',
  'RESOURCE_BLOCKED',
  'COPY_FAILED', 'COPY_OUTCOME_UNKNOWN', 'INPUT_MAPPING_LOST', 'INVALID_TEXT_NUL', 'INVALID_UNICODE', 'TEXT_SIZE_LIMIT']);

export function createWorkspaceBridge(contents: WebContents, workspace: Workspace,
  chooseOpen: () => Promise<string | undefined>, chooseCopy: (name: string) => Promise<string | undefined>,
  projectChoices: ProjectChoices) {
  return createEditorTransport(contents,
    { connect: WORKSPACE_CONNECT, command: WORKSPACE_COMMAND, state: WORKSPACE_STATE }, {
      snapshot: workspace.snapshot, onState: workspace.onState, isRequest: isWorkspaceRequest,
      onRevoke: workspace.cancelPending,
      execute: async (command, active, signal): Promise<WorkspaceResult> => {
        let code: string | null = null;
        let copy: WorkspaceResult['copy'] = null;
        let outcome: WorkspaceResult['outcome'] = null;
        let recovery: WorkspaceResult['recovery'] = null;
        let diff: WorkspaceResult['diff'] = null;
        const documentId = 'documentId' in command ? command.documentId : null;
        try {
          if (command.kind === 'source-diff') {
            diff = await workspace.readDiff(command.documentId, command.draftRevision, command.candidateHash);
          } else if (command.kind === 'recovery-list') {
            recovery = await workspace.listRecovery();
          } else if (command.kind === 'restore') {
            const result = await workspace.restore(command.stateRevision, command.recoverySessionId, (operationSignal) =>
              command.sourceMode === 'directory'
                ? chooseProjectDirectory(projectChoices, operationSignal, [app.getPath('userData'), app.getPath('sessionData')])
                : active() ? chooseOpen() : Promise.resolve(undefined));
            outcome = result.status === 'restored' ? 'restored' : 'cancelled';
          } else if (command.kind === 'open') {
            const result = await workspace.open(command.stateRevision, async () => active() ? chooseOpen() : undefined);
            outcome = result.status === 'opened' ? 'opened' : 'cancelled';
          } else if (command.kind === 'open-directory') {
            const result = await workspace.open(command.stateRevision, (operationSignal) =>
              chooseProjectDirectory(projectChoices, operationSignal, [app.getPath('userData'), app.getPath('sessionData')]));
            outcome = result.status === 'opened' ? 'opened' : 'cancelled';
          } else if (command.kind === 'switch-entry') {
            const current = workspace.current;
            if (!current || current.id !== command.documentId) throw new Error('STALE_DOCUMENT');
            const result = await workspace.open(command.stateRevision, (operationSignal) =>
              chooseProjectEntry(current.preview.grant, projectChoices.chooseEntry, operationSignal));
            outcome = result.status === 'opened' ? 'opened' : 'cancelled';
          } else if (command.kind === 'save') {
            const result = await workspace.save(command.stateRevision, command.documentId, command.review);
            const report = result.state.lastSave;
            // Cleanup warnings remain in lastSave. A verified file and new
            // baseline are a successful Save even when evidence cleanup is pending.
            code = ['failed', 'unknown', 'rebase-required'].includes(result.status) ? report?.code ?? 'SAVE_FAILED' : null;
            outcome = result.status === 'saved' || result.status === 'unchanged' || result.status === 'cancelled' || result.status === 'rebase-required' ? result.status : null;
          } else if (command.kind === 'retry-persistence') {
            workspace.retryPersistence(command.documentId, command.draftRevision);
          } else if (command.kind === 'edit') {
            const current = workspace.current;
            if (!current || current.id !== command.documentId) throw new Error('STALE_DOCUMENT');
            if (workspace.snapshot().lastDeparture?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
            if (workspace.snapshot().phase === 'committing') throw new Error('WORKSPACE_BUSY');
            if (workspace.snapshot().cleanupPending && command.value.kind !== 'change') throw new Error('DOCUMENT_CLEANUP_REQUIRED');
            if (workspace.snapshot().phase === 'saving' && workspace.retainedSave !== null) throw new Error('WORKSPACE_BUSY');
            // Late input may arrive during open/review and invalidate its proof.
            // Draft mutations and saving must wait for the workspace to be idle.
            if (workspace.snapshot().phase !== 'idle' && command.value.kind !== 'change') throw new Error('WORKSPACE_BUSY');
            const result = await executeEditorCommand(current.input, command.value,
              () => chooseCopy(current.name), current.writer, () => active() && workspace.current === current, signal);
            code = result.code; copy = result.copy;
          }
        } catch (error) {
          code = error instanceof Error && publicErrors.has(error.message) ? error.message : 'WORKSPACE_COMMAND_FAILED';
        }
        return { ok: code === null, code, state: workspace.snapshot(), documentId, copy, outcome, recovery, diff };
      },
    });
}
