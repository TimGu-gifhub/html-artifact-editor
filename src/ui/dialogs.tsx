import type { WorkspaceDiff } from '../contracts/source-diff.ts';
import type { PdfOptions, PdfPreview } from '../contracts/desktop.ts';
import type { WorkspaceRecoveryCatalog } from '../contracts/recovery.ts';
import type { BackupSummary, WorkspaceBackupCatalog } from '../contracts/backup.ts';
import type { ResourceDiagnostics } from '../contracts/resources.ts';
import { useState } from 'react';
import { Dialog } from './dialog.tsx';
import { describeCode, formatBytes, formatTime, recoveryRestorable, recoveryStatusText, resourceReasonText } from './util.ts';
import { DEFAULT_RECOVERY_SOURCE_MODE } from './recovery-flow.ts';
import type { RecoverySourceMode } from './recovery-flow.ts';

export type SaveError = Readonly<{ message: string; code: string | null; conflict: boolean }>;

type SaveDiffDialogProps = Readonly<{
  diff: WorkspaceDiff;
  saving: boolean;
  error: SaveError | null;
  /** 仅当 Main 允许另存副本时才提供“另存草稿”。 */
  canSaveCopy: boolean;
  onConfirmSave: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
}>;

/** 保存前的源 Diff 复核：纯文本渲染，绝不作为 HTML 注入。 */
export function SaveDiffDialog(props: SaveDiffDialogProps) {
  const { diff } = props;
  // 保存事务在途时禁用取消/复制/确认全部按钮（关闭由 Dialog locked 保护）；
  // 结果未知或已提交待重建（conflict）后确认按钮不得诱导盲重试。
  const confirmDisabled = props.saving || props.error?.conflict === true;
  return (
    <Dialog title="保存前复核源 Diff" wide locked={props.saving} onClose={props.onClose}
      footer={<>
        {props.error && props.canSaveCopy && (
          <button type="button" className="btn" disabled={props.saving} onClick={props.onSaveCopy}>另存草稿…</button>
        )}
        <button type="button" className="btn" disabled={props.saving} onClick={props.onClose}>取消</button>
        <button type="button" className="btn primary" data-autofocus disabled={confirmDisabled} onClick={props.onConfirmSave}>
          {props.saving ? '正在保存…' : '确认保存'}
        </button>
      </>}>
      <p>共 {diff.changes.length} 处文字修改；源文件 {formatBytes(diff.baseSize)}，候选 {formatBytes(diff.candidateSize)}。</p>
      <div className="diff-list">
        {diff.changes.map((change, index) => (
          <div className="change-item" key={index}>
            <div className="ci-head">修改 {index + 1}</div>
            <div className="ci-diff">
              <span className="ci-old">{change.before.text || '（空）'}</span>
              <span className="ci-new">{change.after.text || '（空）'}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="hint">保存会先自动备份原文件，再把以上修改写回 HTML。其余字节保持不变。</p>
        {props.error && <div className="panel-error" role="alert">
        <p>{props.error.message}</p>
        {props.error.code && <p className="hint">代码：{props.error.code}</p>}
        {props.error.conflict && <p className="hint">{props.canSaveCopy
          ? '可另存草稿保留修改，或取消后核对文件内容；不要盲目重试保存。'
          : '请取消后核对文件内容，不要盲目重试保存。'}</p>}
      </div>}
    </Dialog>
  );
}

type PdfDialogProps = Readonly<{
  pdf: PdfPreview | null;
  pdfBusy: boolean;
  /** 脚本只读预览：不能从草稿生成新 PDF；已有快照的查看/导出不写回 HTML。 */
  readonly?: boolean;
  /** Same document but a newer draft exists. */
  stale: boolean;
  /** False when the frozen PDF's documentId differs from the current document:
   *  Main rebuilds current.id on every successful Save, so this may be the
   *  same file's new baseline — treat it as an earlier snapshot. */
  belongsToCurrent: boolean;
  options: PdfOptions;
  error: string | null;
  onOptions: (next: PdfOptions) => void;
  onCreate: () => void;
  onShow: (id: string) => void;
  onExport: (id: string) => void;
  onDiscard: () => void;
  onClose: () => void;
}>;

export function PdfDialog(props: PdfDialogProps) {
  const { options, pdf } = props;
  return (
    <Dialog title="PDF 打印预览" onClose={props.onClose}
      footer={<>
        <button type="button" className="btn" onClick={props.onClose}>关闭</button>
        <button type="button" className="btn primary" data-autofocus disabled={props.pdfBusy || props.readonly}
          title={props.readonly ? '脚本只读预览不能生成草稿 PDF；返回静态校稿后再生成。' : undefined}
          onClick={props.onCreate}>
          {props.pdfBusy ? '正在生成…' : pdf ? '重新生成' : '生成预览'}
        </button>
      </>}>
      <fieldset className="pdf-options">
        <legend>纸张</legend>
        <label><input type="radio" name="pdf-paper" checked={options.paper === 'A4'}
          onChange={() => props.onOptions({ ...options, paper: 'A4' })} /> A4</label>
        <label><input type="radio" name="pdf-paper" checked={options.paper === 'Letter'}
          onChange={() => props.onOptions({ ...options, paper: 'Letter' })} /> Letter</label>
      </fieldset>
      <fieldset className="pdf-options">
        <legend>选项</legend>
        <label><input type="checkbox" checked={options.landscape}
          onChange={event => props.onOptions({ ...options, landscape: event.target.checked })} /> 横向</label>
        <label><input type="checkbox" checked={options.background}
          onChange={event => props.onOptions({ ...options, background: event.target.checked })} /> 打印背景</label>
      </fieldset>
      <p className="hint">PDF 从当前已确认的草稿生成；打印与导出都不会写回 HTML 文件。若原页面定义了 @page 打印规则，纸张与方向可能以页面规则为准。</p>
      {props.readonly && <p className="hint">脚本只读预览不能生成草稿 PDF；返回静态校稿后再生成。</p>}
      {props.error && <div className="panel-error" role="alert"><p>{props.error}</p></div>}
      {pdf && <div className="pdf-current">
        <p><strong>{pdf.name}</strong>（{formatBytes(pdf.size)}）</p>
        {!props.belongsToCurrent && <p className="pdf-dirty">此 PDF 是先前生成的快照，请重新生成以核对当前文档。</p>}
        {props.belongsToCurrent && <p className={pdf.dirty ? 'pdf-dirty' : 'hint'}>
          {pdf.dirty ? '此 PDF 包含未保存草稿。' : '此 PDF 对应已保存的版本。'}
        </p>}
        {props.belongsToCurrent && props.stale && <p className="pdf-dirty">文档在此 PDF 生成后又有新修改，内容可能已过期。</p>}
        <div className="editor-actions">
          <button type="button" className="btn sm" onClick={() => props.onShow(pdf.id)}>显示预览</button>
          <button type="button" className="btn sm" onClick={() => props.onExport(pdf.id)}>导出…</button>
          <button type="button" className="btn sm" onClick={props.onDiscard}>丢弃此 PDF</button>
        </div>
      </div>}
    </Dialog>
  );
}

type RecoveryDialogProps = Readonly<{
  catalog: WorkspaceRecoveryCatalog | null;
  loading: boolean;
  /** Session id of the accepted in-flight restore; also locks the dialog. */
  busySession: string | null;
  error: string | null;
  onRestore: (sessionId: string, sourceMode: RecoverySourceMode) => void;
  onClose: () => void;
}>;

export function RecoveryDialog(props: RecoveryDialogProps) {
  const { catalog } = props;
  // Fresh choice per dialog mount; cancellation/errors keep it (no unmount).
  const [sourceMode, setSourceMode] = useState<RecoverySourceMode>(DEFAULT_RECOVERY_SOURCE_MODE);
  const busy = props.busySession !== null;
  return (
    <Dialog title="恢复草稿记录" wide locked={busy} onClose={props.onClose}
      footer={<button type="button" className="btn" data-autofocus disabled={busy} onClick={props.onClose}>关闭</button>}>
      <p className="hint">选择恢复来源和一条记录后，需要在系统对话框中重新选择以确认权限。</p>
      <fieldset className="pdf-options" aria-label="恢复来源">
        <legend>恢复来源</legend>
        <label><input type="radio" name="recovery-source" checked={sourceMode === 'file'} disabled={busy}
          onChange={() => setSourceMode('file')} /> HTML 文件</label>
        <label><input type="radio" name="recovery-source" checked={sourceMode === 'directory'} disabled={busy}
          onChange={() => setSourceMode('directory')} /> 项目目录</label>
      </fieldset>
      <p className="hint">{sourceMode === 'directory'
        ? '项目目录：先选择项目根目录，再选择其中的 HTML 入口文件；适合页面引用上级目录共享资源（如 ../assets）的情况。'
        : 'HTML 文件：以所选 HTML 所在文件夹为资源根目录；如需加载上级目录中的共享资源，请选择项目目录。'}</p>
      {props.loading && <p role="status">正在读取记录…</p>}
      {props.error && <div className="panel-error" role="alert"><p>{props.error}</p></div>}
      {catalog && catalog.entries.length === 0 && !props.loading && <p>没有可恢复的草稿记录。</p>}
      {catalog && catalog.entries.length > 0 && <div className="record-list">
        {catalog.entries.map(entry => (
          <div className="record-item" key={entry.sessionId}>
            <div className="record-main">
              <span className="record-name">{entry.name}</span>
              <span className="hint">{recoveryStatusText(entry.status)}{entry.active ? ' · 当前打开' : ''}{entry.historyAvailable ? ' · 含历史' : ''}</span>
            </div>
            <button type="button" className="btn sm"
              disabled={busy || entry.active || !recoveryRestorable(entry.status)}
              onClick={() => props.onRestore(entry.sessionId, sourceMode)}>
              {props.busySession === entry.sessionId ? '正在恢复…' : '恢复…'}
            </button>
          </div>
        ))}
      </div>}
      {catalog?.reviewRequired && <p className="hint">存在需要人工检查的记录，未在此列出详细信息。</p>}
    </Dialog>
  );
}

type BackupsDialogProps = Readonly<{
  catalog: WorkspaceBackupCatalog | null;
  loading: boolean;
  busy: boolean;
  /** 脚本只读预览：仍可列出备份，但整份替换须返回静态校稿后进行。 */
  readonly?: boolean;
  error: string | null;
  onRestore: (backup: BackupSummary) => void;
  onClose: () => void;
}>;

export function BackupsDialog(props: BackupsDialogProps) {
  const { catalog } = props;
  return (
    <Dialog title="备份与恢复" onClose={props.onClose}
      footer={<button type="button" className="btn" data-autofocus onClick={props.onClose}>关闭</button>}>
      <p className="hint">恢复备份会先备份当前文件，并替换整个 HTML；需要在系统对话框中确认。</p>
      {props.readonly && <p className="hint">脚本只读预览下不能恢复备份；返回静态校稿后再恢复。</p>}
      {props.loading && <p>正在读取备份…</p>}
      {props.error && <div className="panel-error" role="alert"><p>{props.error}</p></div>}
      {catalog && catalog.entries.length === 0 && <p>此文档还没有备份。</p>}
      {catalog && catalog.entries.length > 0 && <div className="record-list">
        {catalog.entries.map((backup, index) => (
          <div className="record-item" key={index}>
            <div className="record-main">
              <span className="record-name">{formatTime(backup.createdAt)}</span>
              <span className="hint">{formatBytes(backup.size)}</span>
            </div>
            <button type="button" className="btn sm" disabled={props.busy || props.readonly}
              title={props.readonly ? '返回静态校稿后再恢复备份。' : undefined}
              onClick={() => props.onRestore(backup)}>
              恢复此备份…
            </button>
          </div>
        ))}
      </div>}
      {catalog?.reviewRequired && <p className="hint">存在需要人工检查的备份，未在此列出详细信息。</p>}
    </Dialog>
  );
}

export function ResourcesDialog(props: Readonly<{ resources: ResourceDiagnostics; onClose: () => void }>) {
  const { resources } = props;
  return (
    <Dialog title="资源诊断" wide onClose={props.onClose}
      footer={<button type="button" className="btn" data-autofocus onClick={props.onClose}>关闭</button>}>
      {resources.items.length === 0 && <p>没有被阻断或失败的资源。</p>}
      {resources.items.length > 0 && <>
        <p>以下外部资源未加载（不影响文字校对）：</p>
        <div className="record-list">
          {resources.items.map(item => (
            <div className="record-item" key={item.id}>
              <div className="record-main">
                <span className="record-name resource-target">{item.target}</span>
                <span className="hint">{item.resourceType} · {resourceReasonText(item.reason)}</span>
              </div>
            </div>
          ))}
        </div>
        {resources.truncated && <p className="hint">列表已截断，仅显示前 {resources.items.length} 条。</p>}
      </>}
    </Dialog>
  );
}
