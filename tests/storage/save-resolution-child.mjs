import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareSaveResolution } from '../../src/main/storage/resolve-save.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsRecoveryGuard } from '../../src/platform/windows-recovery-guard.ts';

const [privateRoot, entry, stage] = process.argv.slice(2);
const source = await openSaveSource(entry, await readFile(entry));
const plan = await prepareSaveResolution(privateRoot, source, () => {}, await createWindowsRecoveryGuard(resolve('out/native/ReplaceHelper.exe')), async step => {
  if (step === stage) { process.send({ stage }); await new Promise(() => {}); }
});
throw Error(`Expected resolution hook not reached: ${JSON.stringify(await plan.commit('keep-current'))}`);
