import { useEffect, useId, useRef } from 'react';
import type { InputSnapshot } from '../contracts/input.ts';
import type { PreviewMode } from '../contracts/preview.ts';
import type { LiveInputController, LiveInputView } from './live-input.ts';
import { useLiveInput } from './live-input.ts';
import { draftFrozen, frozenCopyAvailable, preservedText, quiesced } from './input-quiescence.ts';
import { CompactFocusTracker } from './contextual-panel.ts';

type EditorPanelProps = Readonly<{
  hasDocument: boolean;
  mode: PreviewMode;
  input: InputSnapshot | null;
  controller: LiveInputController;
  onRetryBegin: () => void;
  /** 就地小窗：紧凑布局，原文默认折叠，含“取消待预览”；复核与保存仍在主窗口。 */
  compact?: boolean;
}>;

function statusBadge(view: LiveInputView, input: InputSnapshot | null) {
  if (view.composing) return <span className="badge-pending">组词中</span>;
  if (view.busy || view.applying) return <span className="badge-pending">正在更新预览…</span>;
  if (view.dirty) return <span className="badge-pending">待预览</span>;
  if (view.phase === 'active' && !view.error) {
    const changed = input?.changes.some(change => change.nodeId === view.nodeId) ?? false;
    if (changed) return <span className="badge-ok">草稿已预览</span>;
  }
  return null;
}

/** 映射不可用时仍展示 controller 已保留的输入：只读、可聚焦、可选择，不构成任何写入授权。 */
function preservedInput(view: LiveInputView) {
  const bound = view.nodeId !== null;
  if (!bound && view.phase !== 'failed' && !view.composing && !view.dirty) return null;
  return (
    <div className="field">
      <span className="field-label">保留的输入（可复制）</span>
      <textarea
        className="draft-input"
        value={view.localText}
        readOnly
        spellCheck={false}
        aria-label="保留的输入（可复制）"
      />
      <p className="hint">当前已暂停写入；以上输入未被丢弃，可以选中并复制后另行保存。</p>
    </div>
  );
}

