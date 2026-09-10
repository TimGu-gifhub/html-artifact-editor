import { resolve } from 'node:path';
import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { registerSchemes } from './application.ts';
import { createProductApplication } from './product/application.ts';

registerSchemes(); app.enableSandbox();
let mainWindow: BrowserWindow | undefined;
const focus = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
};
app.on('second-instance', focus); app.on('activate', focus);
void app.whenReady().then(async () => {
  const product = await createProductApplication(resolve(__dirname, '..'));
  mainWindow = product.window;
  console.log('HTML Artifact Editor: product workspace ready.');
}).catch((error: unknown) => {
  const known = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'APPLICATION_STARTUP_FAILED';
  console.error('Application startup failed:', known);
  dialog.showErrorBox('HTML Artifact Editor 启动失败', `未能打开工作台，已有文件和恢复记录保持原样。\n${known}`);
  // Any installed coordinator still joins its accepted work. Never force-exit
  // around a retained document or failed cleanup barrier.
  app.quit();
});
