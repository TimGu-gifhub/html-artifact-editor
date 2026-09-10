import type { CleanupState } from '../contracts/record-cleanup.ts';
import { Dialog } from './dialog.tsx';
import { cleanupBlockerText, cleanupPhaseText, cleanupResultView } from './cleanup-flow.ts';
import type { CleanupBlocker } from './cleanup-flow.ts';
import { formatBytes } from './util.ts';

type CleanupDialogProps = Readonly<{
  /** Main-published cleanup state; null on a Main build without it. */
  cleanup: CleanupState | null;
  /** Why a check cannot start right now (null = allowed). */
  blocker: CleanupBlocker | null;
  /** The shared busy guard currently runs this dialog's check. */
  checking: boolean;
  /** Flow error bound to this dialog opening. */
  error: string | null;
  onCheck: () => void;
  onClose: () => void;
}>;

/**
 * 方案 B 清理本地记录对话框：只解释清理范围并发起唯一命令；清单确认与删除
 * 决定都在 Main 原生对话框中进行（取消为默认）。结果区只按 Main 发布的
 * cleanup.result 展示，cancelled 安静保留，unknown/requiresReview/带警告
 * 的完成不提供直接重试。
 */
export function CleanupDialog(props: CleanupDialogProps) {
  const { cleanup } = props;
  const phase = cleanup?.phase ?? 'idle';
  const summary = cleanup?.summary ?? null;
  const view = cleanupResultView(cleanup);
  const inFlight = props.checking || phase !== 'idle';
  const canCheck = !inFlight && props.blocker === null && (view === null || view.canCheckAgain);
  const phaseText = cleanupPhaseText(phase);
  return (
    <Dialog title="清理本地记录" wide locked={inFlight} onClose={props.onClose}
      footer={<>
        <button type="button" className="btn" data-autofocus={canCheck ? undefined : true}
          disabled={inFlight} onClick={props.onClose}>关闭</button>
        <button type="button" className="btn primary" data-autofocus={canCheck ? true : undefined}
          disabled={!canCheck} onClick={props.onCheck}>
          {props.checking ? '正在检查…' : view?.canCheckAgain ? '重新检查' : '开始检查'}
        </button>
      </>}>
      <p>检查本应用在这台电脑上保存的全部本地记录：草稿、撤销历史与应用备份。清理会永久删除这些记录，删除后无法恢复；源 HTML、CSS、PDF 与项目文件不会被修改。</p>
      <p className="hint">本对话框只说明情况并发起检查；最终确认在系统对话框中进行（默认为取消），确认前不会删除任何内容。</p>
      {cleanup === null && <p className="hint">当前主进程未提供清理状态。</p>}
      {props.blocker === 'has-document' && (
        <p role="status">当前已打开文档。清理需要在打开文档之前进行：请重启应用后、打开文档前再清理。当前文档与修改保持不变，不会被丢弃。</p>
      )}
      {props.blocker !== null && props.blocker !== 'has-document' && (
        <p className="hint" role="status">{cleanupBlockerText(props.blocker)}</p>
      )}
      {phaseText && <p role="status">{phaseText}</p>}
      {phase === 'reviewing' && summary && (
        <p className="hint">
          {summary.resuming
            ? `上次已确认的原清单共 ${summary.records} 条记录（其中部分记录可能已在上次被删除）：${summary.sessions} 个校稿会话，其中 ${summary.unsavedDrafts} 份含修改的草稿记录、${summary.backups} 份应用备份，共 ${formatBytes(summary.bytes)}。确认只会继续删除其中仍然存在且核验一致的剩余记录。`
            : `检查发现 ${summary.records} 条记录：${summary.sessions} 个校稿会话，其中 ${summary.unsavedDrafts} 份含修改的草稿记录、${summary.backups} 份应用备份，共 ${formatBytes(summary.bytes)}。`}
          含修改的草稿记录可能包含尚未保存的修改。
        </p>
      )}
      {props.error && <div className="panel-error" role="alert"><p>{props.error}</p></div>}
      {view && (
        <div className={view.tone === 'error' ? 'panel-error' : undefined}
          role={view.tone === 'error' || view.tone === 'warn' ? 'alert' : 'status'}>
          <p>{view.text}</p>
          {view.detail && <p className="hint">{view.detail}</p>}
          {view.code && <p className="hint">代码：{view.code}</p>}
          {!view.canCheckAgain && <p className="hint">此状态下不提供直接重试；请以本页说明与主进程保留的证据为准。</p>}
        </div>
      )}
    </Dialog>
  );
}
