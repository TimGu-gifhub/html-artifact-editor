import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../../src/main/workspace/controller.ts';
import { isLeaveDecision } from '../../src/contracts/workspace.ts';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function source(name) {
  const listeners = new Set();
  let state = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', draftRevision: 1,
    candidateHash: 'a'.repeat(64), input: null, hasUnappliedInput: false, changes: [] };
  const calls = { closed: 0, apply: 0, write: 0 };
  const update = (fields) => { state = { ...state, ...fields, stateRevision: state.stateRevision + 1 }; for (const fn of listeners) fn(); };
  const doc = { id: randomUUID(), name, writer: {}, calls, update,
    failApply: false, failCleanup: false, copyStatus: 'created',
    input: {
      snapshot: () => Object.freeze({ ...state }),
      onState: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      async apply() {
        calls.apply++;
        if (doc.failApply) throw new Error('INVALID_TEXT_NUL');
        update({ hasUnappliedInput: false, input: { ...state.input, appliedText: state.input.text },
          changes: [{ nodeId: 'n1', oldText: 'base', newText: state.input.text }], draftRevision: state.draftRevision + 1 });
      },
      async saveCopy(_version, choose) {
        const path = await choose(); if (!path) return null;
        calls.write++;
        if (doc.copyStatus === 'unknown') update({ draftPhase: 'uncertain' });
        return { status: doc.copyStatus, expectedHash: state.candidateHash, path };
      },
    },
    async close() { calls.closed++; if (doc.failCleanup) throw new Error('cleanup failed'); update({ phase: 'closed' }); },
  };
  doc.dirty = () => update({ input: { editToken: randomUUID(), revision: 1, composing: false, text: '保留输入', appliedText: 'base' }, hasUnappliedInput: true });
  return doc;
}
function setup() {
  const docs = new Map();
  const controls = { chooseCalls: 0, prepareCalls: 0, reviewCalls: 0, copyCalls: 0,
    review: async (value) => ({ reviewId: value.reviewId, decision: 'cancel' }),
    chooseCopy: async () => undefined,
    prepare: async (_root, path) => { if (!docs.has(path)) throw new Error('prepare failed'); return docs.get(path); } };
  const workspace = createWorkspace('test-output', {
    review: (value) => { controls.reviewCalls++; return controls.review(value); },
    chooseCopy: (name) => { controls.copyCalls++; return controls.chooseCopy(name); },
  }, (...args) => { controls.prepareCalls++; return controls.prepare(...args); });
  const open = (name) => workspace.open(workspace.snapshot().stateRevision, async () => { controls.chooseCalls++; return name; });
  return { workspace, controls, docs, open, add(name) { const value = source(name); docs.set(name, value); return value; } };
}

