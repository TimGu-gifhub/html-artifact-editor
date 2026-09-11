import type { HiddenContentState } from '../contracts/desktop.ts';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { describeCode } from './util.ts';

/**
 * Hidden-content toggle（方案 B “显示隐藏内容”，见 docs/HIDDEN_CONTENT.md）。
 * Main owns the screen-only CSS; this renderer flow only pins the current
 * document, drains the real input owner window and sends documentId + the
 * LATEST workspace stateRevision + the pinned target. The UI never passes a
 * CSS rule, selector or path, never touches the page DOM, and never updates
 * `enabled` optimistically — the displayed state is always Main's snapshot.
 * 临时展开/收起不写入 HTML，也不清空草稿、选择或复核。
 */

export type HiddenContentBlocker = 'no-document' | 'readonly' | 'no-field' | 'unavailable'
  | 'limited' | 'uncertain' | 'main-busy' | 'busy' | 'composing' | 'workspace-busy'
  | 'cleanup-pending' | 'review-required';

/** The published state only when it belongs to the current document; old states lack the field. */
export function hiddenContentForCurrent(state: WorkspaceSnapshot | null): HiddenContentState | null {
  const current = state?.current;
  const hidden = state?.desktop?.hiddenContent;
  if (!current || !hidden || hidden.documentId !== current.id) return null;
  return hidden;
}

/** Gates both the toolbar/menu disabled state and the flow's runtime checks. */
export function hiddenContentBlocker(
  state: WorkspaceSnapshot | null,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): HiddenContentBlocker | null {
  if (!state?.current) return 'no-document';
  if (state.current.mode === 'interactive') return 'readonly';
  if (options.busy) return 'busy';
  if (options.composing) return 'composing';
  if (state.phase !== 'idle') return 'workspace-busy';
  if (state.cleanupPending) return 'cleanup-pending';
  if (state.lastSave?.requiresReview || state.lastDeparture?.requiresReview) return 'review-required';
  const hidden = state.desktop?.hiddenContent;
  if (!hidden || hidden.documentId !== state.current.id) return 'no-field';
  if (hidden.busy) return 'main-busy';
  if (hidden.uncertain) return 'uncertain';
  // Main 在 limited=true 时一定 available=false：必须先判断 limited，否则超限提示永远到不了。
  if (hidden.limited) return 'limited';
  if (!hidden.available || hidden.count <= 0) return 'unavailable';
  return null;
}

export function hiddenContentBlockerText(blocker: HiddenContentBlocker): string {
  switch (blocker) {
    case 'no-document': return '没有已打开的文档。';
    case 'readonly': return '脚本只读预览下不能更改显隐；返回静态校稿后再操作。';
    case 'no-field': return '当前文档没有可展开的隐藏内容信息。';
    case 'unavailable': return '当前文档的隐藏内容不能展开：可能受页面样式限制，或不在支持范围内。';
    case 'limited': return '隐藏内容超出可安全展开的范围，暂不能展开。';
    case 'uncertain': return '隐藏内容的显示状态未能确认；不会自动恢复或重试，草稿与输入已保留。';
    case 'main-busy': return '正在更改隐藏内容的显示，请稍候。';
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再操作。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能更改显隐。';
    case 'review-required': return '有等待复核的故障记录，暂不能更改显隐。';
  }
}

export type HiddenContentDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** 维护门禁（中断检查/记录清理进行中或结果待复核）；非 null 即禁止发起。 */
  maintenanceGate: () => string | null;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  /** The single trusted desktop command; resolves when Main finished handling it. */
  request: (documentId: string, stateRevision: number, enabled: boolean) => Promise<WorkspaceResult>;
  showToast: (text: string, kind?: 'info' | 'error') => void;
}>;

