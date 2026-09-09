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
import type { ProjectChoices } from './project-choice.ts';
import type { OriginalSaver } from '../storage/original.ts';
import type { DraftStore } from './document.ts';

type SessionPorts = WorkspaceDecisions & Readonly<{
  chooseOpen: () => Promise<string | undefined>;
  bounds: () => Rectangle;
  reportError: (code: string) => void;
  onHostStep?: (step: PreviewHostStep) => void;
  projectChoices?: ProjectChoices;
  saveOriginal?: OriginalSaver;
  checkpoints?: DraftStore;
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
  }, ports.saveOriginal, ports.checkpoints);
  let bridge: ReturnType<typeof createWorkspaceBridge>;
  let guard: ReturnType<typeof bindWorkspaceWindow>;
  try {
    bridge = createWorkspaceBridge(window.webContents, workspace, ports.chooseOpen, ports.chooseCopy, projectChoices);
    try { guard = bindWorkspaceWindow(window, workspace, ports.reportError); }
    catch (error) { bridge.close(); throw error; }
  } catch (error) { host.dispose(); void workspace.dispose(); throw error; }
  let disposed = false;
  let reloading = false;
  const onClosed = (): void => { void dispose().catch(() => {
    try { ports.reportError('DOCUMENT_CLEANUP_REQUIRED'); } catch { /* Teardown cannot force a write. */ }
  }); };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true; bridge.close(); guard.detach(); window.removeListener('closed', onClosed);
    try { host.dispose(); } finally { await workspace.dispose(); }
  };
  window.once('closed', onClosed);
  return Object.freeze({
    workspace, host,
    get connected() { return bridge.active; },
    get closing() { return guard.closing; },
    // Main-only recovery of a revoked UI renderer. It cannot change the current
    // document, reconnect an old page token, Apply, Save or discard pending text.
    async reloadUI(): Promise<void> {
      if (disposed || window.isDestroyed() || reloading || !bridge.closed) throw new Error('EDITOR_RELOAD_UNAVAILABLE');
      reloading = true;
      try {
        bridge = createWorkspaceBridge(window.webContents, workspace, ports.chooseOpen, ports.chooseCopy, projectChoices);
        await window.loadURL(EDITOR_URL);
      } catch (error) { bridge.close(); throw error; }
      finally { reloading = false; }
    },
    dispose,
  });
}
