import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BusyGuard } from '../../src/ui/entry-switch.ts';
import { CompactFocusTracker, panelActionText, panelOwner, runPanelChange } from '../../src/ui/contextual-panel.ts';
import { describeCode, presentationForCurrent, presentationStatusText } from '../../src/ui/util.ts';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { ensureInputFlushed } from '../../src/ui/flush.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { tabPresentationCss } from '../../src/main/product/presentation-style.ts';

const DOC_ID = randomUUID();
const okResult = (over = {}) => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome: null, ...over });

function harness({ gate = () => null, flush = async () => true, requestImpl = async () => okResult() } = {}) {
  const toasts = [];
  const calls = [];
  let flushCalls = 0;
  const deps = {
    maintenanceGate: () => gate(),
    flush: async () => { flushCalls += 1; return flush(); },
    request: async mode => { calls.push(mode); return requestImpl(); },
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, toasts, calls, flushCalls: () => flushCalls };
}

// ---- 输入 owner 归属 ----

test('panelOwner: main owns docked/hidden only; editor owns floating/contextual', () => {
  assert.equal(panelOwner('main', 'docked'), true);
  assert.equal(panelOwner('main', 'hidden'), true);
  assert.equal(panelOwner('main', 'floating'), false);
  assert.equal(panelOwner('main', 'contextual'), false, '就地小窗期间主窗口不得发送输入命令');
  assert.equal(panelOwner('editor', 'floating'), true);
  assert.equal(panelOwner('editor', 'contextual'), true);
  assert.equal(panelOwner('editor', 'docked'), false);
  assert.equal(panelOwner('editor', 'hidden'), false);
});

test('panelActionText names every panel mode, contextual is 就地编辑', () => {
  for (const mode of ['docked', 'hidden', 'floating', 'contextual']) {
    assert.ok(panelActionText(mode).length > 0, mode);
  }
  assert.equal(panelActionText('contextual'), '就地编辑');
});

// ---- 面板切换流程 ----

test('进入 contextual：先排空实际输入 owner，再发送 panel 命令', async () => {
  const h = harness();
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, true);
  assert.equal(h.flushCalls(), 1, '切换前必须排空输入');
  assert.deepEqual(h.calls, ['contextual']);
  assert.equal(h.toasts.length, 0);
});

test('维护门禁在排空前拒绝：不排空、不请求', async () => {
  const h = harness({ gate: () => '正在检查上次中断，其他操作暂不可用。' });
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, false);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /检查上次中断/);
});

test('flush 失败（组词/投递失败）：不发送 panel 命令并解释原因', async () => {
  const h = harness({ flush: async () => false });
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, false);
  assert.equal(h.flushCalls(), 1);
  assert.equal(h.calls.length, 0, 'flush 失败绝不能切换面板');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /就地编辑前需要先完成当前输入/);
});

test('flush 抛错：报告一次，不请求', async () => {
  const h = harness({ flush: async () => { throw new Error('disconnected'); } });
  const ok = await runPanelChange(h.deps, 'docked');
  assert.equal(ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /停靠校稿栏前需要先完成当前输入/);
});

test('readonly 拒绝：Main 返回 READ_ONLY_MODE 时如实展示，不假装已切换', async () => {
  const h = harness({ requestImpl: async () => ({ ...okResult(), ok: false, code: 'READ_ONLY_MODE' }) });
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /返回静态校稿/);
});

test('Main 要求先排空（INPUT_FLUSH_REQUIRED）时有可理解文案', async () => {
  assert.match(describeCode('INPUT_FLUSH_REQUIRED'), /完成当前输入/);
  const h = harness({ requestImpl: async () => ({ ...okResult(), ok: false, code: 'INPUT_FLUSH_REQUIRED' }) });
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, false);
  assert.match(h.toasts[0].text, /完成当前输入/);
});

