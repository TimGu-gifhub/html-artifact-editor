import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { InputSnapshot } from '../contracts/input.ts';
import { panelOwner } from './contextual-panel.ts';
// 每窗输入控制器与 flush 应答钩子由 app.tsx 定义并在主窗/浮窗/原位窗间复用；
// 二者均为函数声明，模块环形引用在初始化前即完成提升。
import { useController, useFlushRequests } from './app.tsx';
import { useLiveInput } from './live-input.ts';
import type { LiveInputView } from './live-input.ts';
import { InlineActivationGate, InlineFocusTracker, inlineBeginKey, inlineEffectiveStyle, inlineWrap } from './inline-input.ts';

/**
 * 原位输入窗（HAE-009 真正原位输入）：Main 创建的透明、无标题栏、无阴影原生
 * 子窗口，直接覆盖所选 Text 矩形（原生 bounds 为 rect.x/y-2、宽/高 ceil+5，
 * 因此输入从窗口内 x=2,y=2 开始，与源文字重合）。窗口内只有同位置纯文本
 * textarea（.inline-text-input）：没有工具栏、文件原文、状态栏或大块默认
 * padding，内容一律纯文本，绝不复制页面 DOM，也不渲染与内容不同步的装饰节点。
 *
 * - 只有 panel=inline 时本窗口是输入 owner（Main 同时按 owner() 强制校验）；
 *   begin/change/apply/resolve 全部由复用的 LiveInputController 发出，选字与
 *   写入仍只走 Main 已验证的静态 Text 绑定，绝不依据坐标调用选字。
 * - 开始编辑的 key 为 documentId:nodeId:activation；每个 activation 最多尝试
 *   一次，flush/失焦/修订更新都不会重开同一文字，新点击或新 node 才重新开始。
 *   有效 placement 必须匹配当前 proofread 文档与 Main 发布的 selection。
 * - 有效绑定后自动聚焦一次并应用 placement.caret（clamp 到值范围）；同一
 *   token/activation 的输入、预览回执与几何更新不再抢焦点；几何更新只改布局
 *   （样式逐项 CSSOM 赋值），不重建输入、不重置值、不改变光标。
 * - detached：源 Text 滚出视区/空值/几何失效时 Main 保留同一 nodeId/token
 *   绑定并把原生窗变为临时输入面板（placement.detached=true，组词期间 Main 不
 *   发布新 placement）。本组件始终渲染同一个 textarea DOM 节点——标签槽常驻、
 *   仅用 hidden 显隐——本地值、光标与会话不因 detached 切换而丢失；detached
 *   不影响 begin key 与 focus key。
 * - controller.flush() 只排空（投递并确认最新输入），不释放 token、不结束
 *   输入会话；失焦排空后输入仍绑定原文字，组词或失败时 flush 拒绝、输入原地
 *   保留可复制，绝不隐式丢弃。组词期间不改焦点、不触发 Enter/Escape/模式/保存。
 */

/** External transactions and mapping states under which the textarea is quiesced. */
function quiesced(input: InputSnapshot | null, view: LiveInputView): boolean {
  if (view.flushing || view.resolving) return true;
  // 没有输入会话（只读预览或映射尚未建立）时绝不允许输入：null input 不是写入授权。
  if (!input) return true;
  if (input.mappingStatus !== 'ready') return true;
  return input.phase === 'saving' || input.phase === 'leaving' || input.phase === 'closed'
    || input.phase === 'history' || input.phase === 'resolving' || input.phase === 'beginning';
}

