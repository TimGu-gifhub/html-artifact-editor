import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { CleanupState } from '../contracts/record-cleanup.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { describeCode, formatBytes } from './util.ts';

/**
 * Record-cleanup flow (HAE-011 product workbench). The renderer only sends
 * `clear-records` with the LATEST workspace revision; Main owns the inventory
 * check, the independently bound native confirmation, the durable manifest and
 * every deletion. The UI never passes a path, a file list, a delete
 * authorization or a reviewId, never decides from a snapshot that no input is
 * pending, and never treats WorkspaceResult.ok as a cleanup success — the
 * outcome arrives through onState as desktop.cleanup.result.
 */

/** Maintenance gate for every other action: Main is checking/cleaning or the result needs review. */
export type CleanupGate = 'main-busy' | 'review-required';

export function cleanupGate(state: WorkspaceSnapshot | null): CleanupGate | null {
  const cleanup = state?.desktop?.cleanup;
  if (!cleanup) return null;
  if (cleanup.phase !== 'idle') return 'main-busy';
  if (cleanup.requiresReview) return 'review-required';
  return null;
}

export function cleanupGateText(gate: CleanupGate): string {
  switch (gate) {
    case 'main-busy': return '正在检查或清理本地记录，其他操作暂不可用。';
    case 'review-required': return '本地记录清理的结果需要人工检查，其他操作暂不可用；可在“清理本地记录”中查看。';
  }
}

export type CleanupBlocker = 'has-document' | 'no-main-state' | 'busy' | 'composing' | 'workspace-busy'
  | 'cleanup-pending' | 'review-required' | 'interruption-busy' | 'interruption-review'
  | 'cleanup-busy' | 'cleanup-review';

/** Gates both the dialog's check button and the flow's runtime checks. */
export function cleanupBlocker(
  state: WorkspaceSnapshot | null,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): CleanupBlocker | null {
  if (!state) return 'workspace-busy';
  if (state.current) return 'has-document';
  if (!state.desktop?.cleanup) return 'no-main-state';
  if (options.busy) return 'busy';
  if (options.composing) return 'composing';
  if (state.phase !== 'idle') return 'workspace-busy';
  if (state.cleanupPending) return 'cleanup-pending';
  if (state.lastSave?.requiresReview || state.lastDeparture?.requiresReview) return 'review-required';
  const interruption = state.desktop.interruption;
  if (interruption && interruption.phase !== 'idle') return 'interruption-busy';
  if (interruption?.requiresReview) return 'interruption-review';
  const cleanup = state.desktop.cleanup;
  if (cleanup.phase !== 'idle') return 'cleanup-busy';
  if (cleanup.requiresReview) return 'cleanup-review';
  return null;
}

export function cleanupBlockerText(blocker: CleanupBlocker): string {
  switch (blocker) {
    case 'has-document': return '当前已打开文档；请重启应用后，在打开文档前清理。当前文档与修改保持不变。';
    case 'no-main-state': return '当前主进程未提供本地记录清理状态，无法执行。';
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再清理。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能清理本地记录。';
    case 'review-required': return '有等待复核的保存或退出记录，暂不能清理。';
    case 'interruption-busy': return '中断检查正在进行，请稍候。';
    case 'interruption-review': return '有等待人工检查的中断处理结果；请保留当前窗口与记录，暂不能清理。';
    case 'cleanup-busy': return '本地记录的检查或清理正在进行，请稍候。';
    case 'cleanup-review': return '有等待人工检查的清理结果；请保留当前窗口与记录，暂不能发起新清理。';
  }
}

/** Readable text for the Main-owned phase; idle renders nothing. */
export function cleanupPhaseText(phase: CleanupState['phase']): string | null {
  switch (phase) {
    case 'checking': return '正在检查本机保存的全部本地记录，随后会在系统对话框中显示清单…';
    case 'reviewing': return '请在系统对话框中查看清单并选择；确认前不会删除任何内容。';
    case 'cleaning': return '正在按确认删除本地记录，请勿关闭窗口…';
    case 'idle': return null;
  }
}

export type CleanupResultView = Readonly<{
  tone: 'info' | 'ok' | 'warn' | 'error';
  text: string;
  detail: string | null;
  code: string | null;
  /** unknown / requiresReview / confirmed-with-warning never offer a direct retry. */
  canCheckAgain: boolean;
}>;

