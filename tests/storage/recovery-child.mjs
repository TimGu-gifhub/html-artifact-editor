import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';

// Parent supplies only self-created test paths and kills this actual Main process
// at the announced restoration boundary. No user file or page invokes this helper.
const [privateRoot, entry, transactionId, stage] = process.argv.slice(2);
const source = await openSaveSource(entry, await readFile(entry));
const store = await createSavePreparationStore(privateRoot, async step => {
  if (step === stage) { process.send({ stage }); await new Promise(() => {}); }
}, await createWindowsReplacer(resolve('out/native/ReplaceHelper.exe')));
const value = await store.prepareRestore(source, transactionId);
if (value.status !== 'prepared') throw new Error(value.code);
const result = await value.commit();
throw new Error(`Recovery child missed barrier: ${result.status}`);
