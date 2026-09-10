import type { InterruptionState } from '../contracts/interruption.ts';
import { Dialog } from './dialog.tsx';
import { interruptionBlockerText, interruptionPhaseText, interruptionResultView } from './interruption-flow.ts';
import type { InterruptionBlocker } from './interruption-flow.ts';

type InterruptionDialogProps = Readonly<{
  /** Main-published interruption state; null on a Main build without it. */
  interruption: InterruptionState | null;
  /** Why a check cannot start right now (null = allowed). */
  blocker: InterruptionBlocker | null;
  /** The shared busy guard currently runs this dialog's check. */
  checking: boolean;
  /** Flow error bound to this dialog opening. */
  error: string | null;
  onCheck: () => void;
  onClose: () => void;
}>;

/**
 * 方案 B 中断检查对话框：只解释检查范围并发起唯一命令；选择原文件与确认都
 * 在 Main 原生对话框中进行。结果区只按 Main 发布的 interruption.result
 * 展示，cancelled 安静保留，unknown/requiresReview 不提供直接重试。
 */
export function InterruptionDialog(props: InterruptionDialogProps) {
  const { interruption } = props;
  const phase = interruption?.phase ?? 'idle';
  const summary = interruption?.summary ?? null;
  const view = interruptionResultView(interruption);
  const inFlight = props.checking || phase !== 'idle';
  const canCheck = !inFlight && props.blocker === null && (view === null || view.canCheckAgain);
  const phaseText = interruptionPhaseText(phase);
  return (
    <Dialog title="检查上次中断" wide locked={inFlight} onClose={props.onClose}
      footer={<>
        <button type="button" className="btn" data-autofocus={canCheck ? undefined : true}
          disabled={inFlight} onClick={props.onClose}>关闭</button>
        <button type="button" className="btn primary" data-autofocus={canCheck ? true : undefined}
          disabled={!canCheck} onClick={props.onCheck}>
          {props.checking ? '正在检查…' : view?.canCheckAgain ? '重新选择原文件并检查' : '选择原文件并检查'}
        </button>
      </>}>
      <p>检查上次退出时是否留下未完成的保存或旧记录清理。检查前需要在系统对话框中重新选择原 HTML 文件；确认前只读取，不修改任何文件。</p>
      <p className="hint">本检查不会重放旧草稿、不恢复备份，也不会保存当前修改；如需恢复之前的修改，请之后使用“恢复草稿记录”。</p>
      {interruption === null && <p className="hint">当前主进程未提供中断检查状态。</p>}
      {props.blocker === 'has-document' && (
        <p role="status">当前已打开文档。检查需要在打开文档之前进行：请重启应用后、打开文档前再检查。当前文档与修改保持不变，不会被丢弃。</p>
      )}
      {props.blocker !== null && props.blocker !== 'has-document' && (
        <p className="hint" role="status">{interruptionBlockerText(props.blocker)}</p>
      )}
      {phaseText && <p role="status">{phaseText}</p>}
      {phase === 'reviewing' && summary && <p className="hint">正在检查：{summary.name}</p>}
      {props.error && <div className="panel-error" role="alert"><p>{props.error}</p></div>}
      {view && (
        <div className={view.tone === 'error' ? 'panel-error' : undefined}
          role={view.tone === 'error' || view.tone === 'warn' ? 'alert' : 'status'}>
          <p>{view.text}</p>
          {view.detail && <p className="hint">{view.detail}</p>}
          {view.code && <p className="hint">代码：{view.code}</p>}
          {!view.canCheckAgain && <p className="hint">记录与证据已保留；此状态下不提供直接重试。</p>}
        </div>
      )}
    </Dialog>
  );
}
