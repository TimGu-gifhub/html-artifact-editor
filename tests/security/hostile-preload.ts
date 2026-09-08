import { contextBridge, ipcRenderer } from 'electron';

// ONLY in the separate security harness, never in application build targets.
contextBridge.exposeInMainWorld('securityProbe', {
  send: (channel: string, payload: unknown): void => ipcRenderer.send(channel, payload),
  invoke: (channel: string, payload: unknown): Promise<unknown> => ipcRenderer.invoke(channel, payload),
});
