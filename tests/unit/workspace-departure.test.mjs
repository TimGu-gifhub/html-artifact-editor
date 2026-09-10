import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../../src/main/workspace/controller.ts';

const baseHash = 'a'.repeat(64); const draftHash = 'b'.repeat(64);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function doc(name, dirty = false) {
  const listeners = new Set(); let state = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', draftRevision: dirty ? 2 : 1,
    candidateHash: dirty ? draftHash : baseHash, input: null, hasUnappliedInput: false,
    changes: dirty ? [{ nodeId: 'n1', oldText: 'original', newText: 'draft' }] : [] };
  const value = { id: randomUUID(), mode: 'proofread', name, saveSource: Object.freeze({ name }), closed: 0, held: false,
    project: () => ({ name: 'fixture', entry: name, resources: { items: [], truncated: false } }),
    update(fields) { state = { ...state, ...fields, stateRevision: state.stateRevision + 1 }; for (const listener of listeners) listener(); },
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    persistence: { snapshot: () => value.durable, settle: async () => value.durable, retry: () => {} },
    durable: { status: 'persisted', draftRevision: dirty ? 2 : 1, writingRevision: null, queuedRevision: null,
      persisted: dirty ? { draftRevision: 2, resultHash: draftHash } : null, code: null, cleanupPending: false, canRetry: false },
    input: { snapshot: () => Object.freeze({ ...state }),
      holdDeparture(revision) {
        assert.equal(revision, state.stateRevision); assert.equal(state.phase, 'idle'); value.held = true; value.update({ phase: 'leaving' });
        return () => { value.held = false; value.update({ phase: 'idle' }); };
      },
    },
    async close() { value.closed++; value.update({ phase: 'closed' }); },
  };
  value.checkpointSessionId = value.id;
  return value;
}
async function fixture() {
  const first = doc('first.html', true); const second = doc('second.html'); const calls = []; let mounted = null;
  const controls = { activate: () => {}, decision: 'discard', retire: async () => ({ status: 'retired', checkpointId: randomUUID(), code: null, cleanupPending: false }) };
  const workspace = createWorkspace('fixture-output', {
    review: async value => ({ reviewId: value.reviewId, decision: controls.decision }), chooseCopy: async () => undefined,
  }, async (_root, name) => name === 'first' ? first : second, next => {
    controls.activate(next); const previous = mounted; mounted = next; return () => { mounted = previous; };
  }, undefined, { retire: async (...args) => { calls.push(args); return controls.retire(...args); } });
  const open = () => workspace.open(workspace.snapshot().stateRevision, async () => 'second');
  await workspace.open(workspace.snapshot().stateRevision, async () => 'first');
  return { first, second, controls, calls, workspace, open, get mounted() { return mounted; } };
}

test('recovery is verified around native staging and a restored draft retires its persisted sequence rather than its new UI identity', async () => {
  const f = await fixture(); f.first.checkpointSessionId = randomUUID(); let calls = 0;
  f.second.verifyRecovery = async () => { calls++; };
  await f.open(); assert.equal(calls, 2); assert.equal(f.calls[0][1], f.first.checkpointSessionId); await f.workspace.dispose();
});

test('a changed recovery proof rolls back the candidate; an already confirmed old retirement remains visible and freezes the retained old draft', async () => {
  for (const failureAt of [1, 2]) {
    const f = await fixture(); let calls = 0;
    f.second.verifyRecovery = async () => { if (++calls === failureAt) throw Error('DRAFT_CHECKPOINT_CHANGED'); };
    await assert.rejects(f.open(), /DRAFT_CHECKPOINT_CHANGED/); assert.equal(f.workspace.current, f.first); assert.equal(f.mounted, f.first);
    assert.equal(f.first.closed, 0); assert.equal(f.second.closed, 1); assert.equal(f.calls.length, failureAt - 1);
    assert.equal(f.first.input.snapshot().phase, failureAt === 1 ? 'idle' : 'leaving');
    if (failureAt === 2) { assert.equal(f.workspace.snapshot().lastDeparture.status, 'retired'); assert.equal(f.workspace.snapshot().lastDeparture.code, 'DRAFT_CHECKPOINT_CHANGED'); assert.equal(f.workspace.snapshot().lastDeparture.requiresReview, true); }
    await f.workspace.dispose();
  }
});

