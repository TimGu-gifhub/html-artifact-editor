import { app } from 'electron';
let ownedProfile: string | null = null;

// Persistent editing uses one Main process per Electron user-data profile.
// Electron owns the OS lock for the process lifetime; no stale PID/time unlock.
export function requireEditorProfile(): void {
  const profile = app.getPath('userData');
  if (app.hasSingleInstanceLock()) {
    if (ownedProfile !== null && ownedProfile !== profile) throw new Error('DRAFT_PROFILE_IN_USE');
  } else if (!app.requestSingleInstanceLock()) throw new Error('DRAFT_PROFILE_IN_USE');
  ownedProfile = profile;
}
