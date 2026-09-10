import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import { modeSwitchBlockerText, modeSwitchTarget, runModeSwitch } from '../../src/ui/mode-switch.ts';
import { ReviewChannel } from '../../src/ui/review-channel.ts';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { ensureInputFlushed } from '../../src/ui/flush.ts';

const DOC_ID = randomUUID();
const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
async function until(check, message) {
  const limit = Date.now() + 1500;
  while (!check()) { if (Date.now() > limit) throw new Error(message); await delay(5); }
}

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const makeState = (over = {}, currentOver = {}) => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'a.html', mode: 'proofread', input: inputSnapshot(),
    project: { name: '站点', entry: 'pages/a.html' }, persistence: null, ...currentOver },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  ...over,
});
// A real interactive document: fresh id, isolated preview, null input/persistence.
const readonlyState = (over = {}, currentOver = {}) =>
  makeState(over, { id: randomUUID(), mode: 'interactive', input: null, persistence: null, ...currentOver });
const okResult = (outcome, over = {}) => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome, ...over });

function harness({ state = makeState(), composing = false, flush = async () => true, switchImpl = async () => okResult('opened') } = {}) {
  const box = { state };
  const toasts = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    flush: async () => { flushCalls += 1; return flush(box); },
    switchMode: async (documentId, stateRevision, mode) => { calls.push({ documentId, stateRevision, mode }); return switchImpl(box); },
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, box, toasts, calls, flushCalls: () => flushCalls };
}

test('modeSwitchTarget maps both directions and treats a missing mode as proofread', () => {
  assert.equal(modeSwitchTarget('proofread'), 'interactive');
  assert.equal(modeSwitchTarget('interactive'), 'proofread');
  assert.equal(modeSwitchTarget(undefined), 'interactive');
  for (const blocker of ['no-document', 'busy', 'composing', 'workspace-busy', 'cleanup-pending', 'review-required']) {
    assert.ok(modeSwitchBlockerText(blocker).length > 0, blocker);
  }
});

test('proofread switches to interactive using the pinned document id', async () => {
  const h = harness();
  await runModeSwitch(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.deepEqual(h.calls, [{ documentId: DOC_ID, stateRevision: 5, mode: 'interactive' }]);
  assert.equal(h.toasts.length, 0);
});

test('readonly switches back to proofread with a null input snapshot (nothing to drain, still drained)', async () => {
  const h = harness({ state: readonlyState() });
  await runModeSwitch(h.deps);
  assert.equal(h.flushCalls(), 1, 'the actual input owner is still drained even though input is null');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].mode, 'proofread');
  assert.equal(h.calls[0].documentId, h.deps.getState().current.id);
  assert.equal(h.toasts.length, 0);
});

test('the request uses the LATEST stateRevision re-read after the flush', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].stateRevision, 9, 'revision must be re-read after draining, not captured before');
});

test('a document change during the flush cancels the switch and delivers nothing', async () => {
  const other = randomUUID();
  const h = harness({
    flush: async box => {
      box.state = { ...box.state, stateRevision: 6, current: { ...box.state.current, id: other } };
      return true;
    },
  });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'info');
  assert.match(h.toasts[0].text, /已取消/);
});

test('a mode change during the flush cancels instead of double-switching', async () => {
  const h = harness({
    flush: async box => { box.state = readonlyState({}, { id: box.state.current.id }); return true; },
  });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /模式已变化/);
});

test('a failed flush aborts silently (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('a throwing flush is reported once and never reaches Main', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /完成当前输入/);
});

test('composing, busy workspace, cleanup and review-required states block before any flush', async () => {
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  for (const state of [makeState({ phase: 'opening' }), makeState({ cleanupPending: true }),
    makeState({ lastSave: review }), makeState({ lastDeparture: review })]) {
    const h = harness({ state });
    await runModeSwitch(h.deps);
    assert.equal(h.flushCalls(), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].kind, 'error');
  }
  const composing = harness({ composing: true });
  await runModeSwitch(composing.deps);
  assert.equal(composing.flushCalls(), 0);
  assert.match(composing.toasts[0].text, /组词/);
});

