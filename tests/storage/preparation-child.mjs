import { readFile } from 'node:fs/promises';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

// The parent owns every path inside its ignored fixture. This process is killed
// at a real filesystem boundary to test restart inspection and retained locks.
const [storePath, entry, candidatePath, stopAt] = process.argv.slice(2);
try {
  const source = await openSaveSource(entry, await readFile(entry));
  const candidate = await readFile(candidatePath);
  const store = await createSavePreparationStore(storePath, async (step) => {
    if (step === stopAt) {
      process.send({ kind: 'stage', step });
      await new Promise(() => {});
    }
  });
  const result = await store.prepare(source, { bytes: candidate, baseHash: source.baseHash, resultHash: digest(candidate) });
  process.send({ kind: 'result', status: result.status, code: result.code, transactionId: result.transactionId });
  if (result.status === 'prepared') await result.cancel();
  process.exit(0);
} catch (error) { process.send({ kind: 'error', error: String(error) }); process.exit(1); }