test('departure drains the queue under an input hold, stages activation, then publishes only the verified original-session retirement', async () => {
  const f = await fixture(); const draining = gate(); const started = gate(); const written = gate();
  f.first.persistence.settle = () => draining.promise;
  f.controls.retire = async () => { started.resolve(); return written.promise; };
  const opening = f.open();
  while (!f.first.held) await new Promise(done => setImmediate(done));
  assert.equal(f.calls.length, 0); assert.equal(f.mounted, f.first); assert.equal(f.first.closed, 0);
  draining.resolve(f.first.durable); await started.promise;
  assert.equal(f.mounted, f.second); assert.equal(f.workspace.current, f.first);
  assert.equal(f.workspace.snapshot().phase, 'committing'); assert.equal(f.first.closed, 0);
  assert.deepEqual(f.calls[0], [f.first.saveSource, f.first.id, 2, 'discarded']);
  written.resolve({ status: 'retired', checkpointId: randomUUID(), code: null, cleanupPending: false });
  const result = await opening;
  assert.equal(result.status, 'opened'); assert.equal(f.workspace.current, f.second); assert.equal(f.first.closed, 1);
  assert.equal(result.state.lastDeparture.status, 'retired'); assert.equal(result.state.lastDeparture.requiresReview, false);
  await f.workspace.dispose();
});

test('activation, revoked authority and changed proof before retirement preserve an editable old draft and never end its records', async () => {
  for (const fault of ['activation', 'revoked', 'changed']) {
    const f = await fixture();
    if (fault === 'activation') f.controls.activate = () => { throw new Error('DOCUMENT_ACTIVATION_FAILED'); };
    else f.first.persistence.settle = async () => {
      if (fault === 'revoked') f.workspace.cancelPending();
      else f.first.update({ input: { text: 'newer retained input' }, hasUnappliedInput: true });
      return f.first.durable;
    };
    await assert.rejects(f.open(), /DOCUMENT_ACTIVATION_FAILED|WORKSPACE_CANCELLED|STALE_DOCUMENT_REVIEW/);
    assert.equal(f.calls.length, 0); assert.equal(f.workspace.current, f.first); assert.equal(f.mounted, f.first);
    assert.equal(f.first.closed, 0); assert.equal(f.first.input.snapshot().phase, 'idle'); assert.equal(f.second.closed, 1);
    assert.equal(f.workspace.snapshot().lastDeparture, null);
    await f.workspace.dispose();
  }
});

test('failed, unknown and malformed retirement acknowledgements keep old input and source frozen, roll back the view and prohibit blind continuation', async () => {
  for (const result of [
    { status: 'failed', checkpointId: null, code: 'DRAFT_STORAGE_LOCKED', cleanupPending: false },
    { status: 'unknown', checkpointId: randomUUID(), code: 'DRAFT_STORAGE_FULL', cleanupPending: false },
    { status: 'retired', checkpointId: null, code: null, cleanupPending: false },
    { status: 'empty', checkpointId: randomUUID(), code: null, cleanupPending: false },
    new Error('unavailable private writer'),
    null,
  ]) {
    const f = await fixture(); f.controls.retire = async () => { if (result instanceof Error) throw result; return result; };
    await assert.rejects(f.open(), /DRAFT_RETIREMENT_FAILED|DRAFT_RETIREMENT_UNKNOWN|unavailable private writer/);
    assert.equal(f.workspace.current, f.first); assert.equal(f.mounted, f.first); assert.equal(f.first.closed, 0); assert.equal(f.second.closed, 1);
    assert.equal(f.first.input.snapshot().candidateHash, draftHash); assert.equal(f.first.input.snapshot().phase, 'leaving');
    assert.equal(f.workspace.snapshot().lastDeparture.requiresReview, true); assert.equal(f.workspace.snapshot().canSave, false);
    await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /DOCUMENT_RECOVERY_REQUIRED/);
    assert.throws(() => f.workspace.retryPersistence(f.first.id, 2), /DOCUMENT_RECOVERY_REQUIRED/); assert.equal(f.calls.length, 1);
    await f.workspace.dispose();
  }
});

