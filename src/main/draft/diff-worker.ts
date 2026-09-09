import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import { buildSourceDiff } from '../../core/patch/source-diff.ts';
import { createHistorySource } from '../../core/history/source.ts';

try {
  const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const source = workerData.lineage === undefined ? createSourceIndex(workerData.bytes, workerData.identity, hash)
    : createHistorySource(workerData.bytes, workerData.identity, workerData.lineage, hash).source;
  parentPort!.postMessage({ ok: true, diff: buildSourceDiff(source, workerData.candidate, hash) });
} catch {
  parentPort!.postMessage({ ok: false });
}
