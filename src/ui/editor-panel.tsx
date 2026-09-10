import { useId } from 'react';
import type { InputSnapshot } from '../contracts/input.ts';
import type { LiveInputController, LiveInputView } from './live-input.ts';
import { useLiveInput } from './live-input.ts';

type EditorPanelProps = Readonly<{
  hasDocument: boolean;
  input: InputSnapshot | null;
  controller: LiveInputController;
  onRetryBegin: () => void;
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

/** External transactions and mapping states under which the textarea is quiesced. */
function quiesced(input: InputSnapshot | null, view: LiveInputView): boolean {
  if (view.flushing || view.resolving) return true;
  if (!input) return false;
  if (input.mappingStatus !== 'ready') return true;
  return input.phase === 'saving' || input.phase === 'leaving' || input.phase === 'closed'
    || input.phase === 'history' || input.phase === 'resolving' || input.phase === 'beginning';
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

  let body;
  if (!props.hasDocument) {
    body = <div className="editor-empty">
      <p>打开 HTML 文件或目录后，在预览中点击一段文字即可开始校对。</p>
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
    body = <div className="editor-empty">
      <div className="panel-error" role="alert">
        <p>{view.error?.message}</p>
        {view.error?.detail && <p className="hint">{view.error.detail}</p>}
        <div className="editor-actions">
          <button type="button" className="btn sm" onClick={props.onRetryBegin}>重试</button>
          <button type="button" className="btn sm" onClick={() => props.controller.discardFailed()}>放弃</button>
        </div>
      </div>
    </div>;
  } else {
    const frozen = quiesced(input, view);
    body = <div className="editor-body">
      <div className="field">
        <span className="field-label">文件原文</span>
        <div className="orig-text">{view.beginText}</div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={inputId}>草稿文字</label>
        <textarea
          id={inputId}
          className="draft-input"
          value={view.localText}
          disabled={frozen}
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
          {frozen ? <span className="badge-pending">输入已暂停</span> : statusBadge(view, input)}
          <span className="hint">停顿约 0.25 秒自动更新预览；换行显示取决于原页面样式。</span>
        </div>
      </div>
      {view.intentPending && <p className="hint" role="status">已选中另一段文字，完成当前输入后将切换。</p>}
      {view.error && <div className="panel-error" role="alert">
        <p>{view.error.message}</p>
        {view.error.detail !== '' && <textarea className="error-detail" readOnly value={view.error.detail} aria-label="错误详情" />}
        <div className="editor-actions">
          {view.phase === 'failed' && <button type="button" className="btn sm" onClick={() => props.controller.retry()}>重试</button>}
          {view.phase === 'failed' && <button type="button" className="btn sm" onClick={() => props.controller.discardFailed()}>放弃本地输入</button>}
        </div>
      </div>}
      <div className="editor-actions">
        <button type="button" className="btn" disabled={!view.canRestore || view.busy || view.composing || frozen}
          onClick={() => props.controller.restoreParagraph()}>
          还原为文件原文
        </button>
        <span className="hint">还原本段为文件原文会形成一条可撤销的草稿记录，不会写回原文件。</span>
      </div>
    </div>;
  }

  return (
    <div className="editor-inner">
      <div className="panel-head"><h2>校稿</h2></div>
      {body}
    </div>
  );
}
