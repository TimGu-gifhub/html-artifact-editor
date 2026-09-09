import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import { createPatchEngine } from '../../core/patch/engine.ts';
import { createHistorySource } from '../../core/history/source.ts';

try {
  const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const source = workerData.lineage === undefined ? createSourceIndex(workerData.bytes, workerData.identity, hash)
    : createHistorySource(workerData.bytes, workerData.identity, workerData.lineage, hash).source;
  const engine = createPatchEngine(source, hash, workerData.patches);
  if (engine.candidate.resultHash !== workerData.resultHash) throw new Error('DRAFT_BASE_MISMATCH');
  parentPort!.postMessage({ ok: true, candidate: engine.apply(workerData.change) });
} catch (error) {
  const message = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'DRAFT_PREPARE_FAILED';
  parentPort!.postMessage({ ok: false, error: message });
}
