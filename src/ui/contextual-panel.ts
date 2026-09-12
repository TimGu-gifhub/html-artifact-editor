import type { PanelMode } from '../contracts/desktop.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { describeCode } from './util.ts';

/**
 * 面板归属与切换流程（方案 B 校稿栏：停靠/隐藏/独立浮窗/就地小窗 + 原位输入窗）。
 *
 * - 输入 owner：主窗口仅 docked/hidden；浮窗（含就地小窗）为 floating/contextual；
 *   原位输入窗（role=inline）仅 inline。任何写入输入的命令只能由 owner 发出，
 *   owner 判断不得以 Main 快照代替本窗口角色。
 * - 切换面板前必须排空实际输入 owner；组词或失败时不得发送 panel 命令。
 * - 回复只是传输确认：panel 归属始终以 Main 的 desktop.panel 快照为准。
 */

/** 本窗口是否为当前输入 owner。 */
export function panelOwner(role: 'main' | 'editor' | 'inline', panel: PanelMode): boolean {
  if (role === 'inline') return panel === 'inline';
  return role === 'editor' ? panel === 'floating' || panel === 'contextual' : panel === 'docked' || panel === 'hidden';
}

/** flush 提示中的动作名。 */
export function panelActionText(mode: PanelMode): string {
  switch (mode) {
    case 'hidden': return '隐藏校稿栏';
    case 'floating': return '拆卸校稿栏';
    case 'contextual': return '就地编辑';
    case 'inline': return '原位输入';
    case 'docked': return '停靠校稿栏';
  }
}

export type CompactFocusState = Readonly<{
  /** 仅就地小窗（contextual compact）自动聚焦；docked/floating 行为不变。 */
  compact: boolean;
  readonly: boolean;
  /** 当前输入绑定身份（Main 会话 editToken）；无有效绑定为 null。 */
  binding: string | null;
  frozen: boolean;
  composing: boolean;
}>;

/**
 * 就地小窗的草稿框自动聚焦决策。纯状态机，不接触 DOM：
 * - 同一绑定最多返回一次该绑定，之后的输入/预览/状态更新都不再抢焦点；
 * - 组词或冻结时不聚焦、也不记录，待就绪后的下一次评估仍会聚焦（不丢绑定）；
 * - 离开 compact、进入只读或失去绑定时重置，之后重进同一绑定会再次聚焦；
 * - 绑定身份变化（含异文档同 node 的新会话）视为新绑定。
 */
export class CompactFocusTracker {
  private focused: string | null = null;

  /** 返回应聚焦的绑定 id；不需要聚焦（含已聚焦、暂缓、重置）时返回 null。 */
  evaluate(state: CompactFocusState): string | null {
    if (!state.compact || state.readonly || state.binding === null) {
      this.focused = null;
      return null;
    }
    if (this.focused === state.binding) return null;
    if (state.frozen || state.composing) return null;
    this.focused = state.binding;
    return state.binding;
  }

  reset(): void {
    this.focused = null;
  }
}

export type PanelChangeDeps = Readonly<{
  /** 维护门禁（中断检查/记录清理进行中或结果待复核）；非 null 即禁止发起。 */
  maintenanceGate: () => string | null;
  /** 排空实际输入 owner；owner 侧为 controller.flush()，非 owner 侧为 Main 路由。 */
  flush: () => Promise<boolean>;
  /** 单一可信 desktop panel 命令。 */
  request: (mode: PanelMode) => Promise<WorkspaceResult>;
  showToast: (text: string, kind?: 'info' | 'error') => void;
  /**
   * 可选身份绑定（如 documentId:mode）。提供时在排空前取值、排空后复查；
   * 不一致则取消，绝不把面板切换投递给已更换的文档。
   */
  pin?: () => string | null;
}>;

/**
 * 维护门禁 → 排空实际输入 owner → 请求 Main 切换面板。组词、投递失败或门禁
 * 命中时不发送任何命令；Main 的拒绝（如只读模式进入 contextual）如实展示。
 * 同帧重复点击由调用方的同步动作锁（BusyGuard）排除，这里不依赖 UI state。
 */
export async function runPanelChange(deps: PanelChangeDeps, mode: PanelMode): Promise<boolean> {
  const gate = deps.maintenanceGate();
  if (gate) {
    deps.showToast(gate, 'error');
    return false;
  }
  const pinned = deps.pin ? deps.pin() : null;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.showToast(`${panelActionText(mode)}前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。`, 'error');
    return false;
  }
  if (!flushed) {
    deps.showToast(`${panelActionText(mode)}前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。`, 'error');
    return false;
  }
  if (deps.pin && deps.pin() !== pinned) {
    // 排空期间文档/模式已变化：不切换面板，不把动作投递给新文档。
    deps.showToast('文档已变化，本次切换已取消。');
    return false;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.request(mode);
  } catch {
    deps.showToast(describeCode('EDITOR_DISCONNECTED'), 'error');
    return false;
  }
  if (!result.ok) {
    deps.showToast(describeCode(result.code), 'error');
    return false;
  }
  return true;
}

export type ReviewOpenDeps = Readonly<{
  /** 维护门禁（中断检查/记录清理进行中或结果待复核）；非 null 即禁止发起。 */
  maintenanceGate: () => string | null;
  /** 排空实际输入 owner；owner 侧为 controller.flush()，非 owner 侧为 Main 路由。 */
  flush: () => Promise<boolean>;
  /** 打开复核 Dialog/抽屉（调用方决定形态与焦点）。 */
  open: () => void;
  showToast: (text: string, kind?: 'info' | 'error') => void;
  /** 可选身份绑定（如 documentId:mode）；排空后复查，不一致则不打开。 */
  pin?: () => string | null;
}>;

/**
 * 打开复核列表（复核无需收回侧栏/退出原位输入）：维护门禁 → 排空实际输入
 * owner → 复查身份绑定 → 打开。组词、投递失败或门禁命中时不打开；同帧重复
 * 点击由调用方的同步动作锁（BusyGuard）排除，这里不依赖 UI state。
 */
export async function runReviewOpen(deps: ReviewOpenDeps): Promise<boolean> {
  const gate = deps.maintenanceGate();
  if (gate) {
    deps.showToast(gate, 'error');
    return false;
  }
  const pinned = deps.pin ? deps.pin() : null;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.showToast('打开复核前需要先完成当前输入；可能正在组词或投递失败，请检查输入区域。', 'error');
    return false;
  }
  if (!flushed) {
    deps.showToast('打开复核前需要先完成当前输入；可能正在组词或投递失败，请检查输入区域。', 'error');
    return false;
  }
  if (deps.pin && deps.pin() !== pinned) {
    // 排空期间文档/模式已变化：复核列表不得开到新文档上。
    deps.showToast('文档已变化，本次打开复核已取消。');
    return false;
  }
  deps.open();
  return true;
}
