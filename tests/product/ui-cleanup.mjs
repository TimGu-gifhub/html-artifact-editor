import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import {
  CleanupDialogLifecycle, cleanupBlocker, cleanupBlockerText, cleanupGate, cleanupGateText,
  cleanupPhaseText, cleanupResultView, runCleanupCheck,
} from '../../src/ui/cleanup-flow.ts';
import { cleanupPrompt } from '../../src/main/product/cleanup-copy.ts';
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
const cleanup = (over = {}) => ({ phase: 'idle', summary: null, result: null, requiresReview: false, ...over });
const desktop = (over = {}) => ({ revision: 1, role: 'main', panel: 'docked', reviewed: [], flush: null,
  pdf: null, pdfBusy: false, error: null, pdfExport: null, interruption: interruption(), cleanup: cleanup(), ...over });
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
const cleanupSummary = (over = {}) => ({ reviewId: randomUUID(), resuming: false,
  records: 4, sessions: 2, unsavedDrafts: 1, backups: 1, bytes: 2048, ...over });
const okResult = { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };

function harness({ state = makeState(), composing = false, flush = async () => true, clearImpl = async () => okResult } = {}) {
  const box = { state };
  const errors = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    flush: async () => { flushCalls += 1; return flush(box); },
    clear: async stateRevision => { calls.push({ stateRevision }); return clearImpl(box); },
    onError: text => errors.push(text),
  };
  return { deps, box, errors, calls, flushCalls: () => flushCalls };
}

// ---- Gate and blocker ----

test('cleanupGate tolerates an old Main without the field and reflects phase/requiresReview', () => {
  assert.equal(cleanupGate(null), null);
  assert.equal(cleanupGate({ desktop: undefined }), null, 'old Main has no desktop.cleanup');
  assert.equal(cleanupGate({ desktop: { cleanup: undefined } }), null, 'optional field may be absent');
  assert.equal(cleanupGate(makeState()), null);
  assert.equal(cleanupGate(makeState({ desktop: desktop({ cleanup: cleanup({ phase: 'checking' }) }) })), 'main-busy');
  assert.equal(cleanupGate(makeState({ desktop: desktop({ cleanup: cleanup({ phase: 'reviewing' }) }) })), 'main-busy');
  assert.equal(cleanupGate(makeState({ desktop: desktop({ cleanup: cleanup({ phase: 'cleaning' }) }) })), 'main-busy');
  assert.equal(cleanupGate(makeState({ desktop: desktop({ cleanup: cleanup({ requiresReview: true }) }) })), 'review-required');
  assert.ok(cleanupGateText('main-busy').length > 0);
  assert.ok(cleanupGateText('review-required').length > 0);
});

test('cleanupBlocker: idle without a document may check; every risk blocks with text', () => {
  const idle = { busy: false, composing: false };
  assert.equal(cleanupBlocker(makeState(), idle), null, 'no document is exactly when a check is allowed');
  assert.equal(cleanupBlocker(docState(), idle), 'has-document');
  const readonlyDoc = docState({ current: { ...docState().current, mode: 'interactive', input: null, persistence: null } });
  assert.equal(cleanupBlocker(readonlyDoc, idle), 'has-document', 'readonly interactive document also blocks');
  assert.equal(cleanupBlocker(makeState({ desktop: { ...desktop(), cleanup: undefined } }), idle), 'no-main-state');
  assert.equal(cleanupBlocker(makeState(), { busy: true, composing: false }), 'busy');
  assert.equal(cleanupBlocker(makeState(), { busy: false, composing: true }), 'composing');
  for (const phase of ['choosing', 'opening', 'reviewing', 'saving', 'committing', 'disposed']) {
    assert.equal(cleanupBlocker(makeState({ phase }), idle), 'workspace-busy', phase);
  }
  assert.equal(cleanupBlocker(makeState({ cleanupPending: true }), idle), 'cleanup-pending');
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  assert.equal(cleanupBlocker(makeState({ lastSave: review }), idle), 'review-required');
  assert.equal(cleanupBlocker(makeState({ lastDeparture: review }), idle), 'review-required');
  assert.equal(cleanupBlocker(makeState({ desktop: desktop({ interruption: interruption({ phase: 'checking' }) }) }), idle), 'interruption-busy');
  assert.equal(cleanupBlocker(makeState({ desktop: desktop({ interruption: interruption({ requiresReview: true }) }) }), idle), 'interruption-review');
  assert.equal(cleanupBlocker(makeState({ desktop: desktop({ cleanup: cleanup({ phase: 'cleaning' }) }) }), idle), 'cleanup-busy');
  assert.equal(cleanupBlocker(makeState({ desktop: desktop({ cleanup: cleanup({ requiresReview: true }) }) }), idle), 'cleanup-review');
  for (const blocker of ['has-document', 'no-main-state', 'busy', 'composing', 'workspace-busy', 'cleanup-pending',
    'review-required', 'interruption-busy', 'interruption-review', 'cleanup-busy', 'cleanup-review']) {
    assert.ok(cleanupBlockerText(blocker).length > 0, blocker);
  }
  assert.match(cleanupBlockerText('has-document'), /打开文档前/);
});

