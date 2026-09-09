import { app } from 'electron';
import { dirname, relative } from 'node:path';
import { requireEditorProfile } from '../../platform/editor-profile.ts';
import { createWindowsRecoveryGuard } from '../../platform/windows-recovery-guard.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import { prepareSaveResolution } from './resolve-save.ts';

// The helper path comes from the trusted installation. Neither it nor the
// private root/source path is accepted from a renderer or transaction journal.
export async function prepareSaveRecovery(path: string, source: SaveSource, helperPath: string, onStep?: (step: string) => Promise<void>) {
  const profile = app.getPath('userData');
  if (relative(profile, dirname(path)) !== '') throw new Error('SAVE_RECOVERY_PROFILE_ROOT_MISMATCH');
  requireEditorProfile();
  const guard = await createWindowsRecoveryGuard(helperPath);
  return prepareSaveResolution(path, source, () => {
    if (!app.hasSingleInstanceLock() || relative(profile, app.getPath('userData')) !== '') throw new Error('SAVE_RECOVERY_PROFILE_IN_USE');
  }, guard, onStep);
}
