import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { assertHistoryWorkerAvailable, createHistoryController, freezeHistoryCheckpoint, prepareHistory } from '../../src/main/draft/history.ts';
import { freezeCandidate } from '../../src/main/draft/prepare.ts';
import { createDraftSession } from '../../src/main/draft/session.ts';
import { digest } from '../../src/platform/storage-files.ts';

const source = () => createSourceIndex(Buffer.from('<!doctype html><html><head></head><body><h1>A</h1></body></html>'),
  { projectId: randomUUID(), documentId: randomUUID(), generation: 1 }, digest);
const localPrepare = async (_root, source, checkpoint, command) => {
  let h = createTextHistory(source.bytes, source.identity, digest, checkpoint); let changes = [];
  if (command.kind === 'edit' || command.kind === 'move') {
    const plan = command.kind === 'edit' ? h.prepareEdit(command.change) : h.prepareMove(command.direction);
    changes = plan.changes; h.commit(plan);
  } else if (command.kind === 'saved') h = h.rebaseSaved(command.bytes, command.identity);
  return Object.freeze({ candidate: freezeCandidate(h.candidate), checkpoint: freezeHistoryCheckpoint(h.capture()), changes });
};
const change = (s, before, after) => ({ identity: s.identity, baseHash: s.baseHash,
  nodeId: s.nodes.find(node => node.parentTag === 'h1').nodeId, expectedText: before, newText: after });

test('Main history issues single-use plans and preserves current state until explicit confirmation, including failed/forged/stale plans', async () => {
  const s = source(); const h = await createHistoryController('unused', s, undefined, undefined, localPrepare);
  const initial = h.capture(); const plan = await h.prepareEdit(change(s, 'A', 'B')); assert.equal(h.capture(), initial);
  assert.throws(() => h.commit({ ...plan }), /STALE_HISTORY_TRANSITION/);
  h.commit(plan); assert.equal(h.revision, 2); assert.throws(() => h.commit(plan), /STALE_HISTORY_TRANSITION/);
  const stale = await h.prepareMove('undo'); const next = await h.prepareEdit(change(s, 'B', 'C')); h.commit(next);
  assert.throws(() => h.commit(stale), /STALE_HISTORY_TRANSITION/); assert.equal(h.summary().undoCount, 2);
  await assert.rejects(h.prepareEdit(change(s, 'C', '\u0000')), /INVALID_TEXT_NUL/); assert.equal(h.revision, 3);
  const saved = await h.savedCheckpoint(h.candidate.bytes); assert.equal(saved.record.revision, 4); assert.equal(h.revision, 3);
  await h.close(); await assert.rejects(h.prepareMove('undo'), /HISTORY_UNAVAILABLE/);
});

test('Draft history confirms Preview before committing or enqueueing, while rejection and unknown preserve the old branch and prepared evidence', async () => {
  const s = source(); const h = await createHistoryController('unused', s, undefined, undefined, localPrepare);
  const id = { preview: { version: 1, sessionId: randomUUID(), mode: 'proofread', generation: 1 }, documentId: s.identity.documentId, baseHash: s.baseHash };
  const selection = { identity: id, nodeId: change(s, '', '').nodeId, revision: 2 };
  const written = []; let domText = 'A'; let outcome = 'applied'; let calls = 0;
  const mapping = { source: s, identity: id, status: 'ready', selection: null, revision: 2,
    applyText: async (_selected, before, text) => { assert.equal(domText, before); domText = text; return 'applied'; },
    applyHistory: async (_revision, value) => { calls++; assert.equal(h.candidate.resultHash, written.at(-1).candidate.resultHash);
      if (outcome !== 'rejected') domText = value.newText; return outcome; },
  };
  const draft = createDraftSession('unused', mapping, undefined, { enqueue: (candidate, revision, history) => written.push({ candidate, revision, history }) }, h);
  await draft.restore(h.candidate, h.revision); mapping.selection = selection;
  await draft.apply({ selection, draftRevision: 1, newText: 'B' }); assert.equal(domText, 'B'); assert.equal(written.length, 1);
  const retained = h.capture();
  await assert.rejects(draft.moveHistory(2, 'undo', async () => { throw Error('STALE_INPUT_STATE'); }), /STALE_INPUT_STATE/);
  assert.equal(calls, 0); assert.equal(h.capture(), retained); assert.equal(draft.phase, 'idle');
  outcome = 'rejected'; await assert.rejects(draft.moveHistory(2, 'undo', async () => mapping.revision), /STALE_HISTORY_TRANSITION/);
  assert.equal(h.capture(), retained); assert.equal(domText, 'B'); assert.equal(written.length, 1);
  outcome = 'unknown'; await assert.rejects(draft.moveHistory(2, 'undo', async () => mapping.revision), /DRAFT_OUTCOME_UNKNOWN/);
  assert.equal(domText, 'A'); assert.equal(h.capture(), retained); assert.equal(draft.revision, 2); assert.equal(draft.phase, 'uncertain');
  assert.equal(draft.uncertainCandidate.resultHash, s.baseHash); assert.equal(draft.uncertainHistory.checkpoint.record.cursor, 0);
  assert.equal(written.length, 1); await assert.rejects(draft.moveHistory(2, 'undo', async () => 2), /HISTORY_UNAVAILABLE/);
  draft.close(); await h.close();
});

