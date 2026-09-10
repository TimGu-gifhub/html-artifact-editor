import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { digest } from '../../src/platform/storage-files.ts';
const [privateRoot, entry, candidatePath, stage, restoreId] = process.argv.slice(2);
const source = await openSaveSource(entry, await readFile(entry)); const bytes = await readFile(candidatePath);
const store = await createSavePreparationStore(privateRoot, async step => {
  if (step === stage) { process.send({ kind: 'paused', stage }); await new Promise(() => {}); }
}, await createWindowsReplacer(resolve('out/native/ReplaceHelper.exe')));
const value = restoreId ? await store.prepareRestore(source, restoreId)
  : await store.prepare(source, { bytes, baseHash: source.baseHash, resultHash: digest(bytes) });
if (value.status !== 'prepared') throw new Error(value.code);
process.send({ kind: 'unexpected', result: await value.commit() });
