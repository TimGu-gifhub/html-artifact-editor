import { resolve } from 'node:path';
import { app, BaseWindow, dialog } from 'electron';
import { registerSchemes } from '../src/main/application.ts';
import { PreviewController } from '../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../src/main/preview/source-mapping.ts';
import { selectPreviewFile } from '../src/platform/project-dialog.ts';
import { projectDialogs } from '../src/platform/project-dialog.ts';
import { chooseProjectDirectory } from '../src/main/workspace/project-choice.ts';

// Developer verification entry only; no product UI, editing or save IPC.
registerSchemes();
app.enableSandbox();
let window: BaseWindow | undefined;
const previews = new PreviewController(resolve(__dirname, '..'));
void app.whenReady().then(async () => {
  const entry = process.argv.includes('--directory')
    ? await chooseProjectDirectory(projectDialogs(), new AbortController().signal, [app.getPath('userData'), app.getPath('sessionData')])
    : await selectPreviewFile();
  if (!entry) { app.quit(); return; }
  const mode = process.argv.includes('--interactive') ? 'interactive' : 'proofread';
  const preview = await previews.open(entry, mode);
  const reportResources = (): void => console.log(JSON.stringify({ resources: preview.diagnosticState() }));
  reportResources(); preview.onDiagnostics(reportResources);
  window = new BaseWindow({ width: 1100, height: 760, minWidth: 640, minHeight: 480,
    title: mode === 'proofread' ? '校稿预览 · 页面脚本禁用 · 只读验证' : '交互预览 · 本地脚本 · 只读验证' });
  window.contentView.addChildView(preview.view);
  const resize = (): void => {
    const bounds = window!.getContentBounds();
    preview.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  resize(); window.on('resize', resize);
  window.on('closed', () => { window = undefined; void previews.close().finally(() => app.quit()); });
  if (mode === 'proofread') {
    try {
      const mapping = await createPreviewMapping(resolve(__dirname, '..'), preview);
      console.log(JSON.stringify({ mapping: mapping.status, reason: mapping.reason,
        verifiedTextNodes: mapping.source.nodes.filter((node) => node.editable).length }));
      mapping.onEvent((event) => {
        if (event.kind === 'selection' && event.nodeId) {
          const node = mapping.source.nodes.find((item) => item.nodeId === event.nodeId)!;
          console.log(JSON.stringify({ nodeId: node.nodeId, generation: mapping.identity.preview.generation,
            revision: event.revision, startByte: node.startByte, endByte: node.endByte }));
        } else console.log(JSON.stringify({ mapping: event.kind }));
      });
    } catch {
      console.log('Source mapping unavailable; preview remains read-only.');
    }
  }
}).catch(async () => {
  await previews.close();
  dialog.showErrorBox('预览未打开', '文件读取、资源授权或隔离初始化失败。源文件未修改。请检查独立项目目录和 UTF-8 HTML。');
  app.exit(1);
});
