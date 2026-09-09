import { readFile } from 'node:fs/promises';
import { prepareCompactionResolution } from '../../src/main/storage/resolve-compaction.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';

const [privateRoot, entry, stage] = process.argv.slice(2);
const source = await openSaveSource(entry, await readFile(entry));
const plan = await prepareCompactionResolution(privateRoot, source, () => {}, async step => {
  if (step === stage) { process.send({ stage }); await new Promise(() => {}); }
});
const result = await plan.commit();
throw Error(`Expected resolution hook was not reached: ${result.code}`);