test('传输断开：报告连接已断开，不产生未处理拒绝', async () => {
  const h = harness({ requestImpl: async () => { throw new Error('ipc gone'); } });
  const ok = await runPanelChange(h.deps, 'floating');
  assert.equal(ok, false);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /连接已断开/);
});

test('同帧重复点击只发送一次请求（BusyGuard 同步排除）', async () => {
  const h = harness();
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve(false);
    return runPanelChange(h.deps, 'contextual').finally(() => guard.release());
  };
  const [a, b, c] = await Promise.all([run(), run(), run()]);
  assert.deepEqual([a, b, c].filter(Boolean).length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(guard.tryAcquire(), true, 'guard must be released in finally');
  guard.release();
});

test('在途切换未结束时第二次触发被门禁排除', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const h = harness({ requestImpl: async () => { await gate; return okResult(); } });
  const guard = new BusyGuard();
  const run = () => {
    if (!guard.tryAcquire()) return Promise.resolve(false);
    return runPanelChange(h.deps, 'contextual').finally(() => guard.release());
  };
  const first = run();
  const second = await run();
  assert.equal(second, false, '在途期间重复触发直接放弃');
  release();
  assert.equal(await first, true);
  assert.equal(h.calls.length, 1);
});

// ---- 真实 LiveInputController：组词（IME）期间不能切换面板 ----

test('组词期间 controller.flush 拒绝，runPanelChange 不发送 panel 命令', async () => {
  const controller = new LiveInputController(
    async () => okResult(),
    () => ({ documentId: DOC_ID, input: null }),
  );
  controller.setOwner(true);
  controller.sync();
  controller.onCompositionStart();
  assert.equal(controller.isComposing(), true);
  assert.equal(await controller.flush(), false, '组词期间 flush 必须失败');
  const h = harness({ flush: () => controller.flush() });
  const ok = await runPanelChange(h.deps, 'contextual');
  assert.equal(ok, false);
  assert.equal(h.calls.length, 0, 'IME 组词期间绝不能切换面板');
  assert.match(h.toasts[0].text, /完成当前输入/);
  controller.onCompositionEnd('文字');
  controller.dispose();
});

test('非 owner 侧排空经由 Main 路由（flush-input），面板切换同样先排空', async () => {
  const store = new WorkspaceStore();
  store.accept({
    stateRevision: 1, phase: 'idle', current: null, review: null, backupReview: null,
    cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
    desktop: { revision: 1, role: 'main', panel: 'contextual', reviewed: [], flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null },
  });
  const commands = [];
  const controller = new LiveInputController(async () => okResult(), () => ({ documentId: null, input: null }));
  // contextual 期间主窗口不是 owner：非 owner 不臆断“没有待输入”，由 Main 路由到实际 owner。
  assert.equal(panelOwner('main', 'contextual'), false);
  const flushed = await ensureInputFlushed({ owner: false, controller }, store, async command => {
    commands.push(command.kind);
    return okResult({ documentId: null });
  });
  assert.equal(flushed, true);
  assert.deepEqual(commands, ['flush-input']);
  controller.dispose();
});

// ---- presentation 反馈归属 ----

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const makeState = (over = {}, currentOver = {}, presentation) => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'a.html', mode: 'proofread', input: inputSnapshot(),
    project: { name: '站点', entry: 'pages/a.html' }, persistence: null, ...currentOver },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
  desktop: { revision: 1, role: 'main', panel: 'docked', reviewed: [], flush: null, pdf: null, pdfBusy: false,
    error: null, pdfExport: null, presentation },
  ...over,
});

