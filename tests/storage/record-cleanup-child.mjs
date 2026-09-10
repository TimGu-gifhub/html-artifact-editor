import { prepareRecordCleanup } from '../../src/main/storage/record-cleanup.ts';
const [path, stage] = process.argv.slice(2);
const plan = await prepareRecordCleanup(path, () => {}, async step => {
  if (step === stage) { process.send({ stage }); await new Promise(() => {}); }
});
process.send({ unexpected: await plan.commit() });