function describeHiddenContentError(code: string | null): string {
  switch (code) {
    case 'HIDDEN_CONTENT_BUSY': return '另一个显隐操作正在进行，请稍候。';
    // Main 已验证临时样式的实际显示结果：被原页面样式（如 inline !important）
    // 阻止时精确撤回并返回本码，不能只归因为脚本生成。
    case 'HIDDEN_CONTENT_UNAVAILABLE': return '这部分内容不能展开：可能受页面样式限制、不在支持范围内，或仅由脚本生成；页面与草稿未受影响。';
    // Main 报告原生样式结果不确定：CSS 可能已改也可能未改，禁止声称页面未受影响；
    // unknown 不会等待自动恢复，不能暗示“稍候会自行变好”。
    case 'HIDDEN_CONTENT_FAILED': return '显隐状态未能确认：内容可能已展开也可能未展开，草稿与输入已保留；如需重新打开文档，请先另存草稿保留修改。';
    case 'STALE_WORKSPACE': return '工作区状态已变化，本次操作未执行。';
    case 'STALE_DOCUMENT': return '当前文档已变化，本次操作未执行。';
    case 'INPUT_FLUSH_REQUIRED': return '有尚未完成的输入，请先完成当前输入。';
    default: return describeCode(code);
  }
}

/**
 * Drain the actual input owner, then ask Main to expand/collapse the pinned
 * document's hidden static content. The document id, the starting mode and the
 * target `enabled` are pinned before any await; the maintenance gate
 * (interruption check / record cleanup) is enforced both before and after the
 * drain. If the document, mode or display state changed while draining, the
 * action is cancelled and nothing is delivered to the new state; a late reply
 * is shown only while the originating document is still current. The reply is
 * only a transport ack: `enabled` in the UI always follows Main's onState
 * snapshot, a failure keeps drafts, selection and review untouched, and an
 * uncertain native outcome is never retried from here.
 */
export async function runHiddenContentToggle(deps: HiddenContentDeps): Promise<void> {
  const start = deps.getState();
  if (!start?.current) return;
  const startBlocker = hiddenContentBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.showToast(`无法更改显隐：${hiddenContentBlockerText(startBlocker)}`, 'error');
    return;
  }
  const startGate = deps.maintenanceGate();
  if (startGate) {
    deps.showToast(startGate, 'error');
    return;
  }
  const startHidden = hiddenContentForCurrent(start);
  if (!startHidden) return; // unreachable once the blocker passed; defensive
  const documentId = start.current.id;
  const startEnabled = startHidden.enabled;
  const target = !startEnabled;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.showToast('更改显隐前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。', 'error');
    return;
  }
  if (!flushed) return; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest?.current || latest.current.id !== documentId) {
    deps.showToast('文档已变化，本次显隐操作已取消。');
    return;
  }
  if (latest.current.mode === 'interactive') {
    deps.showToast('模式已变化，本次显隐操作已取消。');
    return;
  }
  const lateHidden = hiddenContentForCurrent(latest);
  if (!lateHidden) {
    deps.showToast('隐藏内容信息已变化，本次显隐操作已取消。');
    return;
  }
  if (lateHidden.enabled !== startEnabled) {
    // 排空期间显隐已被其他路径改变：不得把旧目标投递给新状态。
    deps.showToast('显隐状态已变化，本次操作已取消。');
    return;
  }
  const lateBlocker = hiddenContentBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.showToast(`无法更改显隐：${hiddenContentBlockerText(lateBlocker)}`, 'error');
    return;
  }
  // 排空期间维护门禁可能才出现（中断检查/记录清理开始或结果待复核）：不得发送。
  const lateGate = deps.maintenanceGate();
  if (lateGate) {
    deps.showToast(lateGate, 'error');
    return;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.request(documentId, latest.stateRevision, target);
  } catch {
    const after = deps.getState();
    if (after?.current && after.current.id === documentId) {
      deps.showToast(describeCode('EDITOR_DISCONNECTED'), 'error');
    }
    return;
  }
  // ok is only a transport ack: the new display state arrives through onState.
  // A failure keeps the input and never claims the display changed.
  if (result.ok) return;
  // 迟到结果只属于发起时的文档：文档已变化时忽略旧错误，不向新文档显示。
  const after = deps.getState();
  if (!after?.current || after.current.id !== documentId) return;
  deps.showToast(describeHiddenContentError(result.code), 'error');
}