test('cleanupPhaseText renders readable text for every Main phase except idle', () => {
  assert.equal(cleanupPhaseText('idle'), null);
  for (const phase of ['checking', 'reviewing', 'cleaning']) {
    assert.ok(cleanupPhaseText(phase).length > 0, phase);
  }
});

// ---- runCleanupCheck flow ----

test('no document: the input owner is drained first, then the LATEST revision is sent', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 1, 'never infer "no pending input" from a snapshot');
  assert.deepEqual(h.calls, [{ stateRevision: 9 }], 'revision must be re-read after draining');
  assert.equal(h.errors.length, 0);
});

test('an open document never sends: no flush, no clear, restart explanation', async () => {
  const h = harness({ state: docState() });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /打开文档前/);
});

test('a missing Main cleanup state never sends and explains', async () => {
  const h = harness({ state: makeState({ desktop: { ...desktop(), cleanup: undefined } }) });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /未提供/);
});

test('composing blocks before any flush', async () => {
  const h = harness({ composing: true });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /组词/);
});

test('workspace busy, cleanup, save/departure review, interruption and cleanup gates block before any flush', async () => {
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  const states = [
    makeState({ phase: 'saving' }),
    makeState({ cleanupPending: true }),
    makeState({ lastSave: review }),
    makeState({ lastDeparture: review }),
    makeState({ desktop: desktop({ interruption: interruption({ phase: 'reviewing' }) }) }),
    makeState({ desktop: desktop({ interruption: interruption({ requiresReview: true }) }) }),
    makeState({ desktop: desktop({ cleanup: cleanup({ phase: 'checking' }) }) }),
    makeState({ desktop: desktop({ cleanup: cleanup({ requiresReview: true }) }) }),
  ];
  for (const state of states) {
    const h = harness({ state });
    await runCleanupCheck(h.deps);
    assert.equal(h.flushCalls(), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.errors.length, 1);
  }
});

test('a document appearing during the flush cancels the flow and delivers nothing', async () => {
  const h = harness({
    flush: async box => { box.state = docState({ stateRevision: 6 }); return true; },
  });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0, 'a late document must never receive the command');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /已取消/);
});

test('a blocker appearing during the flush still prevents the command', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, cleanupPending: true }; return true; },
  });
  await runCleanupCheck(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /临时文件/);
});

test('a failed flush aborts silently (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
});

test('a throwing flush is reported once and never reaches Main', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runCleanupCheck(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /完成当前输入/);
});

test('same-frame duplicate clicks send exactly one command and release the guard', async () => {
  const gate = barrier();
  const h = harness({ clearImpl: async () => { await gate.promise; return okResult; } });
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runCleanupCheck(h.deps).finally(() => guard.release());
  };
  const pending = Promise.all([run(), run(), run()]);
  gate.release();
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('a rejected transport settles with an understandable error, never an unhandled rejection', async () => {
  const h = harness({ clearImpl: async () => { throw new Error('ipc gone'); } });
  await runCleanupCheck(h.deps); // must not throw
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /连接已断开/);
});

test('ok is only a transport ack: no error, no success claim, dialog untouched', async () => {
  const h = harness();
  await runCleanupCheck(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0, 'the outcome arrives through onState, never through ok');
});

