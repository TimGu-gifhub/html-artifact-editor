import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createSourceIndex } from '../../core/parser/source-index.ts';
import type { SourceIdentity } from '../../core/parser/source-index.ts';

const input = workerData as { bytes: Uint8Array; identity: SourceIdentity };
try {
  const source = createSourceIndex(input.bytes, input.identity, (bytes) => createHash('sha256').update(bytes).digest('hex'));
  parentPort!.postMessage({ ok: true, source });
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  parentPort!.postMessage({ ok: false, error: /^[A-Z_]+$/.test(code) ? code : 'SOURCE_PARSE_FAILED' });
}
