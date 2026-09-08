import { resolve } from 'node:path';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { createApplication, registerSchemes } from './application.ts';
import { configureLifecycle } from '../platform/window.ts';

registerSchemes();
app.enableSandbox();
let mainWindow: BrowserWindow | undefined;
let opening = false;
const openWindow = async (): Promise<void> => {
  if (opening || (mainWindow && !mainWindow.isDestroyed())) return;
  opening = true;
  try {
    const runtime = await createApplication(resolve(__dirname, '..'));
    mainWindow = runtime.window;
    mainWindow.once('closed', () => { mainWindow = undefined; });
    console.log('HTML Artifact Editor: bundled scaffold ready.');
  } catch (error) {
    console.error('Application startup failed.', error);
    app.exit(1);
  } finally {
    opening = false;
  }
};
void app.whenReady().then(async () => {
  configureLifecycle(openWindow);
  await openWindow();
});
