import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDraftPersistence } from '../../src/main/draft/persistence.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { digest } from '../../src/platform/storage-files.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><!-- keep -->');
const source = createSourceIndex(original, { projectId: 'test', documentId: 'draft', generation: 1 }, digest);
const node = source.nodes.find(node => node.decodedText === 'A & 😀');
const candidate = text => createPatchEngine(source, digest).apply({ identity: source.identity, baseHash: source.baseHash,
  nodeId: node.nodeId, expectedText: node.decodedText, newText: text });
const turn = () => new Promise(setImmediate);
function fixture() {
  const writes = []; const queue = createDraftPersistence((value, revision) => new Promise((resolve, reject) => {
    writes.push({ value, revision, reject, finish: (status = 'persisted', extras = {}) => resolve({
      status, checkpointId: randomUUID(), draftRevision: revision, resultHash: value.resultHash,
      code: null, cleanupPending: false, ...extras,
    }) });
  }));
  return { queue, writes };
}

test('slow writes keep one active and only the latest pending candidate; older completion never claims the latest revision persisted', async () => {
  const { queue, writes } = fixture();
  const mutable = { ...candidate('B'), bytes: candidate('B').bytes }; queue.enqueue(mutable, 2); mutable.bytes.fill(0);
  assert.equal(writes.length, 0); assert.equal(queue.snapshot().status, 'writing'); await turn();
  assert.deepEqual(Buffer.from(writes[0].value.bytes), Buffer.from('\ufeff<!doctype html>\r\n<h1>B</h1><!-- keep -->'));
  queue.enqueue(candidate('C'), 3); queue.enqueue(candidate('D <&> 🧪'), 4);
  assert.equal(writes.length, 1); assert.equal(queue.snapshot().writingRevision, 2); assert.equal(queue.snapshot().queuedRevision, 4);
  let settled = false; const wait = queue.settle().then(value => { settled = true; return value; });
  writes[0].finish(); await turn(); assert.equal(settled, false);
  assert.deepEqual(writes.map(write => write.revision), [2, 4]);
  assert.equal(queue.snapshot().status, 'writing'); assert.equal(queue.snapshot().persisted.draftRevision, 2);
  writes[1].finish(); const last = await wait;
  assert.equal(last.status, 'persisted'); assert.equal(last.persisted.draftRevision, 4);
  assert.equal(last.persisted.resultHash, digest(Buffer.from('\ufeff<!doctype html>\r\n<h1>D &lt;&amp;&gt; 🧪</h1><!-- keep -->')));
  assert.equal(last.queuedRevision, null); assert.equal(last.writingRevision, null);
  await queue.close(); assert.deepEqual(Buffer.from(source.bytes), original);
});

test('failed storage retains the confirmed version and latest draft, stops automatic retries and retries only the newest explicit revision', async () => {
  const { queue, writes } = fixture(); queue.enqueue(candidate('B'), 2); await turn(); writes[0].finish(); await queue.settle();
  queue.enqueue(candidate('C'), 3); await turn(); queue.enqueue(candidate('D'), 4);
  writes[1].finish('failed', { code: 'DRAFT_STORAGE_FULL' }); const failed = await queue.settle();
  assert.equal(failed.status, 'failed'); assert.equal(failed.persisted.draftRevision, 2); assert.equal(failed.queuedRevision, 4);
  queue.enqueue(candidate('E'), 5); await turn(); assert.equal(writes.length, 2);
  assert.equal(queue.snapshot().canRetry, true); assert.throws(() => queue.retry(4), /STALE_DRAFT_REQUEST/);
  queue.retry(5); await turn(); assert.equal(writes[2].revision, 5);
  assert.equal(queue.snapshot().canRetry, false); assert.throws(() => queue.retry(5), /RETRY_UNAVAILABLE/);
  writes[2].finish(); assert.equal((await queue.settle()).persisted.draftRevision, 5); await queue.close();
});

