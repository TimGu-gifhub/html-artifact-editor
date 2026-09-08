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
        const documentId = command.kind === 'edit' || command.kind === 'switch-entry' ? command.documentId : null;
        try {
          if (command.kind === 'open') {
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
          } else if (command.kind === 'edit') {
            const current = workspace.current;
            if (!current || current.id !== command.documentId) throw new Error('STALE_DOCUMENT');
            if (workspace.snapshot().cleanupPending && command.value.kind !== 'change') throw new Error('DOCUMENT_CLEANUP_REQUIRED');
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
        return { ok: code === null, code, state: workspace.snapshot(), documentId, copy, outcome };
      },
    });
}
