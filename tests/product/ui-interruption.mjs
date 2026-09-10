import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import {
  InterruptionDialogLifecycle, interruptionBlocker, interruptionBlockerText, interruptionGate, interruptionGateText,
  interruptionPhaseText, interruptionResultView, runInterruptionCheck,
} from '../../src/ui/interruption-flow.ts';
import { interruptionPickerTitle, interruptionPrompt } from '../../src/main/product/interruption-copy.ts';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { ensureInputFlushed } from '../../src/ui/flush.ts';

const DOC_ID = randomUUID();
const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const interruption = (over = {}) => ({ phase: 'idle', summary: null, result: null, requiresReview: false, ...over });
const desktop = (over = {}) => ({ revision: 1, role: 'main', panel: 'docked', reviewed: [], flush: null,
  pdf: null, pdfBusy: false, error: null, pdfExport: null, interruption: interruption(), ...over });
const makeState = (over = {}) => ({
  stateRevision: 5, phase: 'idle', current: null,
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  desktop: desktop(), ...over,
});
const docState = (over = {}) => makeState({
  current: { id: DOC_ID, name: 'pages/report.html', mode: 'proofread', input: inputSnapshot(),
    project: { name: '站点', entry: 'pages/report.html' }, persistence: null },
  ...over,
});
const saveSummary = (observed, stage = 'committed') => ({ reviewId: randomUUID(), name: '报告.html', kind: 'save', observed, stage });
const compactionSummary = () => ({ reviewId: randomUUID(), name: '报告.html', kind: 'compaction', draftRevision: 3, obsoleteCount: 2 });
const okResult = { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };

function harness({ state = makeState(), composing = false, flush = async () => true, inspectImpl = async () => okResult } = {}) {
  const box = { state };
  const errors = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    flush: async () => { flushCalls += 1; return flush(box); },
    inspect: async stateRevision => { calls.push({ stateRevision }); return inspectImpl(box); },
    onError: text => errors.push(text),
  };
  return { deps, box, errors, calls, flushCalls: () => flushCalls };
}

// ---- Gate and blocker ----

test('interruptionGate tolerates an old Main without the field and reflects phase/requiresReview', () => {
  assert.equal(interruptionGate(null), null);
  assert.equal(interruptionGate({ desktop: undefined }), null, 'old Main has no desktop.interruption');
  assert.equal(interruptionGate({ desktop: { interruption: undefined } }), null, 'optional field may be absent');
  assert.equal(interruptionGate(makeState()), null);
  assert.equal(interruptionGate(makeState({ desktop: desktop({ interruption: interruption({ phase: 'checking' }) }) })), 'main-busy');
  assert.equal(interruptionGate(makeState({ desktop: desktop({ interruption: interruption({ phase: 'reviewing' }) }) })), 'main-busy');
  assert.equal(interruptionGate(makeState({ desktop: desktop({ interruption: interruption({ phase: 'resolving' }) }) })), 'main-busy');
  assert.equal(interruptionGate(makeState({ desktop: desktop({ interruption: interruption({ requiresReview: true }) }) })), 'review-required');
  assert.ok(interruptionGateText('main-busy').length > 0);
  assert.ok(interruptionGateText('review-required').length > 0);
});

test('interruptionBlocker: idle without a document may check; every risk blocks with text', () => {
  const idle = { busy: false, composing: false };
  assert.equal(interruptionBlocker(makeState(), idle), null, 'no document is exactly when a check is allowed');
  assert.equal(interruptionBlocker(docState(), idle), 'has-document');
  const readonlyDoc = docState({ current: { ...docState().current, mode: 'interactive', input: null, persistence: null } });
  assert.equal(interruptionBlocker(readonlyDoc, idle), 'has-document', 'readonly interactive document also blocks');
  assert.equal(interruptionBlocker(makeState(), { busy: true, composing: false }), 'busy');
  assert.equal(interruptionBlocker(makeState(), { busy: false, composing: true }), 'composing');
  for (const phase of ['choosing', 'opening', 'reviewing', 'saving', 'committing', 'disposed']) {
    assert.equal(interruptionBlocker(makeState({ phase }), idle), 'workspace-busy', phase);
  }
  assert.equal(interruptionBlocker(makeState({ cleanupPending: true }), idle), 'cleanup-pending');
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  assert.equal(interruptionBlocker(makeState({ lastSave: review }), idle), 'review-required');
  assert.equal(interruptionBlocker(makeState({ lastDeparture: review }), idle), 'review-required');
  assert.equal(interruptionBlocker(makeState({ desktop: desktop({ interruption: interruption({ phase: 'checking' }) }) }), idle), 'interruption-busy');
  assert.equal(interruptionBlocker(makeState({ desktop: desktop({ interruption: interruption({ requiresReview: true }) }) }), idle), 'interruption-review');
  for (const blocker of ['has-document', 'busy', 'composing', 'workspace-busy', 'cleanup-pending', 'review-required', 'interruption-busy', 'interruption-review']) {
    assert.ok(interruptionBlockerText(blocker).length > 0, blocker);
  }
  assert.match(interruptionBlockerText('has-document'), /打开文档前/);
});

