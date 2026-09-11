import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import {
  hiddenContentBlocker, hiddenContentBlockerText, hiddenContentForCurrent, runHiddenContentToggle,
} from '../../src/ui/hidden-content-flow.ts';

const DOC_ID = randomUUID();
const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };

const hiddenField = (over = {}) => ({ documentId: DOC_ID, count: 3, enabled: false, busy: false,
  available: true, uncertain: false, limited: false, ...over });

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const makeState = (over = {}, currentOver = {}, hiddenOver = {}) => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'a.html', mode: 'proofread', input: inputSnapshot(),
    project: { name: '站点', entry: 'pages/a.html' }, persistence: null, ...currentOver },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  desktop: { revision: 1, role: 'main', panel: 'docked', reviewed: [], flush: null, pdf: null, pdfBusy: false,
    error: null, pdfExport: null, hiddenContent: hiddenField(hiddenOver) },
  ...over,
});
// 只读脚本预览：新 id、null input/persistence。
const readonlyState = (over = {}, hiddenOver = {}) => {
  const id = randomUUID();
  return makeState(over, { id, mode: 'interactive', input: null, persistence: null },
    { documentId: id, ...hiddenOver });
};
const okResult = (over = {}) => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome: null, ...over });

function harness({ state = makeState(), composing = false, gate = () => null, flush = async () => true, requestImpl = async () => okResult() } = {}) {
  const box = { state };
  const toasts = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    getState: () => box.state,
    isComposing: () => composing,
    maintenanceGate: () => gate(box),
    flush: async () => { flushCalls += 1; return flush(box); },
    request: async (documentId, stateRevision, enabled) => { calls.push({ documentId, stateRevision, enabled }); return requestImpl(box); },
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, box, toasts, calls, flushCalls: () => flushCalls };
}

// ---- 字段归属与门禁 ----

test('hiddenContentForCurrent only accepts the field of the current document', () => {
  assert.equal(hiddenContentForCurrent(null), null);
  assert.equal(hiddenContentForCurrent(makeState({ current: null })), null);
  assert.equal(hiddenContentForCurrent(makeState({}, {}, { documentId: randomUUID() })), null, '异文档字段不可操作');
  const without = makeState();
  delete without.desktop.hiddenContent;
  assert.equal(hiddenContentForCurrent(without), null, '缺失字段不可操作');
  const field = hiddenContentForCurrent(makeState());
  assert.equal(field.documentId, DOC_ID);
  assert.equal(field.count, 3);
});

test('blocker text exists for every blocker', () => {
  for (const blocker of ['no-document', 'readonly', 'no-field', 'unavailable', 'limited', 'uncertain',
    'main-busy', 'busy', 'composing', 'workspace-busy', 'cleanup-pending', 'review-required']) {
    assert.ok(hiddenContentBlockerText(blocker).length > 0, blocker);
  }
  // 不可用提示必须说明页面样式限制，不能只归因为脚本生成。
  assert.match(hiddenContentBlockerText('unavailable'), /页面样式限制/);
});

test('blocker gates disabled states: readonly, missing field, unavailable, limited, uncertain, main busy', () => {
  assert.equal(hiddenContentBlocker(makeState(), { busy: false, composing: false }), null);
  assert.equal(hiddenContentBlocker(readonlyState(), { busy: false, composing: false }), 'readonly');
  const without = makeState(); delete without.desktop.hiddenContent;
  assert.equal(hiddenContentBlocker(without, { busy: false, composing: false }), 'no-field');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { count: 0 }), { busy: false, composing: false }), 'unavailable');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { available: false }), { busy: false, composing: false }), 'unavailable');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { limited: true }), { busy: false, composing: false }), 'limited');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { uncertain: true }), { busy: false, composing: false }), 'uncertain');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { busy: true }), { busy: false, composing: false }), 'main-busy');
  assert.equal(hiddenContentBlocker(makeState({ phase: 'saving' }), { busy: false, composing: false }), 'workspace-busy');
  assert.equal(hiddenContentBlocker(makeState({ cleanupPending: true }), { busy: false, composing: false }), 'cleanup-pending');
  assert.equal(hiddenContentBlocker(null, { busy: false, composing: false }), 'no-document');
  assert.equal(hiddenContentBlocker(makeState({ current: null }), { busy: false, composing: false }), 'no-document');
});

