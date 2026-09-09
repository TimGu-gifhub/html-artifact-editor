import type { BrowserWindow, Rectangle } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';
import { createPreviewHost } from '../../platform/preview-host.ts';
import { projectDialogs } from '../../platform/project-dialog.ts';
import type { PreviewHostStep } from '../../platform/preview-host.ts';
import { createWorkspaceBridge } from './bridge.ts';
import { createWorkspace } from './controller.ts';
import type { Workspace, WorkspaceDecisions } from './controller.ts';
import { prepareDocument } from './document.ts';
import { bindWorkspaceWindow } from './window.ts';
import type { WindowCloseOptions } from './window.ts';
import type { ProjectChoices } from './project-choice.ts';
import type { OriginalSaver } from '../storage/original.ts';
import type { DraftStore } from './document.ts';
import type { BackupRestorer } from '../storage/backups.ts';

export type SessionPorts = WorkspaceDecisions & WindowCloseOptions & Readonly<{
  chooseOpen: () => Promise<string | undefined>;
  bounds: () => Rectangle;
  reportError: (code: string) => void;
  onHostStep?: (step: PreviewHostStep) => void;
  projectChoices?: ProjectChoices;
  saveOriginal?: OriginalSaver;
  checkpoints?: DraftStore;
  backups?: BackupRestorer;
}>;

// Install before loading the trusted UI. A single workspace owns the current
// document for IPC, native Preview attachment and the OS close guard.
export function createWorkspaceSession(window: BrowserWindow, outputRoot: string, ports: SessionPorts) {
  if (window.isDestroyed()) throw new Error('EDITOR_BRIDGE_UNAVAILABLE');
  const projectChoices = ports.projectChoices ?? projectDialogs(window);
  let workspace: Workspace;
  const host = createPreviewHost(window, ports.bounds, (code) => {
    workspace?.invalidateActivation(); ports.reportError(code);
  }, ports.onHostStep);
  workspace = createWorkspace(outputRoot, ports, prepareDocument, (next, previous) => {
    if (host.current !== (previous?.preview.view ?? null)) throw new Error('DOCUMENT_ACTIVATION_UNKNOWN');
    return host.swap(next?.preview.view ?? null);
  }, ports.saveOriginal, ports.checkpoints, ports.backups);
  let bridge: ReturnType<typeof createWorkspaceBridge>;
  const bridges = new Set<ReturnType<typeof createWorkspaceBridge>>();
  const connect = () => {
    const value = createWorkspaceBridge(window.webContents, workspace, ports.chooseOpen, ports.chooseCopy, projectChoices);
    bridges.add(value); return value;
  };
  let guard: ReturnType<typeof bindWorkspaceWindow>;
  try {
    bridge = connect();
    try { guard = bindWorkspaceWindow(window, workspace, ports.reportError, ports); }
    catch (error) { bridge.close(); throw error; }
  } catch (error) { host.dispose(); void workspace.dispose(); throw error; }
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let reloading = false;
  const onClosed = (): void => { void dispose().catch(() => {
    try { ports.reportError('DOCUMENT_CLEANUP_REQUIRED'); } catch { /* Teardown cannot force a write. */ }
  }); };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true; bridge.close(); guard.detach(); window.removeListener('closed', onClosed);
    disposal = (async () => {
      try { host.dispose(); } finally {
        const ended = await Promise.allSettled([workspace.dispose(), ...Array.from(bridges, value => value.drain())]);
        const failed = ended.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        bridges.clear();
      }
    })();
    return disposal;
  };
  window.once('closed', onClosed);
  return Object.freeze({
    workspace, host,
    get connected() { return bridge.active; },
    get closing() { return guard.closing; },
    requestClose: guard.requestClose,
    // Main-only recovery of a revoked UI renderer. It cannot change the current
    // document, reconnect an old page token, Apply, Save or discard pending text.
    async reloadUI(): Promise<void> {
      if (disposed || window.isDestroyed() || reloading || !bridge.closed) throw new Error('EDITOR_RELOAD_UNAVAILABLE');
      reloading = true;
      try {
        const previous = bridge;
        bridge = connect();
        void previous.drain().then(() => { bridges.delete(previous); });
        await window.loadURL(EDITOR_URL);
      } catch (error) { bridge.close(); throw error; }
      finally { reloading = false; }
    },
    dispose,
  });
}
