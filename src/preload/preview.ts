import { ipcRenderer } from 'electron';
import { BOOTSTRAP_CHANNEL, CONTRACT_VERSION } from '../contracts/bootstrap.ts';

// Runs in the isolated world. Deliberately exposes nothing to the page world.
ipcRenderer.send(BOOTSTRAP_CHANNEL, {
  contractVersion: CONTRACT_VERSION,
  surface: 'preview',
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
});
