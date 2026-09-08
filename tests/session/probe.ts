import { contextBridge, ipcRenderer } from 'electron';
import '../../src/preload/ui.ts';
import { WORKSPACE_COMMAND, WORKSPACE_CONNECT } from '../../src/contracts/workspace-editor.ts';

// Test-only malformed-envelope probe. Never included in default build targets.
contextBridge.exposeInMainWorld('workspaceProbe', {
  connect: (...args: unknown[]) => ipcRenderer.invoke(WORKSPACE_CONNECT, ...args),
  request: (...args: unknown[]) => ipcRenderer.invoke(WORKSPACE_COMMAND, ...args),
});
