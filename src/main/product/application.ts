import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { BrowserWindow, dialog, session } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';
import type { PanelMode } from '../../contracts/desktop.ts';
import type { BackupReview } from '../../contracts/backup.ts';
import type { LeaveReview } from '../../contracts/workspace.ts';
import type { InterruptionSummary } from '../../contracts/interruption.ts';
import { registerBundledContent } from '../bundled-content.ts';
import { lockContents, securePreferences } from '../preview/security.ts';
import { createPersistentWorkspaceSession } from '../workspace/persistent-session.ts';
import type { PersistentSessionPorts, PersistentWorkspaceSession } from '../workspace/persistent-session.ts';
import { bindWorkspaceQuit } from '../workspace/quit.ts';
import { createDesktopController } from './desktop.ts';
import type { InterruptionPorts } from './interruption.ts';
import { interruptionPickerTitle, interruptionPrompt } from './interruption-copy.ts';
import type { CleanupSummary } from '../../contracts/record-cleanup.ts';
import type { RecordCleanupPorts } from './record-cleanup.ts';
import { cleanupPrompt } from './cleanup-copy.ts';

// Test overrides are Main-only native decisions. Production controls use the
// same factory, assets, preload, Workspace, parser and Windows transaction.
export type ProductChoices = Readonly<{
  open?: () => Promise<string | undefined>;
  copy?: (name: string) => Promise<string | undefined>;
  pdf?: (name: string) => Promise<string | undefined>;
  review?: (value: LeaveReview) => Promise<unknown>;
  backup?: (value: BackupReview) => Promise<unknown>;
  project?: PersistentSessionPorts['projectChoices'];
  interruptionSource?: () => Promise<string | undefined>;
  interruptionReview?: (value: InterruptionSummary) => Promise<unknown>;
  cleanupReview?: (value: CleanupSummary) => Promise<unknown>;
}>;
export async function createProductApplication(outputRoot: string,
  options: Readonly<{ visible?: boolean; bindQuit?: boolean; choices?: ProductChoices; initialPanel?: PanelMode;
    onStorageStep?: PersistentSessionPorts['onStorageStep']; onInterruptionStep?: InterruptionPorts['onStep']; onRecordCleanupStep?: RecordCleanupPorts['onStep'] }> = {}) {
  const uiSession = session.fromPartition(`hae-product-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', resolve(outputRoot, 'ui'));
  const window = new BrowserWindow({ title: 'HTML Artifact Editor', width: 1440, height: 900,
    minWidth: 960, minHeight: 640, show: false,
    webPreferences: { ...securePreferences, session: uiSession, preload: resolve(outputRoot, 'preload/ui/index.cjs'),
      additionalArguments: ['--hae-product'] } });
  window.setMenu(null); lockContents(window.webContents);
  let runtime: PersistentWorkspaceSession | undefined;
  const current = () => { if (!runtime) throw new Error('DESKTOP_UNAVAILABLE'); return runtime; };
  const choices = options.choices ?? {};
  const saveDialog = async (name: string, extension: 'html' | 'pdf'): Promise<string | undefined> => {
    const root = runtime?.workspace.current?.entry;
    const selected = await dialog.showSaveDialog(window, { title: extension === 'pdf' ? '导出 PDF（请使用新文件名）' : '另存草稿（不覆盖已有文件）',
      defaultPath: root ? join(dirname(root), name) : name,
      filters: [{ name: extension === 'pdf' ? 'PDF 文档' : 'HTML 文档', extensions: extension === 'pdf' ? ['pdf'] : ['html', 'htm'] }] });
    return selected.canceled ? undefined : selected.filePath;
  };
  const desktop = createDesktopController(window, outputRoot, current, choices.pdf ?? (name => saveDialog(name, 'pdf')), {
    chooseSource: choices.interruptionSource ?? (async () => {
      const selected = await dialog.showOpenDialog(window, { title: interruptionPickerTitle,
        properties: ['openFile'], filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }] });
      return selected.canceled ? undefined : selected.filePaths[0];
    }),
    review: choices.interruptionReview ?? (async value => {
      const copy = interruptionPrompt(value);
      const selected = await dialog.showMessageBox(window, { type: 'warning', title: copy.title,
        message: copy.message, detail: copy.detail, buttons: [copy.cancel, copy.confirm],
        defaultId: 0, cancelId: 0, noLink: true });
      return { reviewId: value.reviewId, decision: selected.response === 1
        ? value.kind === 'save' ? 'keep-current' : 'continue-cleanup' : 'cancel' };
    }),
    ...(options.onInterruptionStep ? { onStep: options.onInterruptionStep } : {}),
  }, {
    review: choices.cleanupReview ?? (async value => {
      const copy = cleanupPrompt(value);
      const selected = await dialog.showMessageBox(window, { type: 'warning', title: copy.title, message: copy.message,
        detail: copy.detail, buttons: [copy.cancel, copy.confirm], defaultId: 0, cancelId: 0, noLink: true });
      return { reviewId: value.reviewId, decision: selected.response === 1 ? 'clear-records' : 'cancel' };
    }),
    ...(options.onRecordCleanupStep ? { onStep: options.onRecordCleanupStep } : {}),
  }, options.initialPanel);
  const reportError = (code: string): void => {
    desktop.report(code);
    if (!runtime?.connected || runtime.workspace.snapshot().phase === 'disposed') {
      dialog.showErrorBox('需要检查当前会话', `本次操作未完成，会话及已有记录保留。\n${code}`);
    }
  };
  try {
    runtime = await createPersistentWorkspaceSession(window, outputRoot, {
      chooseOpen: choices.open ?? (async () => {
        const selected = await dialog.showOpenDialog(window, { title: '打开 HTML', properties: ['openFile'], filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }] });
        return selected.canceled ? undefined : selected.filePaths[0];
      }),
      chooseCopy: choices.copy ?? (name => saveDialog(basename(name).replace(/\.html?$/iu, '') + '-草稿.html', 'html')),
      ...(choices.project ? { projectChoices: choices.project } : {}),
      review: choices.review ?? (async value => {
        const selected = await dialog.showMessageBox(window, { type: 'question', title: '保留当前修改',
          message: `${value.currentName} 还有未保存的修改`,
          detail: `${value.changeCount} 处草稿。${value.hasUnappliedInput ? '还有待处理输入。' : ''}另存草稿会创建独立 HTML；如需保存原文件，请取消后使用工作台的复核保存。`,
          buttons: ['取消', '另存草稿后继续', '放弃修改'], defaultId: 0, cancelId: 0, noLink: true });
        return { reviewId: value.reviewId, decision: selected.response === 1 ? 'save-copy' : selected.response === 2 ? 'discard' : 'cancel' };
      }),
      reviewBackup: choices.backup ?? (async value => {
        const selected = await dialog.showMessageBox(window, { type: 'warning', title: '恢复整份备份',
          message: `恢复 ${value.currentName} 的所选备份？`, detail: '会先备份当前文件，再恢复整份旧 HTML；恢复后开始新的干净历史。',
          buttons: ['取消', '确认恢复备份'], defaultId: 0, cancelId: 0, noLink: true });
        return { reviewId: value.reviewId, decision: selected.response === 1 ? 'restore' : 'cancel' };
      }),
      bounds: desktop.bounds, reportError, bridgeExtension: desktop.extension, transferPresentation: desktop.transferPresentation,
      ...(options.onStorageStep ? { onStorageStep: options.onStorageStep } : {}),
      beforeRequestClose: desktop.beforeClose, disposeAuxiliary: desktop.dispose,
    });
    desktop.watch();
    if (options.initialPanel === 'inline') await desktop.prepareInline();
    const quit = options.bindQuit === false ? null : bindWorkspaceQuit(window, runtime, reportError, desktop.ownedWindows);
    window.once('closed', () => { uiSession.protocol.unhandle('editor'); });
    await window.loadURL(EDITOR_URL);
    if (options.visible !== false) window.show();
    return Object.freeze({ window, runtime, desktop, quit });
  } catch (error) {
    if (runtime) await runtime.dispose(); else await desktop.dispose();
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}
