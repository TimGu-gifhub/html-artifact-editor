import type { Session, WebContents, WebPreferences } from 'electron';

export const securePreferences: Readonly<WebPreferences> = Object.freeze({
  nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
  allowRunningInsecureContent: false, experimentalFeatures: false, navigateOnDragDrop: false,
  safeDialogs: true, disableDialogs: true, spellcheck: false, plugins: false, enableWebSQL: false,
});

export function lockContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault(); callback('');
  });
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

export function lockSession(session: Session): void {
  session.enableNetworkEmulation({ offline: true });
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.on('will-download', (event) => event.preventDefault());
  session.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'));
  session.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  session.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  session.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback(''); });
}

// WebRTC can use sockets outside URL loading; file inputs have a native chooser.
// Install before loading ANY user bytes, in every new frame (including about:blank).
// This code contains no bridge and cannot read/write files or call Main.
const documentGuard = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport',
    'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker', 'print']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
  const prevent = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stop = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  for (const name of ['dragenter', 'dragover', 'drop']) {
    globalThis.addEventListener(name, event => { prevent(event); stop(event); }, true);
  }
})()`;

export async function installDocumentGuard(contents: WebContents, revoke: () => boolean): Promise<void> {
  const debug = contents.debugger;
  debug.on('detach', () => {
    // Losing the document-start hook must never silently enable a weaker preview.
    if (!revoke()) return; // Normal teardown already revoked; never re-enter native close.
    queueMicrotask(() => {
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    });
  });
  debug.attach('1.3');
  await debug.sendCommand('Page.enable');
  await debug.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true });
  await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: documentGuard, runImmediately: true,
  });
}

export async function verifyDocumentGuard(contents: WebContents): Promise<void> {
  // A runtime/protocol mismatch is a load failure, not a reason to skip protection.
  // A fresh WebContents has no execution context until its first navigation.
  const result = await contents.debugger.sendCommand('Runtime.evaluate', {
    expression: "Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')?.configurable === false && typeof RTCPeerConnection === 'undefined'",
    returnByValue: true,
  });
  if (result.result?.value !== true) throw new Error('PREVIEW_GUARD_FAILED');
}
