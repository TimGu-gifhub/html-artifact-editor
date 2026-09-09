import { app, BrowserWindow } from 'electron';
import type { Event } from 'electron';
import type { PersistentWorkspaceSession } from './persistent-session.ts';

export type QuitResult = 'quitting' | 'cancelled' | 'blocked';
let installed = false;

// Main installs one process-lifetime coordinator before accepting UI actions.
// It has no renderer command, force-exit path or automatic Save/recovery action.
export function bindWorkspaceQuit(window: BrowserWindow, runtime: PersistentWorkspaceSession, reportError: (code: string) => void) {
  if (!app.isReady() || window.isDestroyed()) throw new Error('APP_QUIT_UNAVAILABLE');
  if (installed) throw new Error('APP_QUIT_ALREADY_BOUND');
  installed = true;
  let pending: Promise<QuitResult> | null = null;
  let ready = false;
  const otherWindows = (): boolean => BrowserWindow.getAllWindows().some(value => value !== window && !value.isDestroyed());
  const safeToQuit = (): boolean => ready && window.isDestroyed() && !otherWindows();
  const requestQuit = (): Promise<QuitResult> => {
    if (pending) return pending;
    pending = Promise.resolve().then(async (): Promise<QuitResult> => {
      if (otherWindows()) throw new Error('APP_QUIT_OTHER_WINDOWS');
      if (!window.isDestroyed()) {
        const result = await runtime.requestClose();
        if (result !== 'closed') return result;
      }
      // Also joins forced window destruction. Never infer completion merely
      // from a closed window or skip a previously failed cleanup promise.
      await runtime.dispose();
      if (!window.isDestroyed() || otherWindows()) throw new Error('APP_QUIT_OTHER_WINDOWS');
      ready = true;
      app.quit();
      return 'quitting';
    }).catch((error: unknown): QuitResult => {
      ready = false;
      try { reportError(error instanceof Error && error.message === 'APP_QUIT_OTHER_WINDOWS'
        ? error.message : 'APP_QUIT_CLEANUP_REQUIRED'); } catch { /* Keep process and evidence. */ }
      return 'blocked';
    }).finally(() => { pending = null; });
    return pending;
  };
  const onQuit = (event: Event): void => {
    if (safeToQuit()) return;
    event.preventDefault(); void requestQuit();
  };
  // Subscribing prevents Electron's default exit when the last window closes.
  // before-quit handles explicit app/menu quit, which can omit window-all-closed.
  app.on('before-quit', onQuit);
  app.on('will-quit', onQuit);
  app.on('window-all-closed', () => { void requestQuit(); });
  return Object.freeze({ requestQuit, get busy() { return pending !== null; }, get ready() { return ready; } });
}
