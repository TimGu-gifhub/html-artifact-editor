import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BrowserWindow, WebContentsView, ipcMain, protocol, session } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import { BOOTSTRAP_CHANNEL, isBootstrapReady } from '../contracts/bootstrap.ts';
import type { BootstrapReady } from '../contracts/bootstrap.ts';
import { attachPreview } from '../platform/window.ts';
import { registerBundledContent } from './bundled-content.ts';
import { lockContents, securePreferences } from './preview/security.ts';

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged(['editor', 'artifact'].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  })));
}

function waitForBootstrap(
  contents: WebContents, url: string, surface: BootstrapReady['surface'],
): Promise<BootstrapReady> {
  return new Promise((resolveReady, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      ipcMain.removeListener(BOOTSTRAP_CHANNEL, onReady);
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('preload-error', onError);
    };
    const onReady = (event: IpcMainEvent, payload: unknown): void => {
      if (event.sender !== contents || event.sender.session !== contents.session || event.senderFrame !== contents.mainFrame
        || event.senderFrame.url !== url || !isBootstrapReady(payload)
        || payload.surface !== surface) return;
      cleanup();
      resolveReady(payload);
    };
    const onDestroyed = (): void => { cleanup(); reject(new Error(`${surface}: destroyed during startup`)); };
    const onError = (): void => { cleanup(); reject(new Error(`${surface}: preload failed`)); };
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error(`${surface}: startup timed out`));
    }, 15_000);
    ipcMain.on(BOOTSTRAP_CHANNEL, onReady);
    contents.once('destroyed', onDestroyed);
    contents.once('preload-error', onError);
  });
}

export async function createApplication(outputRoot: string, visible = true) {
  const id = randomUUID();
  const uiSession = session.fromPartition(`hae-ui-${id}`, { cache: false });
  const previewSession = session.fromPartition(`hae-preview-${id}`, { cache: false });
  const uiURL = 'editor://app/index.html';
  const previewURL = `artifact://${id}/index.html`;
  await registerBundledContent(uiSession, 'editor', 'app', resolve(outputRoot, 'ui'));
  await registerBundledContent(previewSession, 'artifact', id, resolve(outputRoot, 'preview'));
  const window = new BrowserWindow({
    title: 'HTML Artifact Editor · 工具链验证',
    width: 1100, height: 760, minWidth: 960, minHeight: 640,
    show: false,
    webPreferences: {
      ...securePreferences, session: uiSession,
      preload: resolve(outputRoot, 'preload/ui/index.cjs'),
    },
  });
  const preview = new WebContentsView({
    webPreferences: {
      // The engine is needed for the isolated preload. Bundled Preview page
      // scripts are denied by the protocol's script-src 'none' CSP.
      ...securePreferences, session: previewSession,
      preload: resolve(outputRoot, 'preload/preview/index.cjs'),
    },
  });
  lockContents(window.webContents);
  lockContents(preview.webContents);
  attachPreview(window, preview);
  window.once('closed', () => {
    uiSession.protocol.unhandle('editor');
    previewSession.protocol.unhandle('artifact');
  });
  try {
    const [uiReady, previewReady] = await Promise.all([
      waitForBootstrap(window.webContents, uiURL, 'ui'),
      waitForBootstrap(preview.webContents, previewURL, 'preview'),
      window.loadURL(uiURL),
      preview.webContents.loadURL(previewURL),
    ]);
    if (visible) window.show();
    return { window, preview, uiReady, previewReady, uiURL, previewURL };
  } catch (error) {
    window.destroy();
    throw error;
  }
}
