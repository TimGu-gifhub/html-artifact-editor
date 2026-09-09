import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { buildSourceDiff } from '../../src/core/patch/source-diff.ts';
import { prepareSourceDiff } from '../../src/main/draft/source-diff.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = createSourceIndex(Buffer.from('<!doctype html><p>A</p>'), { projectId: 'diff', documentId: 'worker', generation: 1 }, hash);
const candidate = createPatchEngine(source, hash).apply({ identity: source.identity, baseHash: source.baseHash,
  nodeId: source.nodes[0].nodeId, expectedText: 'A', newText: 'B' });
const expected = buildSourceDiff(source, candidate, hash);
async function worker(script) {
  const results = resolve('test-results'); await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(results, 'diff-worker-')); await mkdir(join(root, 'diff-worker'));
  await writeFile(join(root, 'diff-worker/index.cjs'), script); return root;
}

test('Main validates worker slices, ranges and encoding flags, rejecting fabricated same-length text, hidden replacements or wrong line-ending metadata', async () => {
  for (const diff of [{ ...expected, changes: [{ ...expected.changes[0], after: { ...expected.changes[0].after, text: 'C' } }] },
    { ...expected, baseHash: 'b'.repeat(64) }, { ...expected, changes: [] },
    { ...expected, changes: [{ ...expected.changes[0], nodeId: 'n999' }] },
    ...[{ lineEnding: 'crlf' }, { mixedLineEndings: true }, { leadingLfCompensation: true }]
      .map(flags => ({ ...expected, changes: [{ ...expected.changes[0], ...flags }] }))]) {
    const root = await worker(`require('node:worker_threads').parentPort.postMessage({ok:true,diff:${JSON.stringify(diff)}});`);
    await assert.rejects(prepareSourceDiff(root, source, candidate, new AbortController().signal), /SOURCE_DIFF_FAILED/);
  }
});

test('a missing/crashed Diff worker and an already cancelled read report failure without mutating the frozen candidate', async () => {
  const root = await worker('throw Error("test crash");'); const bytes = candidate.bytes;
  await assert.rejects(prepareSourceDiff(root, source, candidate, new AbortController().signal), /SOURCE_DIFF_FAILED/);
  await assert.rejects(prepareSourceDiff(join(root, 'missing'), source, candidate, new AbortController().signal), /SOURCE_DIFF_FAILED/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareSourceDiff(root, source, candidate, aborted.signal), /SOURCE_DIFF_CANCELLED/);
  assert.deepEqual(candidate.bytes, bytes);
});

test('the Diff worker deadline terminates a nonresponding worker and preserves the original and candidate bytes', async () => {
  const root = await worker('setInterval(()=>{},1000);');
  await assert.rejects(prepareSourceDiff(root, source, candidate, new AbortController().signal), /SOURCE_DIFF_TIMEOUT/);
  assert.equal(Buffer.from(source.bytes).toString(), '<!doctype html><p>A</p>'); assert.equal(Buffer.from(candidate.bytes).toString(), '<!doctype html><p>B</p>');
});
