import { app } from 'electron';
import { dirname, relative } from 'node:path';
import { requireEditorProfile } from '../../platform/editor-profile.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import { prepareCompactionResolution } from './resolve-compaction.ts';

// Main supplies its private directory and a newly authorized source. No path,
// generic unlock or deletion capability is exposed to Preview or trusted IPC.
export function prepareCompactionRecovery(path: string, source: SaveSource, onStep?: (step: string) => Promise<void>) {
  const profile = app.getPath('userData');
  if (relative(profile, dirname(path)) !== '') throw new Error('DRAFT_PROFILE_ROOT_MISMATCH');
  requireEditorProfile();
  return prepareCompactionResolution(path, source, () => {
    if (!app.hasSingleInstanceLock() || relative(profile, app.getPath('userData')) !== '') throw new Error('DRAFT_PROFILE_IN_USE');
  }, onStep);
}
