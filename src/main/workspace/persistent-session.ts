import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { basename, dirname, resolve } from 'node:path';
import { requireEditorProfile } from '../../platform/editor-profile.ts';
import { checkedDirectory } from '../../platform/storage-files.ts';
import { createWindowsReplacer } from '../../platform/windows-replacement.ts';
import { createSavePreparationStore } from '../storage/preparation.ts';
import { createDraftCheckpointStore } from '../storage/checkpoints.ts';
import { createOriginalSaver } from '../storage/original.ts';
import { createBackupRestorer } from '../storage/backups.ts';
import { draftOwnership } from '../storage/draft-ownership.ts';
import { createWorkspaceSession } from './session.ts';
import type { SessionPorts } from './session.ts';

export const WORKSPACE_STORAGE_NAME = 'workspace-records';
export type PersistentSessionPorts = Omit<SessionPorts, 'saveOriginal' | 'checkpoints' | 'backups' | 'waitForSave' | 'beforeClose'> & Readonly<{
  onStorageStep?: (kind: 'save' | 'checkpoint', step: string) => Promise<void>;
}>;
let owner: symbol | null = null;

// Application-level composition, installed by Main before loading its trusted
// UI. No renderer-selected directory, service override or per-launch namespace.
export async function createPersistentWorkspaceSession(window: BrowserWindow, outputRoot: string, ports: PersistentSessionPorts) {
  if (!app.isReady() || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('EDITOR_BRIDGE_UNAVAILABLE');
  if (process.platform !== 'win32') throw new Error('SAVE_PLATFORM_UNSUPPORTED');
  // As with createWorkspaceSession, Main supplies a window constructed with
  // securePreferences and the installed UI preload; bind before any navigation.
  if (window.webContents.getURL()) throw new Error('EDITOR_WINDOW_ALREADY_LOADED');
  if (owner) throw new Error('EDITOR_RUNTIME_ACTIVE');
  const claim = Symbol(); owner = claim;
  let session: ReturnType<typeof createWorkspaceSession> | undefined;
  try {
    requireEditorProfile();
    const profilePath = app.getPath('userData'); const sessionPath = app.getPath('sessionData');
    const assertProfile = (): void => {
      if (!app.hasSingleInstanceLock() || app.getPath('userData') !== profilePath || app.getPath('sessionData') !== sessionPath) {
        throw new Error('DRAFT_PROFILE_IN_USE');
      }
    };
    // Only create these two explicit direct children under verified parents.
    // A file, link, changed directory or inaccessible existing store is an error;
    // never choose another directory to escape its recovery evidence.
    const parent = await checkedDirectory(dirname(profilePath));
    const directory = async (root: Awaited<ReturnType<typeof checkedDirectory>>, name: string) => {
      try { return await root.directory(name); }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; return root.directory(name, true); }
    };
    const profile = await directory(parent, basename(profilePath)); assertProfile();
    const records = await directory(profile, WORKSPACE_STORAGE_NAME); assertProfile();
    const storageOwnership = draftOwnership(records.identityChain.map(value => `${value.dev}:${value.ino}`).join('/'));
    const step = async (kind: 'save' | 'checkpoint', value: string): Promise<void> => {
      assertProfile(); await ports.onStorageStep?.(kind, value); assertProfile();
    };
    const saves = await createSavePreparationStore(records.path, value => step('save', value),
      await createWindowsReplacer(resolve(outputRoot, 'native/ReplaceHelper.exe')));
    const checkpoints = await createDraftCheckpointStore(records.path, value => step('checkpoint', value), saves);
    const backups = createBackupRestorer(saves);
    assertProfile(); await records.verify();
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('EDITOR_BRIDGE_UNAVAILABLE');
    if (window.webContents.getURL()) throw new Error('EDITOR_WINDOW_ALREADY_LOADED');
    session = createWorkspaceSession(window, outputRoot, { ...ports,
      saveOriginal: createOriginalSaver(saves), checkpoints, backups, waitForSave: true, beforeClose: () => dispose() });
    const active = session;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      window.removeListener('closed', onClosed);
      disposal = (async () => {
        await active.dispose();
        const state = active.workspace.snapshot();
        if (state.cleanupPending || state.lastSave?.requiresReview || state.lastDeparture?.requiresReview
          || state.current?.persistence?.cleanupPending || state.current?.input?.draftPhase === 'uncertain'
          || state.current?.input?.lastCopy?.status === 'unknown') throw new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED');
        // Main maintenance or a document whose cleanup failed may still own the
        // store even after the window disappeared. Never release around it.
        const release = storageOwnership.claimMaintenance();
        try { await records.verify(); assertProfile(); if (owner === claim) owner = null; }
        finally { release(); }
      })();
      return disposal;
    };
    const onClosed = (): void => { void dispose().catch(() => {
      try { ports.reportError('EDITOR_RUNTIME_CLEANUP_REQUIRED'); } catch { /* Keep ownership and evidence. */ }
    }); };
    window.once('closed', onClosed);
    return Object.freeze({ workspace: active.workspace, host: active.host,
      get connected() { return active.connected; }, get closing() { return active.closing; },
      reloadUI: active.reloadUI, requestClose: active.requestClose, attachEditor: active.attachEditor, dispose,
      // Main-only recovery/maintenance access, never serialized through IPC.
      storage: Object.freeze({ directory: records.path, saves, checkpoints, backups }),
    });
  } catch (error) {
    if (session) {
      try { await session.dispose(); }
      catch { throw new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED'); }
      if (session.workspace.snapshot().cleanupPending) throw new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED');
    }
    if (owner === claim) owner = null;
    throw error;
  }
}
export type PersistentWorkspaceSession = Awaited<ReturnType<typeof createPersistentWorkspaceSession>>;
