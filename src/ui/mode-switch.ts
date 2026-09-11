import type { PreviewMode } from '../contracts/preview.ts';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { entrySwitchBlocker } from './entry-switch.ts';
import type { EntrySwitchBlocker } from './entry-switch.ts';
import { describeCode } from './util.ts';

/**
 * Mode switching (HAE-008 product mode switch). The UI never passes a path:
 * Main re-derives the target from the pinned document and runs its existing
 * departure confirmation (取消/放弃/另存草稿) before any local script runs.
 * A switch is never an implicit Save; a successful replacement arrives through
 * Workspace onState with a fresh document id, null input and null review
 * bindings for interactive documents.
 */

export type ModeSwitchBlocker = EntrySwitchBlocker;

/** Same document-level risks as entry switching: reuse its gating verbatim. */
export function modeSwitchBlocker(
  state: WorkspaceSnapshot | null,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): ModeSwitchBlocker | null {
  return entrySwitchBlocker(state, options);
}

export function modeSwitchBlockerText(blocker: ModeSwitchBlocker): string {
  switch (blocker) {
    case 'no-document': return '没有已打开的文档。';
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再切换。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能切换模式。';
    case 'review-required': return '有等待复核的故障记录，暂不能切换模式。';
  }
}

/** 目标模式：静态校稿 ⇄ 脚本只读预览。缺失的 mode 一律按静态校稿处理。 */
export function modeSwitchTarget(mode: PreviewMode | undefined): PreviewMode {
  return mode === 'interactive' ? 'proofread' : 'interactive';
}

export type ModeSwitchDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  switchMode: (documentId: string, stateRevision: number, mode: PreviewMode) => Promise<WorkspaceResult>;
  showToast: (text: string, kind?: 'info' | 'error') => void;
}>;

function describeModeSwitchError(code: string | null): string {
  switch (code) {
    case 'STALE_DOCUMENT': return '当前文档已变化，本次切换未执行。';
    case 'STALE_WORKSPACE': return '工作区状态已变化，本次切换未执行。';
    case 'WORKSPACE_BUSY': return '工作区正忙，请稍候再切换。';
    case 'PREVIEW_MODE_UNAVAILABLE': return '当前平台不支持脚本只读预览。';
    case 'INPUT_COMPOSING': return '正在组词，请先完成当前输入。';
    case 'UNAPPLIED_INPUT': return '有尚未预览的输入，请先完成当前输入。';
    case 'FILE_CHANGED': return '文件已被其他程序修改，本次切换未执行。';
    case 'DOCUMENT_RECOVERY_REQUIRED': return '有等待复核的故障记录，暂不能切换模式。';
    case 'DOCUMENT_CLEANUP_REQUIRED': return '有待清理的临时文件，暂不能切换模式。';
    default: return describeCode(code);
  }
}

/**
 * Drain input, then ask Main to replace the pinned document with the other
 * mode. The document id and starting mode are pinned before any await; if the
 * document or mode changed while draining, the action is cancelled and nothing
 * is delivered to the new document. Readonly → proofread works with a null
 * input snapshot: there is simply nothing to drain. Main's native keep/discard/
 * copy review and picker cancellations stay quiet; Main and transport errors
 * are surfaced without rewriting any state.
 *
 * 返回 true 仅当 Main 接受了切换且不是原生复核取消（outcome !== 'cancelled'）；
 * 调用方只有在 true 时才可衔接后续动作（如转入原位输入面板），取消/错误一律
 * 返回 false，绝不切面板。
 */
export async function runModeSwitch(deps: ModeSwitchDeps): Promise<boolean> {
  const start = deps.getState();
  if (!start?.current) return false;
  const startBlocker = modeSwitchBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.showToast(`无法切换模式：${modeSwitchBlockerText(startBlocker)}`, 'error');
    return false;
  }
  const documentId = start.current.id;
  const startMode = start.current.mode === 'interactive' ? 'interactive' : 'proofread';
  const target = modeSwitchTarget(startMode);
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.showToast('切换模式前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。', 'error');
    return false;
  }
  if (!flushed) return false; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest?.current || latest.current.id !== documentId) {
    deps.showToast('文档已变化，本次切换模式已取消。');
    return false;
  }
  const latestMode = latest.current.mode === 'interactive' ? 'interactive' : 'proofread';
  if (latestMode !== startMode) {
    // 排空期间模式已被其他路径改变：不得把旧目标投递给新状态。
    deps.showToast('模式已变化，本次切换已取消。');
    return false;
  }
  const lateBlocker = modeSwitchBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.showToast(`无法切换模式：${modeSwitchBlockerText(lateBlocker)}`, 'error');
    return false;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.switchMode(documentId, latest.stateRevision, target);
  } catch {
    deps.showToast(describeCode('EDITOR_DISCONNECTED'), 'error');
    return false;
  }
  // Opened arrives through onState; a cancelled Main review is not a failure
  // and never a write: both stay quiet and keep the current document/review.
  if (result.ok) return result.outcome !== 'cancelled';
  deps.showToast(describeModeSwitchError(result.code), 'error');
  return false;
}
