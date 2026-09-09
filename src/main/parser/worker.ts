import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import type { SourceIdentity, SourceLineage } from '../../core/parser/source-index.ts';
import { createHistorySource } from '../../core/history/source.ts';

const input = workerData as { bytes: Uint8Array; identity: SourceIdentity; lineage?: SourceLineage };
try {
  const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const source = input.lineage === undefined ? createSourceIndex(input.bytes, input.identity, hash)
    : createHistorySource(input.bytes, input.identity, input.lineage, hash).source;
  parentPort!.postMessage({ ok: true, source });
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  parentPort!.postMessage({ ok: false, error: /^[A-Z_]+$/.test(code) ? code : 'SOURCE_PARSE_FAILED' });
}
