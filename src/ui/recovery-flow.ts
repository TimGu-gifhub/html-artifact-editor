import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import type { WorkspaceRecoveryCatalog } from '../contracts/recovery.ts';
import { describeCode } from './util.ts';

/**
 * Recovery flow (HAE-011 M2 directory recovery chooser). The renderer never
 * passes a path and never infers a root from recovery metadata: Main owns the
 * native file/directory+entry pickers and every identity/hash check. The UI
 * only pins the clicked session plus the user's explicit sourceMode choice and
 * forwards both with the LATEST workspace revision after draining input.
 */

export type RecoverySourceMode = 'file' | 'directory';

/** Every newly opened RecoveryDialog starts on the file choice; no fallback. */
export const DEFAULT_RECOVERY_SOURCE_MODE: RecoverySourceMode = 'file';

export type RecoveryBlocker = 'busy' | 'composing' | 'workspace-busy' | 'cleanup-pending' | 'review-required';

/**
 * Unlike entry/mode switching, restore is allowed with no current document and
 * from a readonly interactive current; only workspace-level risks block it.
 */
export function recoveryBlocker(
  state: WorkspaceSnapshot,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): RecoveryBlocker | null {
  if (options.busy) return 'busy';
  if (options.composing) return 'composing';
  if (state.phase !== 'idle') return 'workspace-busy';
  if (state.cleanupPending) return 'cleanup-pending';
  if (state.lastSave?.requiresReview || state.lastDeparture?.requiresReview) return 'review-required';
  return null;
}

export function recoveryBlockerText(blocker: RecoveryBlocker): string {
  switch (blocker) {
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再恢复。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能恢复。';
    case 'review-required': return '有等待复核的故障记录，暂不能恢复。';
  }
}

function describeRestoreError(code: string | null): string {
  switch (code) {
    case 'STALE_WORKSPACE': return '工作区状态已变化，本次恢复未执行。';
    case 'WORKSPACE_BUSY': return '工作区正忙，请稍候再恢复。';
    case 'DRAFT_SESSION_ACTIVE': return '该记录属于当前打开的会话，不能恢复。';
    case 'DRAFT_CHECKPOINT_INVALID': return '该草稿记录无效，不能恢复。';
    case 'DRAFT_PERSISTENCE_UNAVAILABLE': return '草稿记录存储不可用，无法恢复。';
    case 'FILE_CHANGED': return '文件已被其他程序修改，本次恢复未执行。';
    default: return describeCode(code);
  }
}

/** What the dialog renders while/after loading the catalog. */
export type RecoveryCatalogView = Readonly<{
  loading: boolean;
  catalog: WorkspaceRecoveryCatalog | null;
  error: string | null;
}>;

/**
 * Load the recovery catalog bound to one dialog generation. A late success,
 * failure or transport rejection belonging to a closed/reopened dialog is
 * dropped via isCurrent() and can never change the new dialog, clear its busy
 * state (the view carries no busy field) or resurrect a closed one. Loading
 * failures always settle with an error instead of a stuck spinner.
 */
export async function loadRecoveryCatalog(
  listRecovery: () => Promise<WorkspaceResult>,
  isCurrent: () => boolean,
  apply: (view: RecoveryCatalogView) => void,
): Promise<void> {
  let result: WorkspaceResult | null;
  try {
    result = await listRecovery();
  } catch {
    result = null;
  }
  if (!isCurrent()) return;
  if (!result) {
    apply({ loading: false, catalog: null, error: describeCode('EDITOR_DISCONNECTED') });
    return;
  }
  apply({ loading: false, catalog: result.recovery ?? null, error: result.ok ? null : describeCode(result.code) });
}

export type RecoveryRestoreRequest = Readonly<{
  sessionId: string;
  sourceMode: RecoverySourceMode;
}>;

export type RecoveryRestoreDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  restore: (sessionId: string, stateRevision: number, sourceMode: RecoverySourceMode) => Promise<WorkspaceResult>;
  /** Errors stay inside the originating dialog; nothing here is a toast. */
  onError: (text: string) => void;
  /** Only invoked for an authoritative outcome === 'restored'. */
  onRestored: () => void;
}>;

/**
 * Restore one clicked recovery session. The nullable current document id, the
 * session and the explicit sourceMode are pinned before the input owner is
 * flushed; after draining, the document identity (including null ⇄ nonnull)
 * and readiness are rechecked and the LATEST workspace revision is used. Main
 * owns the native choices and the restored document arrives through onState —
 * nothing is ever issued to a replacement document. An authoritative picker
 * cancellation stays quiet; a missing/non-restored or non-ok outcome is an
 * error, never a success claim.
 */
export async function runRecoveryRestore(deps: RecoveryRestoreDeps, request: RecoveryRestoreRequest): Promise<void> {
  const start = deps.getState();
  if (!start) return;
  // Snapshot the clicked primitives at entry: the request object is never
  // re-read after the first await; only the workspace revision stays fresh.
  const sessionId = request.sessionId;
  const sourceMode = request.sourceMode;
  const startBlocker = recoveryBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.onError(`无法恢复：${recoveryBlockerText(startBlocker)}`);
    return;
  }
  const documentId = start.current?.id ?? null;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.onError('恢复前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。');
    return;
  }
  if (!flushed) return; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest) return;
  if ((latest.current?.id ?? null) !== documentId) {
    deps.onError('文档已变化，本次恢复已取消；请重新选择记录。');
    return;
  }
  const lateBlocker = recoveryBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.onError(`无法恢复：${recoveryBlockerText(lateBlocker)}`);
    return;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.restore(sessionId, latest.stateRevision, sourceMode);
  } catch {
    deps.onError(describeCode('EDITOR_DISCONNECTED'));
    return;
  }
  if (result.ok && result.outcome === 'restored') {
    deps.onRestored();
    return;
  }
  // Only an authoritative ok cancellation is quiet: a non-ok result keeps its
  // code and surfaces an error even when the outcome field says cancelled.
  if (result.ok && result.outcome === 'cancelled') return;
  deps.onError(describeRestoreError(result.code));
}

/**
 * Synchronous lifecycle binding for one RecoveryDialog opening. The dialog's
 * rendered state (locked, busy) only updates after a React render, so a
 * same-event-loop Escape/close or menu reopen could otherwise hide or reset
 * an accepted restore before the first paint. The action latch is claimed
 * synchronously inside the acquired busy guard, before the first await, and
 * close/open refuse while it is held. dispose() runs on unmount and
 * invalidates every outstanding generation, so a late result can never touch
 * a successor dialog.
 */
export class RecoveryDialogLifecycle {
  private generation = 0;
  private latched = false;

  /** Generation of the current opening; capture it before starting an action. */
  current(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  /** Genuinely new opening; refused while an accepted action is in flight. */
  open(): number | null {
    if (this.latched) return null;
    this.generation += 1;
    return this.generation;
  }

  /** User close; refused while an accepted action is in flight. */
  close(): boolean {
    if (this.latched) return false;
    this.generation += 1;
    return true;
  }

  /** Claim the action latch synchronously, before the first await. */
  acquire(): boolean {
    if (this.latched) return false;
    this.latched = true;
    return true;
  }

  /** Settle the latch once the action finishes (finally). */
  release(): void {
    this.latched = false;
  }

  /** The flow itself closes the dialog after an authoritative restore. */
  invalidate(): void {
    this.generation += 1;
  }

  /** Unmount: every outstanding generation and latch is dead. */
  dispose(): void {
    this.generation += 1;
    this.latched = false;
  }
}
