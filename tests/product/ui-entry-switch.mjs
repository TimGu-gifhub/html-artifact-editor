import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BusyGuard, entrySwitchBlocker, entrySwitchBlockerText, runEntrySwitch } from '../../src/ui/entry-switch.ts';

const DOC_ID = randomUUID();

const makeState = (over = {}) => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'a.html', input: { hasUnappliedInput: false },
    project: { name: '站点', entry: 'pages/a.html' }, persistence: null },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  ...over,
});
const okResult = outcome => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome });

function harness({ state = makeState(), composing = false, flush = async () => true, switchImpl = async () => okResult('opened') } = {}) {
  const box = { state };
  const toasts = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    flush: async () => { flushCalls += 1; return flush(box); },
    switchEntry: async (documentId, stateRevision) => { calls.push({ documentId, stateRevision }); return switchImpl(box); },
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, box, toasts, calls, flushCalls: () => flushCalls };
}

test('entrySwitchBlocker gates no-document, busy, composing, non-idle, cleanup and review-required states', () => {
  const idle = { busy: false, composing: false };
  assert.equal(entrySwitchBlocker(null, idle), 'no-document');
  assert.equal(entrySwitchBlocker(makeState({ current: null }), idle), 'no-document');
  assert.equal(entrySwitchBlocker(makeState(), { busy: true, composing: false }), 'busy');
  assert.equal(entrySwitchBlocker(makeState(), { busy: false, composing: true }), 'composing');
  for (const phase of ['choosing', 'opening', 'reviewing', 'saving', 'committing', 'disposed']) {
    assert.equal(entrySwitchBlocker(makeState({ phase }), idle), 'workspace-busy', phase);
  }
  assert.equal(entrySwitchBlocker(makeState({ cleanupPending: true }), idle), 'cleanup-pending');
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  assert.equal(entrySwitchBlocker(makeState({ lastSave: review }), idle), 'review-required');
  assert.equal(entrySwitchBlocker(makeState({ lastDeparture: review }), idle), 'review-required');
  assert.equal(entrySwitchBlocker(makeState(), idle), null);
  for (const blocker of ['no-document', 'busy', 'composing', 'workspace-busy', 'cleanup-pending', 'review-required']) {
    assert.ok(entrySwitchBlockerText(blocker).length > 0, blocker);
  }
});

test('no current document: no flush, no request, no toast', async () => {
  const h = harness({ state: makeState({ current: null }) });
  await runEntrySwitch(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('composing never opens the picker and explains why', async () => {
  const h = harness({ composing: true });
  await runEntrySwitch(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /组词/);
});

test('non-idle workspace phase never opens the picker', async () => {
  const h = harness({ state: makeState({ phase: 'opening' }) });
  await runEntrySwitch(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts[0].kind, 'error');
});

test('failed flush aborts the switch without a second toast (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runEntrySwitch(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('a throwing flush is reported once and never reaches the picker', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runEntrySwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /完成当前输入/);
});

test('successful flush uses the pinned document id with the LATEST stateRevision', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runEntrySwitch(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].documentId, DOC_ID);
  assert.equal(h.calls[0].stateRevision, 9, 'revision must be re-read after draining, not captured before');
  assert.equal(h.toasts.length, 0);
});

test('a document change during flush cancels the action and delivers nothing to the new document', async () => {
  const other = randomUUID();
  const h = harness({
    flush: async box => {
      box.state = { ...box.state, stateRevision: 6, current: { ...box.state.current, id: other } };
      return true;
    },
  });
  await runEntrySwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'info');
  assert.match(h.toasts[0].text, /已取消/);
});

test('double trigger in the same frame sends exactly one request (BusyGuard is synchronous)', async () => {
  const h = harness();
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runEntrySwitch(h.deps).finally(() => guard.release());
  };
  await Promise.all([run(), run(), run()]);
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('picker cancellation keeps state and is never reported as success or failure', async () => {
  const h = harness({ switchImpl: async () => okResult('cancelled') });
  await runEntrySwitch(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 0);
});

test('a rejected transport resolves with an understandable error toast, never an unhandled rejection', async () => {
  const h = harness({ switchImpl: async () => { throw new Error('ipc gone'); } });
  await runEntrySwitch(h.deps); // must not throw
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /连接已断开/);
});

test('a Main error code is surfaced through describeCode-style text', async () => {
  const h = harness({ switchImpl: async () => ({ ...okResult(null), ok: false, code: 'WORKSPACE_BUSY' }) });
  await runEntrySwitch(h.deps);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /工作区正忙/);
});

test('a stale-document reply explains that the switch did not happen', async () => {
  const h = harness({ switchImpl: async () => ({ ...okResult(null), ok: false, code: 'STALE_DOCUMENT' }) });
  await runEntrySwitch(h.deps);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /未执行/);
});

test('a blocker appearing after the flush still prevents the picker', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, cleanupPending: true }; return true; },
  });
  await runEntrySwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /清理/);
});
