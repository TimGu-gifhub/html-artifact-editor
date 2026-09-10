import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import {
  DEFAULT_RECOVERY_SOURCE_MODE, loadRecoveryCatalog, RecoveryDialogLifecycle, recoveryBlocker, recoveryBlockerText,
  runRecoveryRestore,
} from '../../src/ui/recovery-flow.ts';
import { recoveryRestorable } from '../../src/ui/util.ts';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { ensureInputFlushed } from '../../src/ui/flush.ts';

const DOC_ID = randomUUID();
const SESSION = randomUUID();
const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const makeState = (over = {}, currentOver = {}) => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'pages/report.html', mode: 'proofread', input: inputSnapshot(),
    project: { name: '站点', entry: 'pages/report.html' }, persistence: null, ...currentOver },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  ...over,
});
// A real interactive document: fresh id, isolated preview, null input/persistence.
const readonlyState = (over = {}, currentOver = {}) =>
  makeState(over, { id: randomUUID(), mode: 'interactive', input: null, persistence: null, ...currentOver });
const noDocState = (over = {}) => makeState({ current: null, ...over });
const okResult = (outcome, over = {}) => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome, ...over });
const catalog = name => ({ entries: [
  { sessionId: SESSION, name, draftRevision: 2, status: 'dirty', active: false, historyAvailable: false },
], locked: false, reviewRequired: false });

function harness({ state = makeState(), composing = false, flush = async () => true, restoreImpl = async () => okResult('restored') } = {}) {
  const box = { state };
  const errors = [];
  const restored = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    flush: async () => { flushCalls += 1; return flush(box); },
    restore: async (sessionId, stateRevision, sourceMode) => {
      calls.push({ sessionId, stateRevision, sourceMode });
      return restoreImpl(box);
    },
    onError: text => errors.push(text),
    onRestored: () => restored.push(true),
  };
  return { deps, box, errors, restored, calls, flushCalls: () => flushCalls };
}

test('default source mode is file and restore stays available without a document or in readonly mode', () => {
  assert.equal(DEFAULT_RECOVERY_SOURCE_MODE, 'file');
  const idle = { busy: false, composing: false };
  assert.equal(recoveryBlocker(makeState(), idle), null);
  assert.equal(recoveryBlocker(readonlyState(), idle), null, 'readonly interactive current may restore');
  assert.equal(recoveryBlocker(noDocState(), idle), null, 'restore runs with no current document');
  assert.equal(recoveryBlocker(makeState(), { busy: true, composing: false }), 'busy');
  assert.equal(recoveryBlocker(makeState(), { busy: false, composing: true }), 'composing');
  for (const phase of ['choosing', 'opening', 'reviewing', 'saving', 'committing', 'disposed']) {
    assert.equal(recoveryBlocker(makeState({ phase }), idle), 'workspace-busy', phase);
  }
  assert.equal(recoveryBlocker(makeState({ cleanupPending: true }), idle), 'cleanup-pending');
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  assert.equal(recoveryBlocker(makeState({ lastSave: review }), idle), 'review-required');
  assert.equal(recoveryBlocker(makeState({ lastDeparture: review }), idle), 'review-required');
  for (const blocker of ['busy', 'composing', 'workspace-busy', 'cleanup-pending', 'review-required']) {
    assert.ok(recoveryBlockerText(blocker).length > 0, blocker);
  }
});

test('row eligibility keeps the existing recoveryRestorable and active rules', () => {
  for (const status of ['dirty', 'clean', 'saved']) assert.equal(recoveryRestorable(status), true, status);
  for (const status of ['retired', 'incomplete', 'invalid', 'ambiguous']) assert.equal(recoveryRestorable(status), false, status);
});

test('explicit file mode is passed as the third argument with the clicked session', async () => {
  const h = harness();
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.flushCalls(), 1, 'the actual input owner is drained first');
  assert.deepEqual(h.calls, [{ sessionId: SESSION, stateRevision: 5, sourceMode: 'file' }]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.restored.length, 1, 'an authoritative restored outcome closes the dialog');
});

test('explicit directory mode is passed as the third argument with the clicked session', async () => {
  const h = harness();
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'directory' });
  assert.deepEqual(h.calls, [{ sessionId: SESSION, stateRevision: 5, sourceMode: 'directory' }]);
  assert.equal(h.errors.length, 0);
});