/**
 * Result area for the dialog, derived only from the Main-published cleanup
 * state. Natural-Chinese distinctions per outcome; nothing here claims success
 * from a transport ack, and a cancelled result stays quiet without pretending
 * anything was deleted.
 */
export function cleanupResultView(state: CleanupState | null): CleanupResultView | null {
  const result = state?.result;
  if (!state || !result) return null;
  const summary = state.summary;
  if (state.requiresReview || result.status === 'unknown') {
    if (result.status === 'unknown') {
      return { tone: 'error', text: '清理结果未知：部分记录可能已被删除，也可能仍保留；已被删除的记录无法恢复。',
        detail: '当前窗口、磁盘上仍存在的记录以及主进程内存中的清理证据已保留，等待人工检查。请勿重试或强制退出；重试无法撤销已开始的删除。',
        code: result.code, canCheckAgain: false };
    }
    if (result.status === 'cleared') {
      return { tone: 'warn', text: '清理本身已确认完成，但收尾核验有警告；已被删除的记录（可能已包括私有目录的全部内容与清理清单）无法恢复。',
        detail: '当前窗口与主进程内存中的证据已保留，等待人工检查。请勿重复操作或强制退出。', code: result.code, canCheckAgain: false };
    }
    return { tone: 'warn', text: '本次清理留下了需要人工检查的状态；在此期间已被删除的记录无法恢复。',
      detail: '当前窗口与仍可用的现场证据已保留。请勿重试或强制退出。', code: result.code, canCheckAgain: false };
  }
  switch (result.status) {
    case 'cancelled':
      return { tone: 'info', text: '已取消清理，本次没有继续删除记录。',
        detail: summary?.resuming ? '上次中断前可能已删除部分记录；当前剩余的记录保持不变。' : null,
        code: null, canCheckAgain: true };
    case 'unavailable':
      if (result.code === 'RECORD_CLEANUP_EMPTY') {
        return { tone: 'info', text: '没有可清理的本地记录。',
          detail: '本应用当前没有保存草稿记录、撤销历史或应用备份；源文件不受影响。', code: result.code, canCheckAgain: true };
      }
      return { tone: 'info', text: '本地记录清理当前不可用。', detail: null, code: result.code, canCheckAgain: true };
    case 'failed':
      switch (result.code) {
        case 'RECORD_CLEANUP_RECOVERY_REQUIRED':
          return { tone: 'error', text: '清理未完成：存在尚未核实的记录，需要先检查上次中断的处理结果。本次没有继续删除，当前剩余的记录保持不变。',
            detail: '反复重试不能修好该状态；请勿强制清理或改动记录目录，保留窗口以便排查。', code: result.code, canCheckAgain: true };
        case 'RECORD_CLEANUP_INVALID':
        case 'RECORD_CLEANUP_CHANGED':
        case 'RECORD_CLEANUP_ROOT_MISMATCH':
          return { tone: 'error', text: '清理未完成：清理现场已发生变化或无法核实。本次没有继续删除，当前剩余的记录保持不变。',
            detail: '请先检查上次中断的处理结果与记录现场；反复重试不一定能恢复，请勿强制清理或手动改动记录目录。', code: result.code, canCheckAgain: true };
        default:
          return { tone: 'error', text: '清理未完成，本次没有继续删除；当前剩余的记录保持不变。',
            detail: '可以重新发起检查；若反复失败，请保留窗口以便排查。', code: result.code, canCheckAgain: true };
      }
    case 'cleared': {
      if (result.code !== null) {
        return { tone: 'warn', text: '清理本身已完成，但收尾核验有警告；已被删除的记录与清理清单无法恢复。',
          detail: '主进程内存中的证据已保留。请勿重复操作或强制退出。', code: result.code, canCheckAgain: false };
      }
      const counts = summary
        ? summary.resuming
          ? `上次已确认的原清单已清理完毕（原清单共 ${summary.records} 条记录：${summary.sessions} 个校稿会话、${summary.unsavedDrafts} 份含修改的草稿记录、${summary.backups} 份应用备份，共 ${formatBytes(summary.bytes)}；其中部分记录可能已在上次中断前被删除）。`
          : `已删除 ${summary.records} 条记录（${summary.sessions} 个校稿会话、${summary.unsavedDrafts} 份含修改的草稿记录、${summary.backups} 份应用备份，共 ${formatBytes(summary.bytes)}）。`
        : '本地记录已删除。';
      return { tone: 'ok', text: `清理完成：${counts}`,
        detail: '源 HTML、CSS、PDF 与项目文件未被修改；被删除的草稿、撤销历史与备份无法恢复。', code: null, canCheckAgain: true };
    }
  }
}

