import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/ui.ts';
import { EDITOR_COMMAND, EDITOR_CONNECT } from '../../src/contracts/editor.ts';

// Test build only: bypass public argument checks to attack the real Main gate.
contextBridge.exposeInMainWorld('editorProbe', {
  connect: (...args: unknown[]) => ipcRenderer.invoke(EDITOR_CONNECT, ...args),
  request: (...args: unknown[]) => ipcRenderer.invoke(EDITOR_COMMAND, ...args),
});