test('leave decision is exact, explicit and tied to a bounded review identity', () => {
  const reviewId = randomUUID();
  for (const decision of ['cancel', 'discard', 'save-copy']) assert.ok(isLeaveDecision({ reviewId, decision }));
  for (const value of [null, {}, { reviewId, decision: 'overwrite' }, { reviewId, decision: 'discard', force: true },
    { reviewId: 'x', decision: 'discard' }]) assert.equal(isLeaveDecision(value), false);
});
test('cancelled open allocates no candidate; clean open/close returns settled state and rejects concurrent requests', async () => {
  const f = setup(); const first = f.add('first');
  assert.equal((await f.open(undefined)).status, 'cancelled'); assert.equal(f.controls.prepareCalls, 0);
  let incorrectlyCancelled = false;
  await f.workspace.open(f.workspace.snapshot().stateRevision, () => Promise.reject(undefined))
    .then(() => { incorrectlyCancelled = true; }, (reason) => assert.equal(reason, undefined));
  assert.equal(incorrectlyCancelled, false); assert.equal(f.controls.prepareCalls, 0);
  const result = await f.open('first'); assert.equal(result.status, 'opened'); assert.equal(result.state.phase, 'idle');
  const revision = f.workspace.snapshot().stateRevision;
  const closing = f.workspace.requestClose(revision);
  await assert.rejects(f.workspace.requestClose(revision), /WORKSPACE_BUSY/);
  assert.equal((await closing).state.current, null); assert.equal(first.calls.closed, 1); assert.equal(f.controls.reviewCalls, 0);
});
test('failed late preparation and cancelled leave keep the original live input/candidate; candidate is retired only', async () => {
  const f = setup(); const first = f.add('first'); const second = f.add('second'); await f.open('first'); first.dirty();
  const before = first.input.snapshot();
  await assert.rejects(f.open('missing'), /prepare failed/);
  assert.equal(f.workspace.current, first); assert.equal(first.calls.closed, 0); assert.deepEqual(first.input.snapshot(), before);
  assert.equal((await f.open('second')).status, 'cancelled');
  assert.equal(f.workspace.current, first); assert.equal(first.calls.closed, 0); assert.equal(second.calls.closed, 1);
  assert.equal(first.calls.apply, 0); assert.equal(first.calls.write, 0);
});
test('changed input and forged review identity invalidate a discard response instead of losing newer text', async () => {
  const f = setup(); const first = f.add('first'); f.add('second'); await f.open('first'); first.dirty();
  f.controls.review = async (value) => {
    first.update({ input: { ...first.input.snapshot().input, text: '确认期间的新输入', revision: 2 } });
    return { reviewId: value.reviewId, decision: 'discard' };
  };
  await assert.rejects(f.open('second'), /STALE_DOCUMENT_REVIEW/);
  assert.equal(f.workspace.current, first); assert.equal(first.input.snapshot().input.text, '确认期间的新输入');
  f.controls.review = async () => ({ reviewId: randomUUID(), decision: 'discard' });
  await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /STALE_DOCUMENT_REVIEW/);
  assert.equal(first.calls.closed, 0);
  f.controls.review = async (value) => ({ reviewId: value.reviewId, decision: 'discard' });
  assert.equal((await f.workspace.requestClose(f.workspace.snapshot().stateRevision)).status, 'closed');
  assert.equal(first.calls.apply, 0); assert.equal(first.calls.write, 0);
});
test('save-before-leave preserves failed raw input and a cancelled chooser preserves explicitly applied drafts', async () => {
  const f = setup(); const first = f.add('first'); await f.open('first'); first.dirty();
  f.controls.review = async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' });
  first.failApply = true;
  await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /INVALID_TEXT_NUL/);
  assert.equal(first.input.snapshot().hasUnappliedInput, true); assert.equal(f.controls.copyCalls, 0);
  first.failApply = false;
  assert.equal((await f.workspace.requestClose(f.workspace.snapshot().stateRevision)).status, 'cancelled');
  assert.equal(first.input.snapshot().hasUnappliedInput, false); assert.equal(first.input.snapshot().changes.length, 1);
  assert.equal(first.calls.closed, 0); assert.equal(first.calls.write, 0);
});
test('failed and unknown copies prevent leaving, and unknown state prohibits subsequent opening until recovery', async () => {
  const f = setup(); const first = f.add('first'); await f.open('first'); first.dirty();
  f.controls.review = async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' });
  f.controls.chooseCopy = async () => 'copy.html'; first.copyStatus = 'failed';
  await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /COPY_FAILED/);
  assert.equal(f.workspace.current, first); assert.equal(first.calls.closed, 0);
  first.copyStatus = 'unknown';
  await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /COPY_OUTCOME_UNKNOWN/);
  const chosen = f.controls.chooseCalls;
  await assert.rejects(f.open('next'), /DOCUMENT_RECOVERY_REQUIRED/); assert.equal(f.controls.chooseCalls, chosen);
  assert.equal(first.calls.closed, 0);
});
test('composing, busy input and stale workspace versions prevent even opening a chooser', async () => {
  const f = setup(); const first = f.add('first'); await f.open('first'); first.dirty();
  const version = f.workspace.snapshot().stateRevision;
  first.update({ input: { ...first.input.snapshot().input, composing: true } });
  await assert.rejects(f.open('next'), /INPUT_COMPOSING/);
  await assert.rejects(f.workspace.open(version, async () => 'next'), /STALE_WORKSPACE/);
  first.update({ phase: 'applying', input: { ...first.input.snapshot().input, composing: false } });
  await assert.rejects(f.open('next'), /DOCUMENT_BUSY/); assert.equal(f.controls.chooseCalls, 1);
});
test('cleanup failure after committed replacement reports the new document and blocks unbounded further opens', async () => {
  const f = setup(); const first = f.add('first'); const second = f.add('second'); await f.open('first'); first.failCleanup = true;
  const opened = await f.open('second'); assert.equal(opened.status, 'opened'); assert.equal(opened.state.cleanupPending, true);
  assert.equal(f.workspace.current, second); assert.equal(first.calls.closed, 1);
  await assert.rejects(f.open('third'), /DOCUMENT_CLEANUP_REQUIRED/);
});
test('forced process teardown during preparation rejects late success and retains the original evidence reference', async () => {
  const f = setup(); const first = f.add('first'); const second = f.add('second'); await f.open('first'); first.dirty();
  const waiting = deferred(); const started = deferred();
  f.controls.prepare = async () => { started.resolve(); return waiting.promise; };
  const opening = f.open('second'); await started.promise;
  await f.workspace.dispose(); waiting.resolve(second);
  await assert.rejects(opening, /WORKSPACE_CANCELLED/);
  assert.equal(second.calls.closed, 1); assert.equal(f.workspace.snapshot().phase, 'disposed');
  assert.equal(f.workspace.current, first); assert.equal(first.input.snapshot().input.text, '保留输入');
});
test('teardown cancels a non-returning leave review, retires its prepared candidate and ignores a late discard', async () => {
  const f = setup(); const first = f.add('first'); const second = f.add('second'); await f.open('first'); first.dirty();
  const answer = deferred(); const started = deferred(); let reviewId;
  f.controls.review = async (value) => { reviewId = value.reviewId; started.resolve(); return answer.promise; };
  const opening = f.open('second'); const rejected = assert.rejects(opening, /WORKSPACE_CANCELLED/);
  await started.promise; await f.workspace.dispose(); await rejected;
  assert.equal(second.calls.closed, 1); assert.equal(f.workspace.current, first);
  answer.resolve({ reviewId, decision: 'discard' }); await Promise.resolve();
  assert.equal(f.workspace.current, first); assert.equal(first.calls.write, 0);
});
test('teardown cancels a non-returning file chooser before preparation and consumes a later rejection', async () => {
  const f = setup(); const answer = deferred(); const started = deferred();
  const opening = f.workspace.open(f.workspace.snapshot().stateRevision, async () => { started.resolve(); return answer.promise; });
  const rejected = assert.rejects(opening, /WORKSPACE_CANCELLED/);
  await started.promise; await f.workspace.dispose(); await rejected;
  answer.reject(new Error('late dialog failure')); await Promise.resolve();
  assert.equal(f.controls.prepareCalls, 0); assert.equal(f.workspace.snapshot().phase, 'disposed');
});