function describeCleanupError(code: string | null): string {
  switch (code) {
    case 'RECORD_CLEANUP_BUSY': return '另一个清理或操作正在进行，请稍候。';
    case 'RECORD_CLEANUP_REVIEW_REQUIRED': return '有等待人工检查或复核的状态，暂不能发起新清理。';
    case 'RECORD_CLEANUP_RESTART_REQUIRED': return '已打开文档，无法清理；请重启后，在打开文档前清理。';
    case 'RECORD_CLEANUP_UNAVAILABLE': return '本地记录清理当前不可用。';
    case 'INTERRUPTION_BUSY': return '正在检查上次中断，请稍候。';
    case 'INTERRUPTION_REVIEW_REQUIRED': return '有等待人工检查的中断处理结果，暂不能清理。';
    case 'RECORD_CLEANUP_RECOVERY_REQUIRED': return '存在尚未核实的记录；请先检查上次中断的处理结果，反复重试不能修好。';
    case 'RECORD_CLEANUP_INVALID':
    case 'RECORD_CLEANUP_CHANGED':
    case 'RECORD_CLEANUP_ROOT_MISMATCH': return '清理现场已发生变化或无法核实；请先检查上次中断的处理结果，反复重试不一定能恢复。';
    case 'STALE_WORKSPACE': return '工作区状态已变化，本次清理未执行。';
    default: return describeCode(code);
  }
}

export type CleanupCheckDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  /** The single renderer command; resolves when Main finished handling it. */
  clear: (stateRevision: number) => Promise<WorkspaceResult>;
  /** Errors stay inside the originating dialog; nothing here is a toast. */
  onError: (text: string) => void;
}>;

/**
 * Start one record-cleanup check. The nullable current identity (always null
 * here: a document of any kind blocks the flow) is pinned before the input
 * owner is drained; after draining, the identity (null ⇄ nonnull), phase,
 * composing, cleanup, save/departure review flags and both maintenance gates
 * are rechecked and only the LATEST workspace revision is sent. A document
 * that appeared meanwhile cancels the flow and nothing is delivered. The
 * result promise is only a transport ack: ok never closes the dialog or claims
 * a cleanup — the displayed outcome is Main's onState cleanup.result.
 */
export async function runCleanupCheck(deps: CleanupCheckDeps): Promise<void> {
  const start = deps.getState();
  if (!start) return;
  const startBlocker = cleanupBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.onError(`无法清理：${cleanupBlockerText(startBlocker)}`);
    return;
  }
  const documentId = start.current?.id ?? null;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.onError('清理前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。');
    return;
  }
  if (!flushed) return; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest) return;
  if ((latest.current?.id ?? null) !== documentId) {
    deps.onError('文档状态已变化，本次清理已取消；请重新发起。');
    return;
  }
  const lateBlocker = cleanupBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.onError(`无法清理：${cleanupBlockerText(lateBlocker)}`);
    return;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.clear(latest.stateRevision);
  } catch {
    deps.onError(describeCode('EDITOR_DISCONNECTED'));
    return;
  }
  // ok only means the command was handled; the cleanup outcome is the
  // Main-published cleanup.result, never this reply. Keep the dialog.
  if (result.ok) return;
  deps.onError(describeCleanupError(result.code));
}

/**
 * Synchronous lifecycle binding for one CleanupDialog opening, mirroring the
 * interruption dialog: the action latch is claimed synchronously inside the
 * acquired busy guard, before the first await, so a same-event-loop
 * Escape/close or menu reopen can never hide or reset an accepted check even
 * before the locked dialog re-renders. dispose() runs on unmount and
 * invalidates every outstanding generation, so a late result can never touch
 * a successor dialog.
 */
export class CleanupDialogLifecycle {
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

  /** Unmount: every outstanding generation and latch is dead. */
  dispose(): void {
    this.generation += 1;
    this.latched = false;
  }
}