test('the pinned session and sourceMode survive the flush await while the revision stays fresh', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'directory' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sessionId, SESSION);
  assert.equal(h.calls[0].sourceMode, 'directory', 'the explicit choice is pinned before the await');
  assert.equal(h.calls[0].stateRevision, 9, 'revision must be re-read after draining, not captured before');
});

test('mutating the request object during a deferred flush cannot change the sent session or mode', async () => {
  const gate = barrier();
  const h = harness({ flush: async () => { await gate.promise; return true; } });
  const request = { sessionId: SESSION, sourceMode: 'file' };
  const pending = runRecoveryRestore(h.deps, request);
  request.sessionId = randomUUID();
  request.sourceMode = 'directory';
  gate.release();
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sessionId, SESSION, 'sessionId is snapshotted at entry');
  assert.equal(h.calls[0].sourceMode, 'file', 'sourceMode is snapshotted at entry');
});

test('a document change during the flush cancels the restore and delivers nothing to the new document', async () => {
  const other = randomUUID();
  const h = harness({
    flush: async box => {
      box.state = { ...box.state, stateRevision: 6, current: { ...box.state.current, id: other } };
      return true;
    },
  });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.restored.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /已取消/);
});

test('null to nonnull and nonnull to null document transitions during the flush cancel the restore', async () => {
  const appeared = harness({
    state: noDocState(),
    flush: async box => { box.state = makeState(); return true; },
  });
  await runRecoveryRestore(appeared.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(appeared.calls.length, 0);
  assert.match(appeared.errors[0], /已取消/);
  const vanished = harness({
    flush: async box => { box.state = noDocState({ stateRevision: 6 }); return true; },
  });
  await runRecoveryRestore(vanished.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(vanished.calls.length, 0);
  assert.match(vanished.errors[0], /已取消/);
});

test('restore runs with no current document and uses the latest revision', async () => {
  const h = harness({
    state: noDocState(),
    flush: async box => { box.state = { ...box.state, stateRevision: 7 }; return true; },
  });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.flushCalls(), 1, 'the input owner is still drained even without a document');
  assert.deepEqual(h.calls, [{ sessionId: SESSION, stateRevision: 7, sourceMode: 'file' }]);
  assert.equal(h.errors.length, 0);
});

test('restore runs from a readonly interactive current document (null input, still drained)', async () => {
  const h = harness({ state: readonlyState() });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'directory' });
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sourceMode, 'directory');
  assert.equal(h.errors.length, 0);
});

test('composing blocks the restore before any flush', async () => {
  const h = harness({ composing: true });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /组词/);
});

test('workspace busy, cleanup and review-required states block before any flush', async () => {
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  for (const state of [makeState({ phase: 'saving' }), makeState({ cleanupPending: true }),
    makeState({ lastSave: review }), makeState({ lastDeparture: review })]) {
    const h = harness({ state });
    await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
    assert.equal(h.flushCalls(), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.errors.length, 1);
  }
});

test('a blocker appearing after the flush still prevents the restore', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, cleanupPending: true }; return true; },
  });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /清理/);
});

test('a failed flush aborts silently (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.restored.length, 0);
});

test('a throwing flush is reported once and never reaches Main', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /完成当前输入/);
});

test('same-frame duplicate restore sends exactly one request and releases the guard', async () => {
  const h = harness();
  const guard = new BusyGuard();
  const run = sourceMode => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode }).finally(() => guard.release());
  };
  await Promise.all([run('file'), run('file'), run('directory')]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sourceMode, 'file');
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('a rejected restore transport settles with an error, releases the guard and never throws', async () => {
  const h = harness({ restoreImpl: async () => { throw new Error('ipc gone'); } });
  const guard = new BusyGuard();
  assert.equal(guard.tryAcquire(), true);
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' }).finally(() => guard.release());
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /连接已断开/);
  assert.equal(h.restored.length, 0);
  assert.equal(guard.tryAcquire(), true);
  guard.release();
});

test('Main failure keeps the dialog open with the error; no success is claimed', async () => {
  const h = harness({ restoreImpl: async () => ({ ...okResult(null), ok: false, code: 'DRAFT_SESSION_ACTIVE' }) });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.restored.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /当前打开的会话/);
});