test('presentationForCurrent 只接受当前静态校稿文档的字段', () => {
  const restored = { documentId: DOC_ID, panels: 2, status: 'restored' };
  assert.equal(presentationForCurrent(null), null);
  assert.equal(presentationForCurrent(makeState({ current: null }, {}, restored)), null);
  assert.equal(presentationForCurrent(makeState({}, {}, undefined)), null, '缺失字段不显示');
  assert.equal(presentationForCurrent(makeState({}, {}, { documentId: randomUUID(), panels: 2, status: 'restored' })), null, '异文档字段不显示');
  const readonly = makeState({}, { mode: 'interactive', input: null, persistence: null }, restored);
  assert.equal(presentationForCurrent(readonly), null, '脚本只读预览不显示');
  const found = presentationForCurrent(makeState({}, {}, restored));
  assert.deepEqual(found, restored);
  const withCounts = { documentId: DOC_ID, panels: 0, status: 'restored', elements: 3, details: 1 };
  assert.deepEqual(presentationForCurrent(makeState({}, {}, withCounts)), withCounts, '可选 elements/details 原样透传');
});

test('presentationStatusText：restored 报告已保留的当前显示，panels 旧数据兼容', () => {
  assert.equal(presentationStatusText({ documentId: DOC_ID, panels: 0, status: 'restored' }), null, '无保留内容不提示');
  assert.equal(presentationStatusText({ documentId: DOC_ID, panels: 0, status: 'restored', elements: 0 }), null, 'elements=0 同样不提示');
  const legacy = presentationStatusText({ documentId: DOC_ID, panels: 2, status: 'restored' });
  assert.match(legacy, /已保留当前显示/);
  assert.match(legacy, /2 组预置正文/);
  const withDetails = presentationStatusText({ documentId: DOC_ID, panels: 0, status: 'restored', elements: 3, details: 1 });
  assert.match(withDetails, /3 处渐显\/显隐差异/);
  assert.match(withDetails, /1 个已展开的问答/);
  const noDetails = presentationStatusText({ documentId: DOC_ID, panels: 1, status: 'restored', elements: 2 });
  assert.match(noDetails, /2 处渐显\/显隐差异/);
  assert.doesNotMatch(noDetails, /问答/, '缺失 details 字段不编造问答数');
  for (const text of [legacy, withDetails, noDetails]) {
    assert.match(text, /不写入文件/);
    assert.doesNotMatch(text, /所有动态|全部状态/, '不得声称保留所有动态状态');
  }
});

test('presentationStatusText：partial 明确部分未保留并指导返回浏览，不误报完整', () => {
  const partial = presentationStatusText({ documentId: DOC_ID, panels: 1, status: 'partial', elements: 2, details: 1 });
  assert.match(partial, /部分显示未能保留/);
  assert.match(partial, /返回浏览模式定位/);
  assert.doesNotMatch(partial, /已保留当前显示/, 'partial 不得误报为完整保留');
  assert.doesNotMatch(partial, /显示隐藏内容/, '不再将“显示隐藏内容”作为必经路径');
  assert.doesNotMatch(partial, /offset|:nth-child/, '不得暴露内部源码路径或 offset');
});

// ---- Main 纯 CSS 生成例外：tabPresentationCss ----

const TABS = [':root:nth-child(1) > :nth-child(2)', null, ':root:nth-child(1) > :nth-child(3)'];