test('Main refusals map to specific explanations', async () => {
  const cases = [
    ['RECORD_CLEANUP_BUSY', /正在进行/],
    ['RECORD_CLEANUP_REVIEW_REQUIRED', /人工检查/],
    ['RECORD_CLEANUP_RESTART_REQUIRED', /打开文档前/],
    ['RECORD_CLEANUP_UNAVAILABLE', /不可用/],
    ['INTERRUPTION_BUSY', /中断/],
    ['INTERRUPTION_REVIEW_REQUIRED', /中断处理结果/],
    ['STALE_WORKSPACE', /已变化/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ clearImpl: async () => ({ ...okResult, ok: false, code }) });
    await runCleanupCheck(h.deps);
    assert.equal(h.calls.length, 1);
    assert.equal(h.errors.length, 1, code);
    assert.match(h.errors[0], pattern, code);
  }
});

test('a missing workspace state does nothing at all', async () => {
  const h = harness();
  h.box.state = null;
  await runCleanupCheck(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 0);
});

// ---- Result rendering from Main-published state ----

test('no result renders nothing; cancelled stays quiet and re-checkable', () => {
  assert.equal(cleanupResultView(null), null);
  assert.equal(cleanupResultView(cleanup()), null);
  const view = cleanupResultView(cleanup({ result: { status: 'cancelled', code: null } }));
  assert.equal(view.tone, 'info');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /本次没有继续删除/, 'only this attempt is guaranteed not to have deleted');
  assert.equal(view.detail, null, 'a fresh-plan cancel stays quiet without claiming success');
  assert.ok(!/成功|完成：|未删除任何/.test(view.text), 'cancelled never looks like a success or a full undo');
});

test('cancelled while resuming admits an earlier interruption may have deleted a prefix', () => {
  const view = cleanupResultView(cleanup({
    summary: cleanupSummary({ resuming: true }), result: { status: 'cancelled', code: null },
  }));
  assert.equal(view.tone, 'info');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /本次没有继续删除/);
  assert.match(view.detail, /上次中断前可能已删除部分记录/);
  assert.match(view.detail, /剩余的记录保持不变/);
  assert.ok(!/成功|清理完成/.test(`${view.text}${view.detail}`), 'a resumed cancel never claims success');
});

test('unavailable with RECORD_CLEANUP_EMPTY means nothing to clean, never a deletion', () => {
  const view = cleanupResultView(cleanup({ result: { status: 'unavailable', code: 'RECORD_CLEANUP_EMPTY' } }));
  assert.equal(view.tone, 'info');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /没有可清理/);
  assert.match(view.detail, /源文件不受影响/);
  const other = cleanupResultView(cleanup({ result: { status: 'unavailable', code: 'RECORD_CLEANUP_UNAVAILABLE' } }));
  assert.equal(other.tone, 'info');
  assert.equal(other.canCheckAgain, true);
});

test('failed only guarantees this attempt deleted nothing; a manual re-check stays allowed', () => {
  const view = cleanupResultView(cleanup({ result: { status: 'failed', code: 'RECORD_CLEANUP_FAILED' } }));
  assert.equal(view.tone, 'error');
  assert.equal(view.code, 'RECORD_CLEANUP_FAILED');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /本次没有继续删除/);
  assert.match(view.text, /剩余的记录保持不变/);
  assert.ok(!/保持原样|未删除任何/.test(view.text), 'an earlier interrupted attempt may have deleted a prefix');
  assert.match(view.detail, /重新发起检查/);
});

