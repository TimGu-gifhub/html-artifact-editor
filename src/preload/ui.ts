import { contextBridge, ipcRenderer } from 'electron';
import { BOOTSTRAP_CHANNEL, CONTRACT_VERSION } from '../contracts/bootstrap.ts';
import type { EditorBootstrap } from '../contracts/bootstrap.ts';

const bootstrap: EditorBootstrap = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  stage: 'toolchain',
});
contextBridge.exposeInMainWorld('haeBootstrap', bootstrap);
ipcRenderer.send(BOOTSTRAP_CHANNEL, {
  contractVersion: CONTRACT_VERSION,
  surface: 'ui',
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
});
