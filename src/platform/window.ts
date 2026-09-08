import { app, Menu } from 'electron';
import type { BrowserWindow, WebContentsView } from 'electron';

export function configureLifecycle(createWindow: () => Promise<unknown>): void {
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'windowMenu' }])
    : null);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => { void createWindow(); });
}

export function attachPreview(window: BrowserWindow, preview: WebContentsView): void {
  const contents = preview.webContents;
  window.contentView.addChildView(preview);
  const resize = (): void => {
    const { width, height } = window.getContentBounds();
    preview.setBounds({ x: 0, y: 210, width, height: Math.max(0, height - 210) });
  };
  resize();
  window.on('resize', resize);
  window.on('closed', () => {
    // Electron does not automatically destroy child WebContentsView contents.
    if (!contents.isDestroyed()) contents.close();
  });
}