test('failed inventory/verification codes point at unverified records or a changed scene, never at retry as a fix', () => {
  const recovery = cleanupResultView(cleanup({ result: { status: 'failed', code: 'RECORD_CLEANUP_RECOVERY_REQUIRED' } }));
  assert.equal(recovery.tone, 'error');
  assert.equal(recovery.canCheckAgain, true);
  assert.match(recovery.text, /尚未核实/);
  assert.match(recovery.text, /上次中断/);
  assert.match(recovery.text, /本次没有继续删除/);
  assert.match(recovery.detail, /反复重试不能修好/);
  for (const code of ['RECORD_CLEANUP_INVALID', 'RECORD_CLEANUP_CHANGED', 'RECORD_CLEANUP_ROOT_MISMATCH']) {
    const view = cleanupResultView(cleanup({ result: { status: 'failed', code } }));
    assert.equal(view.tone, 'error', code);
    assert.equal(view.canCheckAgain, true, code);
    assert.match(view.text, /已发生变化|无法核实/, code);
    assert.match(view.text, /本次没有继续删除/, code);
    assert.match(view.detail, /上次中断/, code);
    assert.match(view.detail, /反复重试/, code);
  }
});

test('Main refusals for unverified records or a changed scene explain instead of offering a fix', async () => {
  const cases = [
    ['RECORD_CLEANUP_RECOVERY_REQUIRED', /尚未核实|上次中断/],
    ['RECORD_CLEANUP_INVALID', /发生变化|无法核实/],
    ['RECORD_CLEANUP_CHANGED', /发生变化|无法核实/],
    ['RECORD_CLEANUP_ROOT_MISMATCH', /发生变化|无法核实/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ clearImpl: async () => ({ ...okResult, ok: false, code }) });
    await runCleanupCheck(h.deps);
    assert.equal(h.errors.length, 1, code);
    assert.match(h.errors[0], pattern, code);
    assert.match(h.errors[0], /上次中断/, code);
    assert.ok(!/强制清理|手动删除/.test(h.errors[0]), `${code} never offers forced cleanup or path operations`);
  }
});

test('unknown and requiresReview never offer a direct retry and keep the window', () => {
  const unknown = cleanupResultView(cleanup({
    result: { status: 'unknown', code: 'RECORD_CLEANUP_PROFILE_MISMATCH' }, requiresReview: true,
  }));
  assert.equal(unknown.tone, 'error');
  assert.equal(unknown.canCheckAgain, false);
  assert.match(unknown.text, /未知/);
  assert.match(unknown.text, /可能已被删除/);
  assert.match(unknown.text, /无法恢复/, 'deleted records are never implied recoverable');
  assert.match(unknown.detail, /内存中的清理证据已保留/, 'the retention window is named, including Main in-memory evidence');
  assert.match(unknown.detail, /请勿重试/);
  assert.match(unknown.detail, /强制退出/);
  assert.ok(!/所有记录|全部.*已保留|记录与证据已保留/.test(`${unknown.text}${unknown.detail}`),
    'unknown must not claim every record or piece of evidence survived');
  // Renderer reload with Main already requiring review: same treatment.
  const reloaded = cleanupResultView(cleanup({
    result: { status: 'cleared', code: 'RECORD_CLEANUP_CLEANUP_WARNING' }, requiresReview: true,
  }));
  assert.equal(reloaded.canCheckAgain, false);
  assert.equal(reloaded.tone, 'warn');
  assert.match(reloaded.text, /警告/);
});

test('confirmed-with-warning admits deleted records and the manifest may already be gone', () => {
  for (const requiresReview of [true, false]) {
    const view = cleanupResultView(cleanup({
      summary: cleanupSummary(), result: { status: 'cleared', code: 'RECORD_CLEANUP_CONFIRMED_WITH_WARNING' }, requiresReview,
    }));
    assert.equal(view.tone, 'warn', `requiresReview=${requiresReview}`);
    assert.equal(view.canCheckAgain, false, `requiresReview=${requiresReview}`);
    assert.match(view.text, /警告/, `requiresReview=${requiresReview}`);
    assert.match(view.text, /无法恢复/, `requiresReview=${requiresReview}`);
    assert.ok(!/记录与证据已保留|所有.*已保留/.test(view.text), `requiresReview=${requiresReview}`);
    assert.match(view.detail, /强制退出|请勿重复操作/, `requiresReview=${requiresReview}`);
  }
  const reviewing = cleanupResultView(cleanup({
    result: { status: 'cleared', code: 'RECORD_CLEANUP_CONFIRMED_WITH_WARNING' }, requiresReview: true,
  }));
  assert.match(reviewing.text, /私有目录|清理清单/, 'the finish-callback failure may have emptied the private directory');
});