test('authoritative picker cancellation is quiet: no error, no close, choice state untouched', async () => {
  const h = harness({ restoreImpl: async () => okResult('cancelled') });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'directory' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0, 'an ok cancelled outcome must not surface an error');
  assert.equal(h.restored.length, 0, 'a cancelled outcome must not close the dialog');
});

test('a non-ok result with a cancelled outcome still surfaces its code as an error', async () => {
  const changed = harness({ restoreImpl: async () => ({ ...okResult('cancelled'), ok: false, code: 'FILE_CHANGED' }) });
  await runRecoveryRestore(changed.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(changed.calls.length, 1);
  assert.equal(changed.restored.length, 0, 'cancelled never claims success');
  assert.equal(changed.errors.length, 1, 'a non-ok cancellation is not quiet');
  assert.match(changed.errors[0], /已被其他程序修改/, 'the FILE_CHANGED code drives the message');
  const gone = harness({ restoreImpl: async () => ({ ...okResult('cancelled'), ok: false, code: 'EDITOR_DISCONNECTED' }) });
  await runRecoveryRestore(gone.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(gone.restored.length, 0);
  assert.equal(gone.errors.length, 1);
  assert.match(gone.errors[0], /连接已断开/, 'the EDITOR_DISCONNECTED code drives the message');
});

test('ok without a restored outcome is reported, never treated as success', async () => {
  const h = harness({ restoreImpl: async () => okResult(null) });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.restored.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /操作未完成/);
});

test('a missing workspace state does nothing at all', async () => {
  const h = harness();
  h.box.state = null;
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.restored.length, 0);
});

// ---- Catalog loading bound to a dialog generation ----

test('catalog load applies the result only while its generation is current', async () => {
  const applied = [];
  await loadRecoveryCatalog(
    async () => ({ ...okResult(null), recovery: catalog('报告') }),
    () => true,
    view => applied.push(view),
  );
  assert.equal(applied.length, 1);
  assert.equal(applied[0].loading, false);
  assert.equal(applied[0].error, null);
  assert.equal(applied[0].catalog.entries[0].name, '报告');
  assert.deepEqual(Object.keys(applied[0]).sort(), ['catalog', 'error', 'loading'],
    'the catalog view carries no busy field and can never clear a busy state');
});

test('catalog load surfaces a Main error code and a rejected transport, never a stuck spinner', async () => {
  const failed = [];
  await loadRecoveryCatalog(
    async () => ({ ...okResult(null), ok: false, code: 'WORKSPACE_BUSY' }),
    () => true,
    view => failed.push(view),
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].loading, false);
  assert.equal(failed[0].catalog, null);
  assert.match(failed[0].error, /WORKSPACE_BUSY/);
  const rejected = [];
  await loadRecoveryCatalog(
    async () => { throw new Error('ipc gone'); },
    () => true,
    view => rejected.push(view),
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].loading, false);
  assert.match(rejected[0].error, /连接已断开/);
});

test('out-of-order catalog results: a late result from a closed/reopened dialog is dropped', async () => {
  const gate = barrier();
  const applied = [];
  let generation = 1;
  const slow = loadRecoveryCatalog(
    () => gate.promise.then(() => ({ ...okResult(null), recovery: catalog('旧对话框') })),
    () => generation === 1,
    view => applied.push(['old', view]),
  );
  generation = 2; // the dialog was closed and reopened before the first load returned
  const fast = loadRecoveryCatalog(
    async () => ({ ...okResult(null), recovery: catalog('新对话框') }),
    () => generation === 2,
    view => applied.push(['new', view]),
  );
  gate.release();
  await Promise.all([slow, fast]);
  assert.deepEqual(applied.map(([key]) => key), ['new']);
  assert.equal(applied[0][1].catalog.entries[0].name, '新对话框');
});

test('a late catalog failure from a closed dialog is dropped the same way', async () => {
  const applied = [];
  let generation = 1;
  const pending = loadRecoveryCatalog(
    async () => { await delay(10); throw new Error('ipc gone'); },
    () => generation === 1,
    view => applied.push(view),
  );
  generation = 2; // closed before the rejection arrived
  await pending;
  assert.equal(applied.length, 0);
});