test('interruptionPhaseText renders readable text for every Main phase except idle', () => {
  assert.equal(interruptionPhaseText('idle'), null);
  for (const phase of ['checking', 'reviewing', 'resolving']) {
    assert.ok(interruptionPhaseText(phase).length > 0, phase);
  }
});

// ---- runInterruptionCheck flow ----

test('no document: the input owner is drained first, then the LATEST revision is sent', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 1, 'never infer "no pending input" from a snapshot');
  assert.deepEqual(h.calls, [{ stateRevision: 9 }], 'revision must be re-read after draining');
  assert.equal(h.errors.length, 0);
});

test('an open document never sends: no flush, no inspect, restart explanation', async () => {
  const h = harness({ state: docState() });
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /打开文档前/);
});

test('composing blocks before any flush', async () => {
  const h = harness({ composing: true });
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /组词/);
});

test('workspace busy, cleanup, save/departure review and Main busy/requiresReview block before any flush', async () => {
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  const states = [
    makeState({ phase: 'saving' }),
    makeState({ cleanupPending: true }),
    makeState({ lastSave: review }),
    makeState({ lastDeparture: review }),
    makeState({ desktop: desktop({ interruption: interruption({ phase: 'reviewing' }) }) }),
    makeState({ desktop: desktop({ interruption: interruption({ requiresReview: true }) }) }),
  ];
  for (const state of states) {
    const h = harness({ state });
    await runInterruptionCheck(h.deps);
    assert.equal(h.flushCalls(), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.errors.length, 1);
  }
});

test('a document appearing during the flush cancels the check and delivers nothing', async () => {
  const h = harness({
    flush: async box => { box.state = docState({ stateRevision: 6 }); return true; },
  });
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0, 'a late document must never receive the command');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /已取消/);
});

test('a blocker appearing during the flush still prevents the command', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, cleanupPending: true }; return true; },
  });
  await runInterruptionCheck(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /清理/);
});

test('a failed flush aborts silently (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
});

test('a throwing flush is reported once and never reaches Main', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runInterruptionCheck(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /完成当前输入/);
});

test('same-frame duplicate clicks send exactly one command and release the guard', async () => {
  const gate = barrier();
  const h = harness({ inspectImpl: async () => { await gate.promise; return okResult; } });
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runInterruptionCheck(h.deps).finally(() => guard.release());
  };
  const pending = Promise.all([run(), run(), run()]);
  gate.release();
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('a rejected transport settles with an understandable error, never an unhandled rejection', async () => {
  const h = harness({ inspectImpl: async () => { throw new Error('ipc gone'); } });
  await runInterruptionCheck(h.deps); // must not throw
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /连接已断开/);
});

test('ok is only a transport ack: no error, no success claim, dialog untouched', async () => {
  const h = harness();
  await runInterruptionCheck(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0, 'the outcome arrives through onState, never through ok');
});

test('Main refusals map to specific explanations', async () => {
  const cases = [
    ['INTERRUPTION_BUSY', /正在进行/],
    ['INTERRUPTION_REVIEW_REQUIRED', /人工检查/],
    ['INTERRUPTION_RESTART_REQUIRED', /打开文档前/],
    ['INTERRUPTION_UNCLASSIFIED', /无法识别/],
    ['STALE_WORKSPACE', /已变化/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ inspectImpl: async () => ({ ...okResult, ok: false, code }) });
    await runInterruptionCheck(h.deps);
    assert.equal(h.calls.length, 1);
    assert.equal(h.errors.length, 1, code);
    assert.match(h.errors[0], pattern, code);
  }
});

test('a missing workspace state does nothing at all', async () => {
  const h = harness();
  h.box.state = null;
  await runInterruptionCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
});

// ---- Result rendering from Main-published state ----

test('no result renders nothing; cancelled stays quiet and re-checkable', () => {
  assert.equal(interruptionResultView(null), null);
  assert.equal(interruptionResultView(interruption()), null);
  const view = interruptionResultView(interruption({ result: { status: 'cancelled', code: null } }));
  assert.equal(view.tone, 'info');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /未修改/);
});

test('unavailable never claims all records or files are healthy', () => {
  const view = interruptionResultView(interruption({ result: { status: 'unavailable', code: 'INTERRUPTION_NOT_FOUND' } }));
  assert.equal(view.tone, 'info');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /未发现/);
  assert.match(view.detail, /不代表所有历史记录或文件都健康/);
});

