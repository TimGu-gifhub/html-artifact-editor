import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SourceIdentity, SourceIndex, SourceLineage } from '../../core/parser/source-index.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';

// Parsing runs away from Electron Main with a deadline, cancellation and a heap limit.
export function parseSource(outputRoot: string, bytes: Uint8Array, identity: SourceIdentity,
  signal: AbortSignal = new AbortController().signal, lineage?: SourceLineage): Promise<SourceIndex> {
  if (signal.aborted) return Promise.reject(new Error('SOURCE_PARSE_CANCELLED'));
  if (bytes.length > MAX_SOURCE_BYTES) return Promise.reject(new Error('SOURCE_SIZE_LIMIT'));
  return new Promise((resolveSource, reject) => {
    const worker = new Worker(resolve(outputRoot, 'parser-worker/index.cjs'), {
      workerData: { bytes: new Uint8Array(bytes), identity, lineage },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let finished = false;
    const finish = (source?: SourceIndex, error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      // Do not settle until the worker has actually stopped, including on cancellation.
      void worker.terminate().then(() => {
        if (!source) { reject(new Error(error ?? 'SOURCE_PARSE_FAILED')); return; }
        const snapshot = new Uint8Array(source.bytes);
        const origin = source.lineage ? new Uint8Array(source.lineage.originBytes) : undefined;
        const proof = source.lineage && origin ? Object.freeze({ get originBytes() { return new Uint8Array(origin); },
          values: Object.freeze(source.lineage.values.map(value => Object.freeze({ ...value }))),
        }) : undefined;
        for (const node of source.tree) {
          if (node.kind === 'element') { node.attributes.forEach(Object.freeze); Object.freeze(node.attributes); }
          Object.freeze(node);
        }
        source.nodes.forEach(Object.freeze);
        Object.freeze(source.identity); Object.freeze(source.tree); Object.freeze(source.nodes); Object.freeze(source.parseErrors);
        resolveSource(Object.freeze({ ...source, ...(proof ? { lineage: proof } : {}), get bytes() { return new Uint8Array(snapshot); } }));
      }, () => reject(new Error('SOURCE_PARSE_FAILED')));
    };
    const abort = (): void => finish(undefined, 'SOURCE_PARSE_CANCELLED');
    const timeout = setTimeout(() => finish(undefined, 'SOURCE_PARSE_TIMEOUT'), 5000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('error', () => finish(undefined, 'SOURCE_PARSE_FAILED'));
    worker.once('exit', () => { if (!finished) finish(undefined, 'SOURCE_PARSE_FAILED'); });
    worker.once('message', (result: { ok: boolean; source?: SourceIndex; error?: string }) => {
      if (result.ok && result.source) finish(result.source); else finish(undefined, result.error);
    });
  });
}