export function InlineWindow(props: Readonly<{ state: WorkspaceSnapshot }>) {
  const { state } = props;
  const current = state.current;
  const input = current?.input ?? null;
  const readonly = current?.mode === 'interactive';
  const panel = state.desktop?.panel ?? 'inline';
  const owner = panelOwner('inline', panel);
  const controller = useController(state, owner);
  const view = useLiveInput(controller);
  useFlushRequests(state, owner, controller);
  // 仅接受属于当前文档的 placement；异文档/缺失一律不展示、不开始。
  const placement = state.desktop?.inline && current && state.desktop.inline.documentId === current.id
    ? state.desktop.inline : null;
  const detached = placement?.detached === true;

  // 透明原生窗：页面背景透明，文字外观按 placement.style 匹配（detached 时改由
  // CSS 类提供可读的 14px 正常颜色背景）。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('inline-window');
    return () => root.classList.remove('inline-window');
  }, []);

  // 开始编辑：有效 placement 必须匹配当前 proofread 文档与 Main 发布的
  // selection.reference.nodeId；selection revision 按 Main 当前快照传给 begin。
  // 侧栏/浮窗转入 inline 的既有 input token 由 controller.sync() 直接采用，
  // 不经过这里的 begin。detached 只是展示回退，不改变 begin key。
  const gateRef = useRef<InlineActivationGate | null>(null);
  gateRef.current ??= new InlineActivationGate();
  useEffect(() => {
    if (!owner || readonly || !input || input.input || input.phase !== 'idle' || !input.selection || !placement) return;
    if (placement.nodeId !== input.selection.reference.nodeId) return;
    const key = inlineBeginKey(placement);
    if (!gateRef.current!.attempt(key)) return;
    void controller.begin(key, input.selection.reference, input.draftRevision);
  }, [owner, readonly, input, placement, controller]);

  // 自动聚焦一次：绑定身份为 editToken:activation，并要求 controller 视图与 Main
  // 快照指向同一 node——避免旧 view 值搭配新 Main token 的过渡渲染误聚焦。迟到的
  // 几何更新（同 activation）不会再次抢焦点或移动光标；placement 迟到时 caret 也
  // 只对匹配当前绑定的值应用一次。
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const focusRef = useRef<InlineFocusTracker | null>(null);
  focusRef.current ??= new InlineFocusTracker();
  const frozen = quiesced(input, view);
  const binding = owner && view.phase === 'active' && view.nodeId !== null && input?.input && placement
    && placement.nodeId === input.input.nodeId && view.nodeId === input.input.nodeId
    ? `${input.input.editToken}:${placement.activation}` : null;
  useEffect(() => {
    const decision = focusRef.current!.evaluate({
      binding,
      caret: placement?.caret ?? 0,
      textLength: textRef.current?.value.length ?? 0,
      frozen,
      composing: view.composing,
      dirty: view.dirty || view.busy,
    });
    if (!decision) return;
    const el = textRef.current;
    if (!el) return;
    el.focus();
    if (decision.caret !== null) {
      try { el.setSelectionRange(decision.caret, decision.caret); } catch { /* 光标提示失败不影响输入 */ }
    }
  });

  if (!current || readonly || !placement) {
    // Main 在这些状态下保持窗口隐藏；不提供任何输入面，也不臆造选字。
    return <div className="inline-app" aria-hidden="true" />;
  }

  // 冻结（排空/保存/历史/映射失效）但仍有本地未确认输入时：只读保留、可聚焦
  // 可选择可复制，绝不隐式丢弃；无保留内容时按 EditorPanel 语义禁用。
  const preserved = frozen && view.localText !== ''
    && (view.dirty || view.composing || view.phase === 'failed' || view.error !== null);
  const errorText = view.error
    ? `${view.error.message}${view.error.detail ? ` ${view.error.detail}` : ''}` : null;
  const matched = inlineEffectiveStyle(placement);
  return (
    <div className={detached ? 'inline-app detached' : 'inline-app'}>
      {/* 标签槽常驻：仅用 hidden 显隐，保证 textarea 始终是同一 DOM 节点，
          本地值/光标/会话不因 detached 切换而重建。 */}
      <div className="inline-tag" role="status" hidden={!detached}>文字已离开视区 · 输入已保留</div>
      <textarea
        ref={textRef}
        className={detached ? 'inline-text-input detached' : 'inline-text-input'}
        style={(matched ?? undefined) as CSSProperties | undefined}
        wrap={detached ? 'soft' : inlineWrap(placement.style.whiteSpace)}
        value={view.localText}
        disabled={frozen && !preserved}
        readOnly={preserved}
        onChange={event => controller.onChange(event.target.value)}
        onCompositionStart={() => controller.onCompositionStart()}
        onCompositionEnd={event => controller.onCompositionEnd(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && controller.escape()) {
            // 取消尚未预览的输入后随即排空确认；flush 只排空，不释放 token、
            // 不结束会话，也绝不触发保存。已预览内容用撤销/还原。
            event.preventDefault();
            event.stopPropagation();
            void controller.flush();
          }
        }}
        onBlur={() => {
          // 失焦只排空（投递并确认最新输入），不结束输入会话；组词或失败时
          // flush 拒绝，输入原地保留，可继续编辑或复制。
          void controller.flush();
        }}
        spellCheck={false}
        aria-label="页面原位文字"
        aria-invalid={view.error ? true : undefined}
        title={errorText ?? '原位编辑所选文字；停顿后自动更新预览，Esc 取消未预览的输入。'}
      />
      {errorText && <span className="sr-only" role="alert">{errorText}</span>}
    </div>
  );
}