test('Main 真实状态组合：limited 必为 unavailable，uncertain/limited 优先于 available', () => {
  // Main 在 limited=true 时一定同时 available=false：超限提示必须先命中。
  assert.equal(hiddenContentBlocker(makeState({}, {}, { limited: true, available: false }), { busy: false, composing: false }), 'limited');
  assert.match(hiddenContentBlockerText('limited'), /超出/);
  assert.equal(hiddenContentBlocker(makeState({}, {}, { uncertain: true, limited: true, available: false }), { busy: false, composing: false }), 'uncertain');
  assert.equal(hiddenContentBlocker(makeState({}, {}, { busy: true, uncertain: true }), { busy: false, composing: false }), 'main-busy');
});

// ---- 正常流程 ----

test('expand pins the document and sends the latest revision with enabled=true', async () => {
  const h = harness();
  await runHiddenContentToggle(h.deps);
  assert.equal(h.flushCalls(), 1, '点击后先排空实际输入窗口');
  assert.deepEqual(h.calls, [{ documentId: DOC_ID, stateRevision: 5, enabled: true }]);
  assert.equal(h.toasts.length, 0);
});

test('collapse sends enabled=false when the snapshot is expanded', async () => {
  const h = harness({ state: makeState({}, {}, { enabled: true }) });
  await runHiddenContentToggle(h.deps);
  assert.deepEqual(h.calls, [{ documentId: DOC_ID, stateRevision: 5, enabled: false }]);
  assert.equal(h.toasts.length, 0);
});

test('the request uses the LATEST stateRevision re-read after the flush', async () => {
  const h = harness({
    flush: async box => { box.state = { ...box.state, stateRevision: 9 }; return true; },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].stateRevision, 9, '修订必须在排空后重读');
});

test('a document change during the flush cancels the toggle and delivers nothing', async () => {
  const other = randomUUID();
  const h = harness({
    flush: async box => {
      box.state = makeState({ stateRevision: 6 }, { id: other }, { documentId: other });
      return true;
    },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /已取消/);
});

test('a mode change during the flush cancels instead of toggling the readonly document', async () => {
  const h = harness({
    flush: async box => {
      box.state = { ...readonlyState(), current: { ...box.state.current, mode: 'interactive', input: null, persistence: null } };
      return true;
    },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /模式已变化/);
});

test('a display-state change during the flush cancels instead of delivering the stale target', async () => {
  const h = harness({
    flush: async box => {
      box.state = makeState({ stateRevision: 6 }, {}, { enabled: true });
      return true;
    },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /显隐状态已变化/);
});

test('the hidden-content field disappearing during the flush cancels the toggle', async () => {
  const h = harness({
    flush: async box => {
      const next = makeState({ stateRevision: 6 });
      delete next.desktop.hiddenContent;
      box.state = next;
      return true;
    },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /已取消/);
});

test('a failed flush aborts silently (the flush path already explained)', async () => {
  const h = harness({ flush: async () => false });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('a throwing flush is reported once and never reaches Main', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /完成当前输入/);
});

// ---- 门禁：排空前就拒绝 ----

test('composing, maintenance, readonly and field states block before any flush', async () => {
  const review = { documentId: DOC_ID, status: 'failed', code: null, cleanupPending: false, requiresReview: true };
  const states = [
    readonlyState(),
    makeState({ phase: 'opening' }),
    makeState({ cleanupPending: true }),
    makeState({ lastSave: review }),
    makeState({ lastDeparture: review }),
    makeState({}, {}, { uncertain: true }),
    makeState({}, {}, { limited: true }),
    makeState({}, {}, { busy: true }),
    makeState({}, {}, { available: false }),
  ];
  for (const state of states) {
    const h = harness({ state });
    await runHiddenContentToggle(h.deps);
    assert.equal(h.flushCalls(), 0, '被门禁时不排空');
    assert.equal(h.calls.length, 0);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].kind, 'error');
  }
  const composing = harness({ composing: true });
  await runHiddenContentToggle(composing.deps);
  assert.equal(composing.flushCalls(), 0);
  assert.match(composing.toasts[0].text, /组词/);
});

test('维护门禁在 flush 前生效：不排空、不请求', async () => {
  const h = harness({ gate: () => '正在检查上次中断，其他操作暂不可用。' });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /检查上次中断/);
});

test('维护门禁在 flush 期间出现：排空后仍拒绝，不发送展开命令', async () => {
  let gated = false;
  const h = harness({
    gate: () => gated ? '上次中断处理的结果需要人工检查，其他操作暂不可用。' : null,
    flush: async () => { gated = true; return true; },
  });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.flushCalls(), 1, '门禁出现前的排空照常进行');
  assert.equal(h.calls.length, 0, '门禁出现后不得发送');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /人工检查/);
});