test('cleared reports the deleted counts, the untouched sources and the lost recovery', () => {
  const view = cleanupResultView(cleanup({
    summary: cleanupSummary(), result: { status: 'cleared', code: null },
  }));
  assert.equal(view.tone, 'ok');
  assert.equal(view.canCheckAgain, true);
  assert.match(view.text, /清理完成/);
  assert.match(view.text, /已删除 4 条记录/);
  assert.match(view.text, /2 个校稿会话/);
  assert.match(view.text, /1 份含修改的草稿记录/);
  assert.ok(!/未保存草稿/.test(view.text), 'draft records with changes are not proof of unsaved content');
  assert.match(view.text, /1 份应用备份/);
  assert.match(view.detail, /源 HTML、CSS、PDF 与项目文件未被修改/);
  assert.match(view.detail, /无法恢复/);
});

test('cleared while resuming reports the ORIGINAL manifest as finished, not this run\'s deletions', () => {
  const view = cleanupResultView(cleanup({
    summary: cleanupSummary({ resuming: true }), result: { status: 'cleared', code: null },
  }));
  assert.equal(view.tone, 'ok');
  assert.match(view.text, /原清单已清理完毕/);
  assert.match(view.text, /上次已确认/);
  assert.match(view.text, /部分记录可能已在上次中断前被删除/);
  assert.match(view.text, /1 份含修改的草稿记录/);
  assert.ok(!/未保存草稿|检查发现|本次删除|本次已删除/.test(view.text),
    'resuming counts are the old manifest, not a fresh inventory or this run\'s deletions');
  assert.match(view.detail, /无法恢复/);
});

test('a cleared result with a warning code is not a clean success and never retries', () => {
  const view = cleanupResultView(cleanup({
    summary: cleanupSummary(), result: { status: 'cleared', code: 'RECORD_CLEANUP_CLEANUP_WARNING' }, requiresReview: true,
  }));
  assert.equal(view.tone, 'warn');
  assert.equal(view.canCheckAgain, false);
  assert.match(view.text, /警告/);
  assert.match(view.text, /无法恢复/);
});

// ---- Dialog lifecycle: synchronous latch, replacement and unmount ----

