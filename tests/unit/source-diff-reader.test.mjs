import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { buildSourceDiff } from '../../src/core/patch/source-diff.ts';
import { createSourceDiffReader } from '../../src/main/draft/source-diff.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = createSourceIndex(Buffer.from('<!doctype html><p>A &amp; 😀</p>'), { projectId: 'diff', documentId: 'reader', generation: 1 }, hash);
const candidate = text => createPatchEngine(source, hash).apply({ identity: source.identity, baseHash: source.baseHash,
  nodeId: source.nodes[0].nodeId, expectedText: source.nodes[0].decodedText, newText: text });
const turn = () => new Promise(setImmediate);
function fixture() {
  let state = { candidate: candidate('B'), revision: 2, phase: 'idle' }; const jobs = [];
  const reader = createSourceDiffReader('unused', source, () => state, (_out, source, candidate, signal) => new Promise((resolve, reject) => {
    const job = { candidate, signal, resolve: () => resolve(buildSourceDiff(source, candidate, hash)), reject }; jobs.push(job);
  }));
  return { reader, jobs, get state() { return state; }, set(value) { state = { ...state, ...value }; }, read() { return reader.read(state.revision, state.candidate.resultHash); } };
}

test('concurrent readers share a single job and repeated reads reuse exactly the completed immutable snapshot', async () => {
  const f = fixture(); const one = f.read(); const two = f.read(); await turn(); assert.equal(f.jobs.length, 1);
  f.jobs[0].resolve(); const result = await one; assert.equal(await two, result); assert.equal(await f.read(), result); assert.equal(f.jobs.length, 1);
  assert.equal(result.changes[0].after.text, 'B'); await f.reader.close();
});

test('a newer confirmed draft cancels the old worker and waits for termination before coalescing the latest reads', async () => {
  const f = fixture(); const one = f.read(); const oldFailure = assert.rejects(one, /SOURCE_DIFF_CANCELLED/); await turn();
  f.set({ candidate: candidate('C'), revision: 3 }); const two = f.read(); const three = f.read();
  assert.equal(f.jobs[0].signal.aborted, true); await turn(); assert.equal(f.jobs.length, 1);
  f.jobs[0].reject(Error('SOURCE_DIFF_CANCELLED')); await oldFailure; await turn(); assert.equal(f.jobs.length, 2);
  f.jobs[1].resolve(); assert.equal((await two).changes[0].after.text, 'C'); assert.equal(await two, await three); await f.reader.close();
});

test('late results and stale references cannot be cached for a newer revision, even when returning to the same candidate bytes', async () => {
  const f = fixture(); const old = f.state; const one = f.read(); await turn(); f.set({ revision: 4 });
  f.jobs[0].resolve(); await assert.rejects(one, /STALE_SOURCE_DIFF/);
  await assert.rejects(f.reader.read(old.revision, old.candidate.resultHash), /STALE_SOURCE_DIFF/);
  const fresh = f.read(); await turn(); assert.equal(f.jobs.length, 2); f.jobs[1].resolve(); await fresh;
  await f.reader.close();
});

test('failed reads preserve the candidate, allow an explicit fresh read, and busy/uncertain drafts never supply save previews', async () => {
  const f = fixture(); const before = f.state.candidate; const one = f.read(); await turn(); f.jobs[0].reject(Error('SOURCE_DIFF_FAILED'));
  await assert.rejects(one, /SOURCE_DIFF_FAILED/); assert.equal(f.state.candidate, before);
  for (const phase of ['applying', 'saving', 'uncertain']) { f.set({ phase }); await assert.rejects(f.read(), /DRAFT_UNAVAILABLE/); }
  f.set({ phase: 'idle' }); const retry = f.read(); await turn(); assert.equal(f.jobs.length, 2); f.jobs[1].resolve(); await retry;
  await f.reader.close();
});

test('closing cancels an in-flight job and waits for its termination; no late result or cached read survives disposal', async () => {
  const f = fixture(); const one = f.read(); const rejected = assert.rejects(one, /SOURCE_DIFF_CANCELLED/); await turn();
  let finished = false; const closing = f.reader.close().then(() => { finished = true; });
  assert.equal(f.jobs[0].signal.aborted, true); await turn(); assert.equal(finished, false);
  f.jobs[0].resolve(); await rejected; await closing; await assert.rejects(f.read(), /SOURCE_DIFF_CANCELLED/);
});

test('unconfirmed worker termination prevents another worker and fails teardown instead of reporting successful resource cleanup', async () => {
  const f = fixture(); const one = f.read(); await turn(); f.jobs[0].reject(Error('SOURCE_DIFF_STOP_FAILED'));
  await assert.rejects(one, /SOURCE_DIFF_STOP_FAILED/);
  await assert.rejects(f.read(), /SOURCE_DIFF_STOP_FAILED/); assert.equal(f.jobs.length, 1);
  await assert.rejects(f.reader.close(), /SOURCE_DIFF_STOP_FAILED/);
});
