import type { InlineTextPlacement, InlineTextStyle } from '../contracts/inline-text.ts';

/**
 * 原位输入（HAE-009 真正原位输入）的纯助手：开始编辑 key、激活门禁、聚焦/光标
 * 决策与样式匹配。全部为纯函数/纯状态机，不接触 DOM、不做 IO、不作授权决定；
 * 选字与写入仍只走 Main 已验证的 Input 绑定（controller.begin/change/apply/resolve）。
 */

/**
 * 开始编辑的 key：documentId:nodeId:activation。activation 是可信预览点击次数；
 * 同一 activation 的几何/修订更新不是新点击，绝不因此重开同一文字。
 */
export function inlineBeginKey(placement: InlineTextPlacement): string {
  return `${placement.documentId}:${placement.nodeId}:${placement.activation}`;
}

/** UTF-16 光标提示 clamp 到当前值范围；非法输入按 0 处理。 */
export function clampCaret(caret: number, textLength: number): number {
  if (!Number.isFinite(caret) || !Number.isFinite(textLength)) return 0;
  return Math.min(Math.max(0, Math.round(caret)), Math.max(0, Math.round(textLength)));
}

/**
 * 每个 activation 最多尝试一次 begin。flush/失焦结束、投递失败或修订更新都不
 * 重置已尝试记录；只有新点击（activation 递增）或新 node 形成的新 key 才会再次
 * 开始。手动重试由 controller.retry() 先行清除失败状态，随后由调用方以同一
 * key 之外的新激活进入。
 */
export class InlineActivationGate {
  private readonly attempted = new Set<string>();

  /** 首次见到该 key 返回 true 并登记；重复 key 一律返回 false。 */
  attempt(key: string): boolean {
    if (this.attempted.has(key)) return false;
    if (this.attempted.size >= 512) {
      // 上限防御：逐出最旧记录。旧 key 只可能由更新的 activation 再现，不会误放行同一次点击。
      const oldest = this.attempted.values().next();
      if (!oldest.done) this.attempted.delete(oldest.value);
    }
    this.attempted.add(key);
    return true;
  }
}

export type InlineFocusState = Readonly<{
  /** 输入绑定身份（editToken:activation）；无有效绑定为 null。 */
  binding: string | null;
  /** placement.caret（UTF-16 显示提示），只对本次绑定应用一次。 */
  caret: number;
  /** 当前输入值长度（UTF-16）。 */
  textLength: number;
  /** 排空/保存/历史/映射未定等冻结状态。 */
  frozen: boolean;
  composing: boolean;
  /** 已有本地未排空输入或在途投递：可以聚焦，但不得移动用户光标。 */
  dirty: boolean;
}>;

export type InlineFocusDecision = Readonly<{
  /** 应设置的光标位置；null 表示只聚焦、不移动光标（用户已有输入）。 */
  caret: number | null;
}>;

/**
 * 原位输入的自动聚焦决策。纯状态机，不接触 DOM：
 * - 同一绑定（editToken:activation）最多聚焦一次；之后的输入、预览回执与几何
 *   更新都不再抢焦点；
 * - 组词或冻结时不聚焦、也不记录，待就绪后的下一次评估仍会聚焦（不丢绑定）；
 * - 已有本地输入（dirty）时聚焦但不应用 caret，绝不把迟到的 placement.caret
 *   套用到用户正在编辑的值上；
 * - 失去绑定（binding=null）时重置；新 token 或新 activation 视为新绑定。
 */
export class InlineFocusTracker {
  private focused: string | null = null;

  /** 返回聚焦决策；不需要聚焦（含已聚焦、暂缓、重置）时返回 null。 */
  evaluate(state: InlineFocusState): InlineFocusDecision | null {
    if (state.binding === null) {
      this.focused = null;
      return null;
    }
    if (this.focused === state.binding) return null;
    if (state.frozen || state.composing) return null;
    this.focused = state.binding;
    return { caret: state.dirty ? null : clampCaret(state.caret, state.textLength) };
  }

  reset(): void {
    this.focused = null;
  }
}

/**
 * 把 placement.style 映射为可逐项 CSSOM 赋值的属性表（React style prop 逐项走
 * CSSOM，不经过 innerHTML/cssText 文本拼接；页面 CSP style-src 'self' 不放宽）。
 * 长度一律显式带 px——lineHeight 等属性若传数字会被当作无单位倍数，破坏原位对齐。
 */
export function inlineStyleProps(style: InlineTextStyle): Record<string, string> {
  return {
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: `${style.lineHeight}px`,
    letterSpacing: `${style.letterSpacing}px`,
    color: style.color,
    backgroundColor: style.background,
    whiteSpace: style.whiteSpace,
    textAlign: style.textAlign,
    direction: style.direction,
    textIndent: `${style.indent}px`,
  };
}

/** textarea 换行行为与源 white-space 对齐：仅 pre 不软换行；break-spaces 仍软换行。 */
export function inlineWrap(whiteSpace: InlineTextStyle['whiteSpace']): 'soft' | 'off' {
  return whiteSpace === 'pre' ? 'off' : 'soft';
}

/**
 * 实际应用的样式：detached（源 Text 离开视区，Main 保留同一绑定并切换为临时
 * 输入面板）时不套用源文字的小字号/复杂样式，返回 null，由 CSS 类提供可读的
 * 14px 正常颜色背景；正常原位模式返回逐项 CSSOM 属性表。
 */
export function inlineEffectiveStyle(placement: InlineTextPlacement): Record<string, string> | null {
  return placement.detached ? null : inlineStyleProps(placement.style);
}
