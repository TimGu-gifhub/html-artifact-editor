import type { BaseWindow, Event } from 'electron';
import type { Workspace } from './controller.ts';

const errors = new Set(['WORKSPACE_BUSY', 'STALE_WORKSPACE', 'DOCUMENT_BUSY', 'INPUT_COMPOSING',
  'DOCUMENT_RECOVERY_REQUIRED', 'DOCUMENT_CLEANUP_REQUIRED', 'STALE_DOCUMENT_REVIEW',
  'COPY_FAILED', 'COPY_OUTCOME_UNKNOWN', 'INPUT_MAPPING_LOST', 'INVALID_TEXT_NUL', 'INVALID_UNICODE', 'TEXT_SIZE_LIMIT']);

// OS window close requests cannot bypass pending-input or copy-result checks.
// Dialog rendering belongs to the caller's Decisions implementation; this
// adapter never chooses a leave decision or reports success before it settles.
export function bindWorkspaceWindow(window: BaseWindow, workspace: Workspace, reportError: (code: string) => void) {
  let closing = false;
  let detached = false;
  const report = (error: unknown): void => {
    const code = error instanceof Error && errors.has(error.message) ? error.message : 'WINDOW_CLOSE_FAILED';
    try { reportError(code); } catch { /* Error presentation cannot force a close. */ }
  };
  const detach = (): void => {
    if (detached) return;
    detached = true; window.removeListener('close', onClose); window.removeListener('closed', onClosed);
  };
  const onClosed = (): void => { detach(); void workspace.dispose().catch(report); };
  const onClose = (event: Event): void => {
    event.preventDefault();
    if (closing || detached) return;
    closing = true;
    void workspace.requestClose(workspace.snapshot().stateRevision).then((result) => {
      if (!detached && result.status === 'closed' && !window.isDestroyed()) window.destroy();
    }).catch(report).finally(() => { closing = false; });
  };
  window.on('close', onClose); window.once('closed', onClosed);
  return Object.freeze({ detach, get closing() { return closing; } });
}