test('no current document: no flush, no request, no toast', async () => {
  const h = harness({ state: makeState({ current: null }) });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});

// ---- 竞争与失败 ----

test('rapid duplicate triggers send exactly one request (BusyGuard is synchronous)', async () => {
  const h = harness();
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve();
    return runHiddenContentToggle(h.deps).finally(() => guard.release());
  };
  await Promise.all([run(), run(), run()]);
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('Main failure keeps the snapshot untouched (no optimistic enabled) and explains itself honestly', async () => {
  const state = makeState();
  const h = harness({ state, requestImpl: async () => ({ ...okResult(), ok: false, code: 'HIDDEN_CONTENT_FAILED' }) });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /未能确认/, '结果不确定必须如实说明');
  assert.match(h.toasts[0].text, /已保留/, '草稿与输入保留');
  assert.doesNotMatch(h.toasts[0].text, /未受影响/, 'CSS 可能已变，禁止声称未受影响');
  assert.doesNotMatch(h.toasts[0].text, /请稍候/, 'unknown 不会自动恢复，不能暗示稍候会自行变好');
  assert.equal(h.box.state.desktop.hiddenContent.enabled, false, '失败不改变 Main 快照，UI 不做乐观更新');
});

test('Main error codes are surfaced with understandable text', async () => {
  const cases = [
    ['HIDDEN_CONTENT_BUSY', /正在进行/],
    ['HIDDEN_CONTENT_UNAVAILABLE', /页面样式限制/],
    ['HIDDEN_CONTENT_FAILED', /未能确认/],
    ['STALE_WORKSPACE', /未执行/],
    ['READ_ONLY_MODE', /返回静态校稿/],
    ['INPUT_FLUSH_REQUIRED', /完成当前输入/],
    ['SOMETHING_ELSE', /SOMETHING_ELSE/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ requestImpl: async () => ({ ...okResult(), ok: false, code }) });
    await runHiddenContentToggle(h.deps);
    assert.equal(h.toasts.length, 1, code);
    assert.equal(h.toasts[0].kind, 'error', code);
    assert.match(h.toasts[0].text, pattern, code);
  }
});

test('a rejected transport resolves with an error toast, never an unhandled rejection', async () => {
  const h = harness({ requestImpl: async () => { throw new Error('ipc gone'); } });
  await runHiddenContentToggle(h.deps);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /连接已断开/);
});

test('文档在请求在途时已变化：旧失败与旧断连都不向新文档显示', async () => {
  const failing = harness({
    requestImpl: async box => {
      box.state = makeState({ stateRevision: 7 }, { id: randomUUID() });
      return { ...okResult(), ok: false, code: 'HIDDEN_CONTENT_FAILED' };
    },
  });
  await runHiddenContentToggle(failing.deps);
  assert.equal(failing.calls.length, 1);
  assert.equal(failing.toasts.length, 0, '迟到错误只属于发起时的文档');

  const thrown = harness({
    requestImpl: async box => {
      box.state = makeState({ stateRevision: 7 }, { id: randomUUID() });
      throw new Error('ipc gone');
    },
  });
  await runHiddenContentToggle(thrown.deps);
  assert.equal(thrown.calls.length, 1);
  assert.equal(thrown.toasts.length, 0, '迟到断连也不向新文档显示');
});

test('a slow in-flight request still resolves without throwing when the state changes underneath', async () => {
  const gate = barrier();
  const h = harness({
    requestImpl: async box => {
      await gate.promise;
      // 请求在途时文档被替换：迟到结果只属于传输 ack，不改写新文档状态。
      box.state = makeState({ stateRevision: 7 }, { id: randomUUID() });
      return okResult();
    },
  });
  const pending = runHiddenContentToggle(h.deps);
  gate.release();
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 0, 'ok 只是传输确认；显隐以 Main 快照为准');
});