test('closing a history controller cancels and drains preparation, and no late plan can commit', async () => {
  const s = source(); let started; const ready = new Promise(done => { started = done; });
  const h = await createHistoryController('unused', s, undefined, undefined, async (...args) => {
    if (args[3].kind === 'read') return localPrepare(...args);
    return new Promise((_done, reject) => { started(); args[4].addEventListener('abort', () => reject(Error('HISTORY_PREPARE_CANCELLED')), { once: true }); });
  });
  const pending = h.prepareEdit(change(s, 'A', 'B')); const check = assert.rejects(pending, /HISTORY_PREPARE_CANCELLED/);
  await ready; await h.close(); await check; assert.equal(h.revision, 1);
});

test('unconfirmed Worker termination disables historical transitions, original Save and successful ownership cleanup', async () => {
  const s = source();
  const h = await createHistoryController('unused', s, undefined, undefined, async (...args) => {
    if (args[3].kind === 'read') return localPrepare(...args); throw Error('HISTORY_WORKER_STOP_FAILED');
  });
  await assert.rejects(h.prepareEdit(change(s, 'A', 'B')), /HISTORY_WORKER_STOP_FAILED/); assert.equal(h.available, false);
  const draft = createDraftSession('unused', { source: s, status: 'ready' }, undefined, undefined, h);
  assert.equal(draft.historyReady, false);
  await assert.rejects(draft.saveOriginal(async () => assert.fail('must not commit before a possible rebase')), /DRAFT_UNAVAILABLE/);
  await assert.rejects(h.close(), /HISTORY_WORKER_STOP_FAILED/); assert.equal(h.revision, 1);
});

test('an actual Worker termination rejection blocks further preparation before another document can allocate a Preview', async () => {
  await mkdir(resolve('test-results'), { recursive: true }); const root = await mkdtemp(resolve('test-results/history-worker-stop-'));
  await mkdir(join(root, 'history-worker')); await writeFile(join(root, 'history-worker/index.cjs'),
    'require("node:worker_threads").parentPort.postMessage({ok:false,error:"HISTORY_PREPARE_FAILED"});setInterval(()=>{},1000);');
  const terminate = Worker.prototype.terminate; let retained;
  Worker.prototype.terminate = function () { retained = this; return Promise.reject(Error('injected termination rejection')); };
  try {
    await assert.rejects(prepareHistory(root, source(), undefined, { kind: 'read' }, new AbortController().signal), /HISTORY_WORKER_STOP_FAILED/);
    assert.throws(() => assertHistoryWorkerAvailable(root), /HISTORY_WORKER_STOP_FAILED/);
    await assert.rejects(prepareHistory(root, source(), undefined, { kind: 'read' }, new AbortController().signal), /HISTORY_WORKER_STOP_FAILED/);
  } finally { Worker.prototype.terminate = terminate; if (retained) await terminate.call(retained); }
});