test('tabPresentationCss：选中标签强调、其余弱化、null 跳过', () => {
  const css = tabPresentationCss(TABS, 2);
  assert.ok(css.includes(':root:nth-child(1) > :nth-child(3){opacity:1!important;'), 'active tab emphasized');
  assert.ok(css.includes(':root:nth-child(1) > :nth-child(2){opacity:.65!important;'), 'inactive tab muted');
  assert.ok(!css.includes('null'), 'null tab skipped');
  assert.ok(!css.includes('@media'), 'media wrapper belongs to Main');
  assert.ok(!/url\(|http|@import|behavior/i.test(css), 'CSS must not enable network or behaviors');
  assert.notEqual(tabPresentationCss(TABS, 0), tabPresentationCss(TABS, 2), 'active index changes the rules');
});

test('tabPresentationCss：active 越界或为 null 时不产出任何规则', () => {
  assert.equal(tabPresentationCss(TABS, -1), '');
  assert.equal(tabPresentationCss(TABS, 3), '');
  assert.equal(tabPresentationCss(TABS, 1.5), '');
  assert.equal(tabPresentationCss(TABS, 1), '', 'active 无标签按钮时不得只弱化其余标签');
  assert.equal(tabPresentationCss([], 0), '');
});

test('tabPresentationCss：非 Main 数字路径的输入被拒绝，不产生注入', () => {
  assert.equal(tabPresentationCss(['body{background:red}'], 0), '');
  const css = tabPresentationCss(['body{background:red}', ':root:nth-child(2)'], 1);
  assert.ok(!css.includes('body{background:red}'), '不安全选择器整体跳过');
  assert.ok(css.includes(':root:nth-child(2){opacity:1!important;'));
});

// ---- 就地小窗草稿框自动聚焦决策（CompactFocusTracker）----

const focusState = (over = {}) => ({ compact: true, readonly: false, binding: 'tok-1',
  frozen: false, composing: false, ...over });

test('新的就绪绑定聚焦一次，之后的状态更新不再抢焦点', () => {
  const tracker = new CompactFocusTracker();
  assert.equal(tracker.evaluate(focusState()), 'tok-1');
  let count = 0;
  for (let i = 0; i < 5; ++i) if (tracker.evaluate(focusState()) !== null) count += 1;
  assert.equal(count, 0, '同一绑定的输入/预览/状态更新不得再次聚焦');
});

test('新绑定（含异文档同 node 的新会话）重新聚焦一次', () => {
  const tracker = new CompactFocusTracker();
  assert.equal(tracker.evaluate(focusState()), 'tok-1');
  assert.equal(tracker.evaluate(focusState({ binding: 'tok-2' })), 'tok-2', '异文档/新会话视为新绑定');
  assert.equal(tracker.evaluate(focusState({ binding: 'tok-2' })), null);
});

test('组词与冻结时禁止聚焦但不丢绑定，就绪后仍聚焦一次', () => {
  const tracker = new CompactFocusTracker();
  assert.equal(tracker.evaluate(focusState({ composing: true })), null, '组词期间禁止聚焦');
  assert.equal(tracker.evaluate(focusState({ composing: true })), null);
  assert.equal(tracker.evaluate(focusState()), 'tok-1', '组词结束后聚焦，不丢绑定');
  assert.equal(tracker.evaluate(focusState()), null);

  const frozen = new CompactFocusTracker();
  assert.equal(frozen.evaluate(focusState({ binding: 'tok-9', frozen: true })), null, '冻结（排空/保存/历史）期间禁止聚焦');
  assert.equal(frozen.evaluate(focusState({ binding: 'tok-9' })), 'tok-9', '解冻后聚焦一次');
  assert.equal(frozen.evaluate(focusState({ binding: 'tok-9' })), null);
});

test('离开 compact/只读/无绑定即重置，重进同一绑定会再次聚焦', () => {
  const tracker = new CompactFocusTracker();
  assert.equal(tracker.evaluate(focusState()), 'tok-1');
  for (const left of [{ compact: false }, { readonly: true }, { binding: null }]) {
    assert.equal(tracker.evaluate(focusState(left)), null, '离开状态不聚焦');
    assert.equal(tracker.evaluate(focusState()), 'tok-1', '重进后同一绑定再次聚焦一次');
    assert.equal(tracker.evaluate(focusState()), null);
  }
});

test('从未进入有效状态时不产生任何聚焦', () => {
  const tracker = new CompactFocusTracker();
  assert.equal(tracker.evaluate(focusState({ compact: false })), null);
  assert.equal(tracker.evaluate(focusState({ readonly: true })), null);
  assert.equal(tracker.evaluate(focusState({ binding: null })), null);
  assert.equal(tracker.evaluate(focusState({ binding: null, frozen: true, composing: true })), null);
});
