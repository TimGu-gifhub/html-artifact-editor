import { app } from 'electron';
import { requireEditorProfile } from '../../src/platform/editor-profile.ts';
import { seedCheckpoint } from './seed.ts';

const [mode, profile, entry, privateRoot] = process.argv.slice(2);
if (!profile || !['hold', 'probe', 'seed'].includes(mode ?? '')) throw Error('Invalid recovery child arguments');
app.setPath('userData', profile); app.enableSandbox();
app.on('before-quit', event => event.preventDefault());
void app.whenReady().then(async () => {
  try { requireEditorProfile(); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'DRAFT_PROFILE_IN_USE') throw error;
    process.stdout.write(`${JSON.stringify({ state: 'blocked' })}\n`); app.exit(0); return;
  }
  if (mode === 'seed') {
    if (!entry || !privateRoot) throw Error('Missing seed paths');
    const result = await seedCheckpoint(entry, privateRoot);
    process.stdout.write(`${JSON.stringify({ state: 'seeded', ...result })}\n`);
  } else process.stdout.write(`${JSON.stringify({ state: 'acquired' })}\n`);
  if (mode === 'probe') app.exit(0);
  else setInterval(() => {}, 1000); // Parent forcibly terminates the holder.
}).catch(error => { console.error(error); app.exit(1); });