/** 校稿栏：文件基线、实时输入、状态徽标与还原/重试操作。 */
export function EditorPanel(props: EditorPanelProps) {
  const view = useLiveInput(props.controller);
  const inputId = useId();
  const { input } = props;
  const compact = props.compact ?? false;

  // 就地小窗：新的输入绑定（Main 会话 editToken）就绪后聚焦草稿框一次，让用户
  // 点击原文后能立即输入。组词/冻结时推迟而非丢弃；离开 compact、只读或失去
  // 绑定时重置；同一绑定的后续输入/预览/状态更新不再抢焦点。docked/floating
  // 的既有焦点行为不变。聚焦不更改文字与选区，也不触发 apply/save。
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const focusTrackerRef = useRef<CompactFocusTracker | null>(null);
  focusTrackerRef.current ??= new CompactFocusTracker();
  const focusBinding = view.phase === 'active' && view.nodeId !== null && input?.input
    ? input.input.editToken : null;
  useEffect(() => {
    const target = focusTrackerRef.current!.evaluate({
      compact,
      readonly: props.mode === 'interactive',
      binding: focusBinding,
      frozen: quiesced(input, view),
      composing: view.composing,
    });
    if (target !== null) draftRef.current?.focus();
  });

  let body;
  if (!props.hasDocument) {
    body = <div className="editor-empty">
      <p>打开 HTML 文件或目录后，在预览中点击一段文字即可开始校对。</p>
    </div>;
  } else if (props.mode === 'interactive') {
    // 脚本只读预览：校稿栏保留面板归属，但不提供任何输入或写入入口。
    body = <div className="editor-empty">
      <p>脚本只读预览：页面本地脚本正在离线运行，这里显示源文件的当前效果。</p>
      <p className="hint">脚本动态生成的文字不能编辑，也不会写回 HTML。在主窗口“返回静态校稿”会重新加载页面并停止脚本；切换前如有未保存修改，会先提供取消、放弃或另存草稿的选择。</p>
      {preservedInput(view)}
    </div>;
  } else if (input?.mappingStatus === 'binding') {
    body = <div className="editor-empty"><p>正在准备页面映射…</p></div>;
  } else if (input?.mappingStatus === 'invalidated') {
    body = <div className="editor-empty">
      <p>此页面的映射已失效，无法继续安全校对。</p>
      <p className="hint">表单控件、按钮、SVG/Canvas、脚本动态生成或无法唯一定位的文字始终为只读；页面被脚本改动后映射也会失效。请在主窗口重新打开文档。</p>
      {preservedInput(view)}
    </div>;
  } else if (input?.mappingStatus === 'closed') {
    body = <div className="editor-empty">
      <p>文档映射已关闭。</p>
      {preservedInput(view)}
    </div>;
  } else if (view.phase === 'idle' && !input?.selection) {
    body = <div className="editor-empty">
      <p>在预览中点击一段静态文字开始校对。</p>
      <p className="hint">仅支持可安全映射的静态文字；表单控件、按钮、SVG/Canvas 与脚本生成的内容为只读，不能选择。</p>
    </div>;
  } else if (view.phase === 'idle' || view.phase === 'beginning') {
    body = <div className="editor-empty"><p>正在锁定所选文字…</p></div>;
  } else if (view.phase === 'failed' && view.nodeId === null) {
    // 草稿冻结（保存故障 uncertain/关闭）期间禁止新的 begin 重试，也保留失败输入不丢弃。
    const failedFrozen = draftFrozen(input);
    body = <div className="editor-empty">
      <div className="panel-error" role="alert">
        <p>{view.error?.message}</p>
        {view.error?.detail && <p className="hint">{view.error.detail}</p>}
        <div className="editor-actions">
          <button type="button" className="btn sm" disabled={failedFrozen} onClick={props.onRetryBegin}>重试</button>
          <button type="button" className="btn sm" disabled={failedFrozen} onClick={() => props.controller.discardFailed()}>放弃</button>
        </div>
      </div>
    </div>;
  } else {
    const frozen = quiesced(input, view);
    // 冻结且仍有保留内容时只读保留（同一 textarea、可聚焦/选择/复制），不禁用；
    // 保存故障冻结本身即构成保留理由，即使本地输入已完全应用。
    const preserved = preservedText(input, view);
    const draftFailure = draftFrozen(input);
    body = <div className="editor-body">
      {compact ? (
        <details className="orig-fold">
          <summary>文件原文</summary>
          <div className="orig-text">{view.beginText}</div>
        </details>
      ) : (
        <div className="field">
          <span className="field-label">文件原文</span>
          <div className="orig-text">{view.beginText}</div>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={inputId}>草稿文字</label>
        <textarea
          id={inputId}
          ref={draftRef}
          className="draft-input"
          value={view.localText}
          disabled={frozen && !preserved}
          readOnly={preserved}
          onChange={event => props.controller.onChange(event.target.value)}
          onCompositionStart={() => props.controller.onCompositionStart()}
          onCompositionEnd={event => props.controller.onCompositionEnd(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && props.controller.escape()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          spellCheck={false}
          aria-label="草稿文字"
        />
        <div className="field-foot">
          {draftFailure
            ? <span className="badge-pending">草稿已冻结 · 输入已保留</span>
            : frozen ? <span className="badge-pending">输入已暂停</span> : statusBadge(view, input)}
          {draftFailure
            ? <span className="hint">{frozenCopyAvailable(input)
              ? '草稿已冻结，以上输入只读保留，可选中复制；本次保存已确认的候选可用“另存草稿”保全为独立副本，这不代表原文件已保存成功，也不会解除冻结。'
              : '草稿已冻结，以上输入只读保留，可选中复制后另行保存。'}</span>
            : <span className="hint">停顿约 0.25 秒自动更新预览；换行显示取决于原页面样式。</span>}
        </div>
      </div>
      {view.intentPending && <p className="hint" role="status">已选中另一段文字，完成当前输入后将切换。</p>}
      {view.error && <div className="panel-error" role="alert">
        <p>{view.error.message}</p>
        {view.error.detail !== '' && <textarea className="error-detail" readOnly value={view.error.detail} aria-label="错误详情" />}
        <div className="editor-actions">
          {view.phase === 'failed' && <button type="button" className="btn sm" disabled={draftFailure}
            onClick={() => props.controller.retry()}>重试</button>}
          {view.phase === 'failed' && <button type="button" className="btn sm" disabled={draftFailure}
            onClick={() => props.controller.discardFailed()}>放弃本地输入</button>}
        </div>
      </div>}
      <div className="editor-actions">
        <button type="button" className="btn" disabled={!view.canRestore || view.busy || view.composing || frozen}
          onClick={() => props.controller.restoreParagraph()}>
          还原为文件原文
        </button>
        {compact && (
          <button type="button" className="btn"
            disabled={frozen || view.busy || view.composing || !view.dirty}
            title="取消尚未预览的输入；已预览内容用“还原为文件原文”或撤销恢复。"
            onClick={() => props.controller.escape()}>
            取消待预览
          </button>
        )}
        <span className="hint">还原本段为文件原文会形成一条可撤销的草稿记录，不会写回原文件。</span>
      </div>
    </div>;
  }

  return (
    <div className="editor-inner">
      <div className="panel-head"><h2>{compact ? '就地校稿' : '校稿'}</h2></div>
      {body}
    </div>
  );
}