// ---- Dialog lifecycle: synchronous action latch, replacement and unmount ----

test('the action latch blocks a same-event-loop close and reopen before any render', async () => {
  const life = new RecoveryDialogLifecycle();
  const gen = life.open();
  assert.notEqual(gen, null);
  const gate = barrier();
  const h = harness({ flush: async () => { await gate.promise; return true; } });
  let closed = 0;
  const pending = (async () => {
    assert.equal(life.acquire(), true, 'claimed synchronously inside the acquired busy guard');
    try {
      await runRecoveryRestore({
        ...h.deps,
        onRestored: () => { if (life.isCurrent(gen)) { life.invalidate(); closed += 1; } },
      }, { sessionId: SESSION, sourceMode: 'file' });
    } finally {
      life.release();
    }
  })();
  // Escape/close and a menu reopen in the same event loop, before any render:
  assert.equal(life.close(), false, 'close cannot hide the accepted flow');
  assert.equal(life.open(), null, 'reopen cannot reset the accepted flow');
  assert.equal(life.isCurrent(gen), true, 'the in-flight generation survives');
  gate.release();
  await pending;
  assert.equal(closed, 1, 'the flow itself closes the dialog after an authoritative restore');
  assert.equal(h.errors.length, 0);
  assert.equal(life.close(), true, 'close works again once the latch settles');
});

test('dispose on unmount invalidates outstanding generations and never strands the latch', () => {
  const life = new RecoveryDialogLifecycle();
  const gen = life.open();
  assert.equal(life.acquire(), true);
  life.dispose(); // the window unmounted mid-flight
  assert.equal(life.isCurrent(gen), false, 'a late result can never touch a successor');
  assert.equal(life.acquire(), true, 'the latch never stays stuck after disposal');
});

test('a late restored result bound to a replaced dialog does not close the successor', async () => {
  const life = new RecoveryDialogLifecycle();
  const gen = life.open();
  let currentDialog = 'recovery';
  const closed = [];
  const gate = barrier();
  const h = harness({ restoreImpl: async () => { await gate.promise; return okResult('restored'); } });
  const belongs = () => life.isCurrent(gen) && currentDialog === 'recovery';
  const pending = runRecoveryRestore({
    ...h.deps,
    onRestored: () => { if (!belongs()) return; life.invalidate(); closed.push('recovery'); },
  }, { sessionId: SESSION, sourceMode: 'file' });
  currentDialog = 'resources'; // the user opened another dialog through the existing UI
  gate.release();
  await pending;
  assert.deepEqual(closed, [], 'the replacement dialog stays open');
  assert.equal(h.restored.length, 0);
});

// ---- Real input controllers behind the flush contract ----

test('IME composition on the real owner controller blocks the restore (flush returns false)', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: true, code: null, state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  controller.onCompositionStart();
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.equal(h.calls.length, 0, 'restore must not start while composing');
  assert.equal(h.errors.length, 0, 'the flush path owns the explanation');
  assert.equal(controller.isComposing(), true);
  controller.dispose();
});

test('a failed owner input (begin rejected) blocks the restore and preserves local text', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: false, code: 'SELECTION_STALE', state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  await controller.begin('n1:1:s:g', { nodeId: 'n1' }, 3);
  assert.equal(controller.getView().phase, 'failed');
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'directory' });
  assert.equal(h.calls.length, 0, 'unflushed failed input must not start a restore');
  assert.equal(h.errors.length, 0);
  controller.dispose();
});

test('non-owner flush routes flush-input through Main before the restore starts', async () => {
  const store = new WorkspaceStore();
  store.accept(makeState());
  const commands = [];
  const controller = new LiveInputController(
    async id => ({ ok: true, code: null, state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: null, input: null }),
  );
  const h = harness({
    flush: () => ensureInputFlushed({ owner: false, controller }, store, async command => {
      commands.push(command.kind);
      return { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };
    }),
  });
  await runRecoveryRestore(h.deps, { sessionId: SESSION, sourceMode: 'file' });
  assert.deepEqual(commands, ['flush-input'], 'the floating owner is drained through Main');
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0);
  controller.dispose();
});