test('failed keeps the error and data, allows a manual re-check, never auto-retries', () => {
  const view = interruptionResultView(interruption({ result: { status: 'failed', code: 'INTERRUPTION_CHECK_FAILED' } }));
  assert.equal(view.tone, 'error');
  assert.equal(view.code, 'INTERRUPTION_CHECK_FAILED');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /保留/);
});

test('unknown and requiresReview never offer a direct retry and keep the window', () => {
  const unknown = interruptionResultView(interruption({
    result: { status: 'unknown', code: 'SAVE_UNKNOWN' }, requiresReview: true,
  }));
  assert.equal(unknown.tone, 'error');
  assert.equal(unknown.canCheckAgain, false);
  assert.match(unknown.text, /未知/);
  assert.match(unknown.detail, /不要重试|请勿重试/);
  // Renderer reload with Main already requiring review: same treatment.
  const reloaded = interruptionResultView(interruption({
    result: { status: 'resolved', code: 'SAVE_CLEANUP_REQUIRED' }, requiresReview: true,
  }));
  assert.equal(reloaded.canCheckAgain, false);
  assert.equal(reloaded.tone, 'warn');
  assert.match(reloaded.text, /警告/);
});

test('resolved save results distinguish the four observations in plain Chinese', () => {
  const baseline = interruptionResultView(interruption({
    summary: saveSummary('baseline-matches', 'prepared'), result: { status: 'resolved', code: null },
  }));
  assert.equal(baseline.tone, 'ok');
  assert.match(baseline.text, /保存前的版本/);
  assert.match(baseline.detail, /不代表上次保存成功/);

  const committed = interruptionResultView(interruption({
    summary: saveSummary('committed-matches'), result: { status: 'resolved', code: null },
  }));
  assert.equal(committed.tone, 'ok');
  assert.match(committed.text, /已在文件中/);

  for (const observed of ['candidate-on-disk', 'conflict']) {
    const view = interruptionResultView(interruption({
      summary: saveSummary(observed, 'replacing'), result: { status: 'resolved', code: null },
    }));
    assert.equal(view.tone, 'ok', observed);
    assert.match(view.text, /保留当前文件/, observed);
    assert.match(view.detail, /不代表上次保存成功/, observed);
    assert.match(view.detail, /不会重放|不会被重放/, observed);
  }
});

test('resolved compaction never claims new edits are durable or HTML was saved', () => {
  const view = interruptionResultView(interruption({
    summary: compactionSummary(), result: { status: 'resolved', code: null },
  }));
  assert.equal(view.tone, 'ok');
  assert.match(view.text, /清理完成/);
  assert.match(view.text, /2 个/);
  assert.match(view.detail, /不等于新修改已持久化/);
  assert.match(view.detail, /HTML 文件未被修改/);
});

test('a resolved result with a warning code is not a clean success', () => {
  const view = interruptionResultView(interruption({
    summary: compactionSummary(), result: { status: 'resolved', code: 'DRAFT_COMPACTION_PARTIAL' },
  }));
  assert.equal(view.tone, 'warn');
  assert.equal(view.canCheckAgain, false);
});

// ---- Dialog lifecycle: synchronous latch, replacement and unmount ----

test('the action latch blocks a same-event-loop close and reopen before any render', async () => {
  const life = new InterruptionDialogLifecycle();
  const gen = life.open();
  assert.notEqual(gen, null);
  const gate = barrier();
  const h = harness({ inspectImpl: async () => { await gate.promise; return okResult; } });
  const errors = [];
  const pending = (async () => {
    assert.equal(life.acquire(), true, 'claimed synchronously inside the acquired busy guard');
    try {
      await runInterruptionCheck({ ...h.deps, onError: text => { if (life.isCurrent(gen)) errors.push(text); } });
    } finally {
      life.release();
    }
  })();
  // Escape/close and a menu reopen in the same event loop, before any render:
  assert.equal(life.close(), false, 'close cannot hide the accepted check');
  assert.equal(life.open(), null, 'reopen cannot reset the accepted check');
  assert.equal(life.isCurrent(gen), true, 'the in-flight generation survives');
  gate.release();
  await pending;
  assert.equal(h.calls.length, 1, 'exactly one check ran');
  assert.equal(life.close(), true, 'close works again once the latch settles');
});