test('the action latch blocks a same-event-loop close and reopen before any render', async () => {
  const life = new CleanupDialogLifecycle();
  const gen = life.open();
  assert.notEqual(gen, null);
  const gate = barrier();
  const h = harness({ clearImpl: async () => { await gate.promise; return okResult; } });
  const errors = [];
  const pending = (async () => {
    assert.equal(life.acquire(), true, 'claimed synchronously inside the acquired busy guard');
    try {
      await runCleanupCheck({ ...h.deps, onError: text => { if (life.isCurrent(gen)) errors.push(text); } });
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
  const life = new CleanupDialogLifecycle();
  const gen = life.open();
  assert.equal(life.acquire(), true);
  const gate = barrier();
  const h = harness({ clearImpl: async () => { await gate.promise; throw new Error('ipc gone'); } });
  const errors = [];
  const pending = (async () => {
    try {
      await runCleanupCheck({ ...h.deps, onError: text => { if (life.isCurrent(gen)) errors.push(text); } });
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
  const life = new CleanupDialogLifecycle();
  const gen = life.open();
  let currentDialog = 'cleanup';
  const gate = barrier();
  const h = harness({ clearImpl: async () => { await gate.promise; return { ...okResult, ok: false, code: 'STALE_WORKSPACE' }; } });
  const errors = [];
  const belongs = () => life.isCurrent(gen) && currentDialog === 'cleanup';
  const pending = runCleanupCheck({ ...h.deps, onError: text => { if (belongs()) errors.push(text); } });
  currentDialog = 'resources'; // the user opened another dialog through the existing UI
  gate.release();
  await pending;
  assert.equal(errors.length, 0, 'the replacement dialog is never touched');
});

// ---- Real input controllers behind the flush contract ----

test('IME composition on the real owner controller blocks the flow (flush returns false)', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: true, code: null, state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: null, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  controller.onCompositionStart();
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runCleanupCheck(h.deps);
  assert.equal(h.calls.length, 0, 'the check must not start while composing');
  assert.equal(h.errors.length, 0, 'the flush path owns the explanation');
  assert.equal(controller.isComposing(), true);
  controller.dispose();
});

test('a failed owner input (begin rejected) blocks the flow and preserves local text', async () => {
  const controller = new LiveInputController(
    async id => ({ ok: false, code: 'SELECTION_STALE', state: null, documentId: id, copy: null, outcome: null }),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  await controller.begin('n1:1:s:g', { nodeId: 'n1' }, 3);
  assert.equal(controller.getView().phase, 'failed');
  const h = harness({ flush: () => ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null) });
  await runCleanupCheck(h.deps);
  assert.equal(h.calls.length, 0, 'unflushed failed input must not start a cleanup');
  assert.equal(h.errors.length, 0);
  controller.dispose();
});

test('non-owner flush routes flush-input through Main before the flow starts', async () => {
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
  await runCleanupCheck(h.deps);
  assert.deepEqual(commands, ['flush-input'], 'the actual owner window is drained through Main');
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0);
  controller.dispose();
});

// ---- Native copy: structural contracts, never verbatim snapshots ----

test('native copy: both modes expose the five frozen fields, cancel stays cancel and default', () => {
  for (const summary of [cleanupSummary(), cleanupSummary({ resuming: true })]) {
    const copy = cleanupPrompt(summary);
    assert.ok(Object.isFrozen(copy));
    assert.deepEqual(Object.keys(copy).sort(), ['cancel', 'confirm', 'detail', 'message', 'title']);
    for (const key of ['title', 'message', 'detail', 'cancel', 'confirm']) {
      assert.ok(copy[key].length > 0, `${summary.resuming}:${key}`);
    }
    assert.equal(copy.cancel, '取消', 'the native default/cancelId binds to this button');
    assert.match(copy.detail, /2 个校稿会话/);
    assert.match(copy.detail, /1 份含修改的草稿记录/);
    assert.match(copy.detail, /可能包含尚未保存的修改/, 'changed draft records may still hold unsaved edits');
    assert.ok(!/未保存草稿/.test(`${copy.title}${copy.message}${copy.detail}`),
      'a changed draft record is not proof the change is absent from disk');
    assert.match(copy.detail, /1 份应用备份/);
    assert.match(copy.detail, /KB|字节|MB/, 'bytes are explained in readable units');
    assert.match(copy.detail, /无法恢复/);
    assert.match(copy.detail, /源 HTML、CSS、PDF 与项目文件不会被修改/);
    assert.ok(!/journal|UUID|record-cleanup\.json|manifest/i.test(`${copy.title}${copy.message}${copy.detail}`),
      'no protocol names, journal files or identifiers leak into user copy');
    assert.ok(!/强制退出/.test(`${copy.title}${copy.message}${copy.detail}${copy.confirm}`),
      'nothing suggests force-quitting');
  }
});

test('native copy: resuming presents the ORIGINAL confirmed manifest, not a fresh inventory', () => {
  const fresh = cleanupPrompt(cleanupSummary());
  const resuming = cleanupPrompt(cleanupSummary({ resuming: true }));
  assert.match(resuming.message, /已确认/);
  assert.match(resuming.message, /中断/);
  assert.match(resuming.detail, /原始清单/);
  assert.match(resuming.detail, /部分记录可能已在上次被删除/, 'counts are the old manifest, not current records');
  assert.match(resuming.detail, /仍然存在且核验一致的剩余记录/, 'only still-present verified entries are removed');
  assert.match(resuming.detail, /原清单清理完毕即完成/, 'completion means the original manifest is done');
  assert.ok(!/检查发现|本次删除|本次剩余/.test(`${resuming.title}${resuming.message}${resuming.detail}`),
    'resuming never frames the old counts as a current inventory');
  assert.match(fresh.detail, /共 4 条记录/, 'a fresh check does report current records');
  assert.ok(!/原始清单/.test(fresh.detail));
  assert.match(resuming.confirm, /继续清理/);
  assert.match(fresh.confirm, /确认清理/);
  assert.notEqual(fresh.confirm, resuming.confirm);
  assert.notEqual(fresh.title, resuming.title);
});