test('no current document: no flush, no request, no toast', async () => {
  const h = harness({ state: makeState({ current: null }) });
  await runModeSwitch(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('rapid duplicate triggers send exactly one request (BusyGuard is synchronous)', async () => {
  const h = harness();
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runModeSwitch(h.deps).finally(() => guard.release());
  };
  await Promise.all([run(), run(), run()]);
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('Main review cancellation stays quiet and preserves the current document', async () => {
  const h = harness({ switchImpl: async () => okResult('cancelled') });
  await runModeSwitch(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 0);
});

test('a rejected transport resolves with an error toast, never an unhandled rejection', async () => {
  const h = harness({ switchImpl: async () => { throw new Error('ipc gone'); } });
  await runModeSwitch(h.deps);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /连接已断开/);
});

test('Main error codes are surfaced with understandable text', async () => {
  const cases = [
    ['READ_ONLY_MODE', /返回静态校稿/],
    ['PREVIEW_MODE_UNAVAILABLE', /不支持脚本只读预览/],
    ['STALE_DOCUMENT', /未执行/],
    ['WORKSPACE_BUSY', /工作区正忙/],
    ['INPUT_COMPOSING', /组词/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ switchImpl: async () => ({ ...okResult(null), ok: false, code }) });
    await runModeSwitch(h.deps);
    assert.equal(h.toasts.length, 1, code);
    assert.equal(h.toasts[0].kind, 'error', code);
    assert.match(h.toasts[0].text, pattern, code);
  }
});

// ---- ReviewChannel with a null input (interactive documents) ----

function reviewState(documentId, reviewed = []) {
  return { stateRevision: 1, phase: 'idle', current: {
    id: documentId, name: 'doc.html', mode: 'proofread',
    input: { draftRevision: 3, candidateHash: 'c'.repeat(64), changes: [
      { nodeId: 'n1', oldText: 'a', newText: 'b' }, { nodeId: 'n2', oldText: 'c', newText: 'd' },
    ] },
    project: { name: 'p', entry: 'doc.html', resources: { items: [], truncated: false } },
    persistence: null,
  }, review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null,
    canSave: true, desktop: { revision: 1, role: 'main', panel: 'docked', reviewed, flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null } };
}

function readonlyReviewState(documentId, reviewed = []) {
  const state = reviewState(documentId, reviewed);
  return { ...state, current: { ...state.current, mode: 'interactive', input: null, persistence: null } };
}

test('review toggle and toggle-all on a readonly document send nothing and never throw', async () => {
  const docA = randomUUID();
  const box = { state: readonlyReviewState(docA, ['n1']) };
  const sent = [];
  const channel = new ReviewChannel(() => box.state, async command => {
    sent.push(structuredClone(command));
    return { ok: true, code: null, state: null, documentId: docA, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n2', true);
  channel.toggleAll(true);
  await delay(30);
  assert.equal(sent.length, 0, 'a null input has no review binding; nothing may be sent');
  assert.equal(channel.getStatus().pending, false);
  assert.equal(channel.getStatus().error, null);
  assert.deepEqual(channel.currentReviewed(box.state.desktop.reviewed), ['n1'], 'display falls back to server truth');
});

test('a stale review reply arriving after a mode switch (no sync) stops the chain without touching readonly state', async () => {
  const docA = randomUUID(); const docRo = randomUUID();
  const box = { state: reviewState(docA) };
  const sent = [];
  const gate = barrier();
  const channel = new ReviewChannel(() => box.state, async command => {
    sent.push(structuredClone(command));
    await gate.promise;
    return { ok: true, code: null, state: null, documentId: command.documentId, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 1, 'first review request not sent');
  // Mode switch replaces the document mid-flight: fresh id, input null.
  box.state = readonlyReviewState(docRo);
  gate.release(); // old binding's reply arrives late; no sync() happened
  await until(() => channel.getStatus().pending === false, 'channel did not settle');
  await delay(30);
  assert.equal(sent.length, 1, 'no request may be delivered to the readonly document');
  assert.equal(channel.getStatus().error, null, 'a late reply across a mode change is not an error');
  // Readonly toggles stay inert.
  channel.toggle('n2', true);
  await delay(30);
  assert.equal(sent.length, 1);
});

test('a stale review reply arriving after a mode switch (with sync) clears intent and never marks the new document', async () => {
  const docA = randomUUID(); const docRo = randomUUID(); const docB = randomUUID();
  const box = { state: reviewState(docA) };
  const sent = [];
  const gate = barrier();
  const channel = new ReviewChannel(() => box.state, async command => {
    sent.push(structuredClone(command));
    if (command.documentId === docA) await gate.promise;
    return { ok: true, code: null, state: null, documentId: command.documentId, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 1, 'first review request not sent');
  box.state = readonlyReviewState(docRo);
  channel.sync();
  gate.release();
  await until(() => channel.getStatus().pending === false, 'channel did not settle');
  await delay(30);
  assert.equal(sent.length, 1, 'the readonly document must receive no review request');
  assert.equal(channel.getStatus().error, null);
  // Returning to a fresh proofread document gets a clean binding: the stale
  // readonly reply never leaked into it.
  box.state = reviewState(docB);
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 2, 'new binding intent not delivered');
  assert.equal(sent[1].documentId, docB);
  assert.deepEqual(sent[1].nodeIds, ['n1']);
  await until(() => channel.getStatus().pending === false, 'channel did not settle');
  assert.equal(channel.getStatus().error, null);
});

// ---- Flush and live input with a null input snapshot ----

test('owner-side flush with a null input snapshot resolves true without any session', async () => {
  const controller = new LiveInputController(
    async () => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome: null }),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  assert.equal(controller.getView().phase, 'idle');
  assert.equal(await ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null), true);
  controller.dispose();
});

test('non-owner flush routes flush-input and accepts a null input snapshot as drained', async () => {
  const store = new WorkspaceStore();
  store.accept({ ...readonlyState(), desktop: { revision: 1, role: 'editor', panel: 'floating', reviewed: [], flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null } });
  const commands = [];
  const controller = new LiveInputController(
    async () => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome: null }),
    () => ({ documentId: null, input: null }),
  );
  const ok = await ensureInputFlushed({ owner: false, controller }, store, async command => {
    commands.push(command.kind);
    return { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };
  });
  assert.deepEqual(commands, ['flush-input']);
  assert.equal(ok, true, 'input=null means there is no unapplied input; the switch must not be blocked');
  controller.dispose();
});

test('a live-input controller bound to a null input never sends and never crashes', async () => {
  const calls = [];
  const controller = new LiveInputController(
    async (id, command) => { calls.push(command.kind); return { ok: true, code: null, state: null, documentId: id, copy: null, outcome: null }; },
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  controller.onChange('不应发送');
  controller.onCompositionStart();
  controller.onCompositionEnd('不应发送');
  assert.equal(controller.escape(), false);
  assert.equal(await controller.flush(), true);
  await delay(300);
  assert.equal(calls.length, 0, 'no edit command may be sent for a readonly document');
  assert.equal(controller.getView().phase, 'idle');
  controller.dispose();
});
