import { ipcRenderer } from 'electron';
import { BOOTSTRAP_CHANNEL, CONTRACT_VERSION } from '../contracts/bootstrap.ts';
import { isPreviewIdentity, PREVIEW_ARGUMENT, PREVIEW_READY_CHANNEL } from '../contracts/preview.ts';

// Runs in the isolated world. Deliberately exposes nothing to the page world.
const argument = process.argv.find((value) => value.startsWith(PREVIEW_ARGUMENT));
if (argument) {
  const identity: unknown = JSON.parse(argument.slice(PREVIEW_ARGUMENT.length));
  if (!isPreviewIdentity(identity)) throw new Error('INVALID_PREVIEW_IDENTITY');
  ipcRenderer.send(PREVIEW_READY_CHANNEL, {
    ...identity, sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, readOnly: true,
  });
} else {
  ipcRenderer.send(BOOTSTRAP_CHANNEL, {
    contractVersion: CONTRACT_VERSION, surface: 'preview',
    sandboxed: process.sandboxed, contextIsolated: process.contextIsolated,
  });
}
