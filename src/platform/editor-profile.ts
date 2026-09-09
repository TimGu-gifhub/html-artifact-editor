import { app } from 'electron';

// Persistent editing uses one Main process per Electron user-data profile.
// Electron owns the OS lock for the process lifetime; no stale PID/time unlock.
export function requireEditorProfile(): void {
  if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock()) throw new Error('DRAFT_PROFILE_IN_USE');
}