test('dispose on unmount invalidates outstanding generations and never strands the latch', async () => {
  const life = new InterruptionDialogLifecycle();
  const gen = life.open();
  assert.equal(life.acquire(), true);
  const gate = barrier();
  const h = harness({ inspectImpl: async () => { await gate.promise; throw new Error('ipc gone'); } });
  const errors = [];
  const pending = (async () => {
    try {
      await runInterruptionCheck({ ...h.deps, onError: text => { if (life.isCurrent(gen)) errors.push(text); } });
    } finally {
      life.release();
    }
  })();
  await delay(0);
  life.dispose(); // the window unmounted mid-flight
  assert.equal(life.isCurrent(gen), false, 'a late result can never touch a successor');
  gate.release();
  await pending;
  assert.equal(errors.length, 0, 'the late rejection is dropped');
  assert.equal(life.acquire(), true, 'the latch never stays stuck after disposal');
});

test('a late error bound to a replaced dialog is dropped', async () => {
  const life = new InterruptionDialogLifecycle();
  const gen = life.open();
  let currentDialog = 'interruption';
  const gate = barrier();
  const h = harness({ inspectImpl: async () => { await gate.promise; return { ...okResult, ok: false, code: 'STALE_WORKSPACE' }; } });
  const errors = [];
  const belongs = () => life.isCurrent(gen) && currentDialog === 'interruption';
  const pending = runInterruptionCheck({ ...h.deps, onError: text => { if (belongs()) errors.push(text); } });
  currentDialog = 'resources'; // the user opened another dialog through the existing UI
  gate.release();
  await pending;
  assert.equal(errors.length, 0, 'the replacement dialog is never touched');
});

// ---- Real input controllers behind the flush contract ----

test('IME composition on the real owner controller blocks the check (flush returns false)', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: true, code: null, state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: null, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  controller.onCompositionStart();
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runInterruptionCheck(h.deps);
  assert.equal(h.calls.length, 0, 'the check must not start while composing');
  assert.equal(h.errors.length, 0, 'the flush path owns the explanation');
  assert.equal(controller.isComposing(), true);
  controller.dispose();
});

test('a failed owner input (begin rejected) blocks the check and preserves local text', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: false, code: 'SELECTION_STALE', state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  await controller.begin('n1:1:s:g', { nodeId: 'n1' }, 3);
  assert.equal(controller.getView().phase, 'failed');
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runInterruptionCheck(h.deps);
  assert.equal(h.calls.length, 0, 'unflushed failed input must not start a check');
  assert.equal(h.errors.length, 0);
  controller.dispose();
});

test('non-owner flush routes flush-input through Main before the check starts', async () => {
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
  await runInterruptionCheck(h.deps);
  assert.deepEqual(commands, ['flush-input'], 'the actual owner window is drained through Main');
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0);
  controller.dispose();
});

// ---- Native copy: structural contracts, never verbatim snapshots ----

test('native copy: both kinds expose the five frozen fields, cancel stays cancel', () => {
  assert.equal(typeof interruptionPickerTitle, 'string');
  assert.ok(interruptionPickerTitle.length > 0);
  for (const summary of [saveSummary('baseline-matches', 'prepared'), saveSummary('committed-matches'),
    saveSummary('candidate-on-disk', 'replacing'), saveSummary('conflict', 'committed'), compactionSummary()]) {
    const copy = interruptionPrompt(summary);
    assert.ok(Object.isFrozen(copy));
    assert.deepEqual(Object.keys(copy).sort(), ['cancel', 'confirm', 'detail', 'message', 'title']);
    for (const key of ['title', 'message', 'detail', 'cancel', 'confirm']) {
      assert.ok(copy[key].length > 0, `${summary.kind}:${key}`);
    }
    assert.equal(copy.cancel, '取消');
    assert.match(copy.message, /报告\.html/, 'the product file name may be shown');
    assert.ok(!/恢复原文件|保存成功|强制退出/.test(`${copy.title}${copy.message}${copy.confirm}`),
      'title/message/confirm never call keep-current "restore the original" or a save success, nor suggest force-quitting');
    assert.ok(!/强制退出/.test(copy.detail), 'detail never suggests force-quitting');
  }
});

test('native copy: save confirm keeps the current file; compaction confirm continues cleanup only', () => {
  const save = interruptionPrompt(saveSummary('baseline-matches', 'prepared'));
  assert.match(save.confirm, /保留当前文件/);
  const cleanup = interruptionPrompt(compactionSummary());
  assert.match(cleanup.confirm, /继续清理旧记录/);
  assert.match(cleanup.detail, /2 个/);
  assert.match(cleanup.detail, /不会修改 HTML 文件/);
  assert.notEqual(save.confirm, cleanup.confirm);
  for (const observed of ['baseline-matches', 'committed-matches', 'candidate-on-disk', 'conflict']) {
    const detail = interruptionPrompt(saveSummary(observed, 'committed')).detail;
    assert.ok(detail.length > 0, observed);
    if (observed === 'candidate-on-disk' || observed === 'conflict') {
      assert.match(detail, /不代表上次保存成功/, observed);
    }
  }
});
