import type { BaseWindow, Event } from 'electron';
import type { Workspace } from './controller.ts';

const errors = new Set(['WORKSPACE_BUSY', 'STALE_WORKSPACE', 'DOCUMENT_BUSY', 'INPUT_COMPOSING',
  'DOCUMENT_ACTIVATION_FAILED', 'DOCUMENT_ACTIVATION_UNKNOWN', 'WORKSPACE_CANCELLED',
  'DOCUMENT_RECOVERY_REQUIRED', 'DOCUMENT_CLEANUP_REQUIRED', 'STALE_DOCUMENT_REVIEW',
  'WINDOW_SAVE_UNSETTLED', 'EDITOR_RUNTIME_CLEANUP_REQUIRED', 'DRAFT_STORAGE_ACTIVE',
  'DRAFT_PERSISTENCE_REQUIRED', 'DRAFT_RETIREMENT_FAILED', 'DRAFT_RETIREMENT_UNKNOWN',
  'COPY_FAILED', 'COPY_OUTCOME_UNKNOWN', 'INPUT_MAPPING_LOST', 'INVALID_TEXT_NUL', 'INVALID_UNICODE', 'TEXT_SIZE_LIMIT']);

// OS window close requests cannot bypass pending-input or copy-result checks.
// Dialog rendering belongs to the caller's Decisions implementation; this
// adapter never chooses a leave decision or reports success before it settles.
export type WindowCloseResult = 'closed' | 'cancelled' | 'blocked';
export type WindowCloseOptions = Readonly<{
  waitForSave?: boolean; beforeClose?: () => Promise<void>;
  beforeRequestClose?: () => Promise<boolean>;
}>;
export function bindWorkspaceWindow(window: BaseWindow, workspace: Workspace, reportError: (code: string) => void,
  options: WindowCloseOptions = {}) {
  let closing: Promise<WindowCloseResult> | null = null;
  let detached = false;
  let cleanupFailed = false;
  const blockClose = (event: Event): void => event.preventDefault();
  const clearBlock = (): void => { window.removeListener('close', blockClose); window.removeListener('closed', clearBlock); };
  const report = (error: unknown): void => {
    const code = error instanceof Error && errors.has(error.message) ? error.message : 'WINDOW_CLOSE_FAILED';
    try { reportError(code); } catch { /* Error presentation cannot force a close. */ }
  };
  const detach = (): void => {
    if (detached) return;
    detached = true; window.removeListener('close', onClose); window.removeListener('closed', onClosed);
  };
  const onClosed = (): void => { detach(); void workspace.dispose().catch(report); };
  const requestClose = (): Promise<WindowCloseResult> => {
    if (closing) return closing;
    if (cleanupFailed) return Promise.resolve('blocked');
    if (detached || window.isDestroyed()) return Promise.resolve(window.isDestroyed() ? 'closed' : 'blocked');
    closing = Promise.resolve().then(async (): Promise<WindowCloseResult> => {
      const saving = options.waitForSave ? workspace.waitForSave() : null;
      if (saving) {
        const saved = await saving;
        if (!saved || !['saved', 'backup-restored', 'unchanged'].includes(saved.status) || saved.requiresReview || saved.cleanupPending) {
          throw new Error('WINDOW_SAVE_UNSETTLED');
        }
      }
      if (detached || window.isDestroyed()) return 'blocked';
      // Join an accepted Save first, then transfer the latest local input.
      // IME, disconnected UI or a failed flush never authorizes native close.
      if (options.beforeRequestClose && !await options.beforeRequestClose()) return 'cancelled';
      const result = await workspace.requestClose(workspace.snapshot().stateRevision);
      if (result.status !== 'closed') return 'cancelled';
      if (detached) return 'blocked';
      // The persistent runtime drains and verifies cleanup here, while the
      // native window still exists. Failure must never look like a clean exit.
      if (options.beforeClose) {
        // Teardown detaches the ordinary guard. If it fails, a later native
        // close must not bypass that failure just because IPC is already gone.
        window.on('close', blockClose); window.once('closed', clearBlock);
        try { await options.beforeClose(); }
        catch (error) { cleanupFailed = true; throw error; }
        clearBlock();
      }
      if (!window.isDestroyed()) window.destroy();
      return 'closed';
    }).catch((error: unknown): WindowCloseResult => { report(error); return 'blocked'; })
      .finally(() => { closing = null; });
    return closing;
  };
  const onClose = (event: Event): void => { event.preventDefault(); void requestClose(); };
  window.on('close', onClose); window.once('closed', onClosed);
  return Object.freeze({ detach, requestClose, get closing() { return closing !== null; } });
}