test('confirmed persistence with cleanup pending is a warning; a newer queued revision stays unpersisted and cannot bypass the retained lock', async () => {
  for (const timing of ['during', 'after']) {
    const { queue, writes } = fixture(); queue.enqueue(candidate('B'), 2); await turn();
    if (timing === 'during') queue.enqueue(candidate('C'), 3);
    writes[0].finish('persisted', { code: 'DRAFT_CLEANUP_PENDING', cleanupPending: true }); await queue.settle();
    if (timing === 'after') {
      assert.equal(queue.snapshot().status, 'persisted'); assert.equal(queue.snapshot().cleanupPending, true);
      queue.enqueue(candidate('C'), 3);
    }
    assert.equal(queue.snapshot().status, 'failed'); assert.equal(queue.snapshot().persisted.draftRevision, 2);
    assert.equal(queue.snapshot().draftRevision, 3); assert.equal(queue.snapshot().queuedRevision, 3);
    assert.equal(queue.snapshot().canRetry, false); assert.throws(() => queue.retry(3), /RETRY_UNAVAILABLE/);
    await queue.close(); assert.equal(writes.length, 1);
  }
});

test('rejected or mismatched writer acknowledgements never advance the durable version or automatically start the queued candidate', async () => {
  for (const mode of ['reject', 'revision', 'hash', 'identifier']) {
    const { queue, writes } = fixture(); queue.enqueue(candidate('B'), 2); await turn(); queue.enqueue(candidate('C'), 3);
    if (mode === 'reject') writes[0].reject(new Error('unavailable writer'));
    else writes[0].finish('persisted', mode === 'revision' ? { draftRevision: 3 }
      : mode === 'hash' ? { resultHash: candidate('C').resultHash } : { checkpointId: '../untrusted' });
    const state = await queue.settle(); assert.equal(state.status, 'unknown'); assert.equal(state.persisted, null);
    assert.equal(state.queuedRevision, 3); assert.equal(writes.length, 1); await queue.close();
  }
  const { queue, writes } = fixture(); queue.enqueue(candidate('B'), 2); await turn();
  writes[0].finish('failed', { checkpointId: null, resultHash: '', code: 'DRAFT_STORAGE_BUSY' });
  assert.equal((await queue.settle()).status, 'failed'); assert.equal(queue.snapshot().code, 'DRAFT_STORAGE_BUSY'); await queue.close();
});

test('closing waits for active and latest writes, prevents later enqueue/retry, and observer errors do not interrupt evidence', async () => {
  const { queue, writes } = fixture(); queue.onState(() => { throw new Error('renderer disappeared'); });
  queue.enqueue(candidate('B'), 2); await turn(); queue.enqueue(candidate('C'), 3);
  let closed = false; const closing = queue.close().then(value => { closed = true; return value; });
  queue.enqueue(candidate('D'), 4); writes[0].finish(); await turn(); assert.equal(closed, false);
  assert.deepEqual(writes.map(write => write.revision), [2, 3]); writes[1].finish();
  const state = await closing; assert.equal(state.persisted.draftRevision, 3); assert.equal(state.canRetry, false);
  assert.throws(() => queue.retry(3), /RETRY_UNAVAILABLE/); assert.equal((await queue.close()).persisted.draftRevision, 3);
});

test('a clean latest candidate is persisted after prior dirty edits rather than silently falling back to the old checkpoint', async () => {
  const { queue, writes } = fixture(); queue.enqueue(candidate('B'), 2); await turn();
  queue.enqueue(candidate('A & 😀'), 3); writes[0].finish(); await turn();
  assert.equal(writes[1].revision, 3); assert.equal(writes[1].value.patches.length, 0);
  assert.deepEqual(Buffer.from(writes[1].value.bytes), original); writes[1].finish();
  assert.equal((await queue.settle()).persisted.resultHash, source.baseHash); await queue.close();
});
