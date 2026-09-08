import { resolve } from 'node:path';
import { app, BaseWindow, dialog } from 'electron';
import { registerSchemes } from '../src/main/application.ts';
import { PreviewController } from '../src/main/preview/project-preview.ts';
import { selectPreviewFile } from '../src/platform/project-dialog.ts';

// Developer verification entry only; no product UI, editing or save IPC.
registerSchemes();
app.enableSandbox();
let window: BaseWindow | undefined;
const previews = new PreviewController(resolve(__dirname, '..'));
void app.whenReady().then(async () => {
  const entry = await selectPreviewFile();
  if (!entry) { app.quit(); return; }
  const mode = process.argv.includes('--interactive') ? 'interactive' : 'proofread';
  const preview = await previews.open(entry, mode);
  window = new BaseWindow({ width: 1100, height: 760, minWidth: 640, minHeight: 480,
    title: mode === 'proofread' ? '校稿预览 · 页面脚本禁用 · 只读验证' : '交互预览 · 本地脚本 · 只读验证' });
  window.contentView.addChildView(preview.view);
  const resize = (): void => {
    const bounds = window!.getContentBounds();
    preview.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  resize(); window.on('resize', resize);
  window.on('closed', () => { window = undefined; void previews.close().finally(() => app.quit()); });
}).catch(async () => {
  await previews.close();
  dialog.showErrorBox('预览未打开', '文件读取、资源授权或隔离初始化失败。源文件未修改。请检查独立项目目录和 UTF-8 HTML。');
  app.exit(1);
});