test('renderer revocation after the authorized marker starts still lets Main publish a verified result exactly once', async () => {
  const f = await fixture(); f.controls.retire = async () => {
    f.workspace.cancelPending(); return { status: 'retired', checkpointId: randomUUID(), code: null, cleanupPending: false };
  };
  assert.equal((await f.open()).status, 'opened'); assert.equal(f.workspace.current, f.second);
  assert.equal(f.calls.length, 1); assert.equal(f.first.closed, 1); assert.equal(f.workspace.snapshot().lastDeparture.requiresReview, false);
  await f.workspace.dispose();
});

test('native uncertainty after a confirmed marker retains the ended old session as evidence instead of publishing an unverified view', async () => {
  const f = await fixture(); f.controls.retire = async () => {
    f.workspace.invalidateActivation(); return { status: 'retired', checkpointId: randomUUID(), code: null, cleanupPending: false };
  };
  await assert.rejects(f.open(), /DOCUMENT_ACTIVATION_UNKNOWN/);
  assert.equal(f.workspace.current, f.first); assert.equal(f.mounted, f.first); assert.equal(f.first.closed, 0);
  const state = f.workspace.snapshot(); assert.equal(state.cleanupPending, true);
  assert.equal(state.lastDeparture.status, 'retired'); assert.equal(state.lastDeparture.requiresReview, true);
  assert.equal(state.lastDeparture.code, 'DOCUMENT_ACTIVATION_UNKNOWN');
  assert.equal(state.current.input.candidateHash, draftHash); assert.equal(f.second.closed, 1);
  await f.workspace.dispose();
});

test('clean departure requires the latest return-to-baseline checkpoint, allows explicit retry, and never invents a discard marker', async () => {
  const f = await fixture(); f.first.update({ changes: [], candidateHash: baseHash, draftRevision: 3 });
  f.first.durable = { ...f.first.durable, status: 'failed', draftRevision: 3, canRetry: true };
  await assert.rejects(f.workspace.requestClose(f.workspace.snapshot().stateRevision), /DRAFT_PERSISTENCE_REQUIRED/);
  assert.equal(f.workspace.current, f.first); assert.equal(f.first.input.snapshot().phase, 'idle'); assert.equal(f.calls.length, 0);
  assert.equal(f.workspace.snapshot().lastDeparture.requiresReview, false);
  let retries = 0; f.first.persistence.retry = revision => { assert.equal(revision, 3); retries++; };
  f.workspace.retryPersistence(f.first.id, 3); assert.equal(retries, 1);
  f.first.durable = { ...f.first.durable, status: 'persisted', persisted: { draftRevision: 3, resultHash: baseHash }, canRetry: false };
  const result = await f.workspace.requestClose(f.workspace.snapshot().stateRevision);
  assert.equal(result.status, 'closed'); assert.equal(result.state.lastDeparture.status, 'clean'); assert.equal(f.calls.length, 0);
  assert.equal(f.first.closed, 1); await f.workspace.dispose();
});

test('a verified retirement with failed lock cleanup still completes departure and reports the pending review separately', async () => {
  const f = await fixture(); f.controls.retire = async () => ({ status: 'retired', checkpointId: randomUUID(), code: 'DRAFT_CLEANUP_PENDING', cleanupPending: true });
  const result = await f.open(); assert.equal(result.status, 'opened'); assert.equal(f.workspace.current, f.second);
  assert.equal(result.state.cleanupPending, true); assert.equal(result.state.lastDeparture.status, 'retired');
  assert.equal(result.state.lastDeparture.code, 'DRAFT_CLEANUP_PENDING'); assert.equal(result.state.lastDeparture.requiresReview, true);
  await assert.rejects(f.open(), /DOCUMENT_RECOVERY_REQUIRED/); assert.equal(f.calls.length, 1);
  await f.workspace.dispose();
});
