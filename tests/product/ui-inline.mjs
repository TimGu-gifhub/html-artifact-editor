import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { panelActionText, panelOwner, runPanelChange, runReviewOpen } from '../../src/ui/contextual-panel.ts';
import { InlineActivationGate, InlineFocusTracker, clampCaret, inlineBeginKey, inlineEffectiveStyle, inlineStyleProps, inlineWrap } from '../../src/ui/inline-input.ts';
import { runModeSwitch } from '../../src/ui/mode-switch.ts';

const DOC_ID = randomUUID();
const okResult = (over = {}) => ({ ok: true, code: null, state: null, documentId: DOC_ID, copy: null, outcome: null, ...over });

const STYLE = {
  fontFamily: 'Georgia, "Microsoft YaHei", serif', fontSize: 16, fontWeight: '700', fontStyle: 'italic',
  lineHeight: 24, letterSpacing: 0.5, color: 'rgb(31, 35, 41)', background: 'rgba(0, 0, 0, 0)',
  whiteSpace: 'pre-wrap', textAlign: 'start', direction: 'ltr', indent: 32,
};
const placement = (over = {}) => ({
  documentId: DOC_ID, nodeId: 'n12', activation: 3, caret: 5,
  rect: { x: 10, y: 20, width: 100, height: 24 }, style: STYLE, ...over,
});

// ---- 输入 owner 归属（含原位输入窗 role=inline） ----

test('panelOwner: 原位输入窗仅在 inline 拥有输入；main/editor 在 inline 下均不是 owner', () => {
  assert.equal(panelOwner('inline', 'inline'), true);
  for (const panel of ['docked', 'hidden', 'floating', 'contextual']) {
    assert.equal(panelOwner('inline', panel), false, `inline 窗口不得拥有 ${panel}`);
  }
  assert.equal(panelOwner('main', 'inline'), false, 'inline 期间主窗口不得发送输入命令');
  assert.equal(panelOwner('editor', 'inline'), false, 'inline 期间浮窗不得发送输入命令');
  // 既有归属不变
  assert.equal(panelOwner('main', 'docked'), true);
  assert.equal(panelOwner('main', 'hidden'), true);
  assert.equal(panelOwner('main', 'floating'), false);
  assert.equal(panelOwner('editor', 'floating'), true);
  assert.equal(panelOwner('editor', 'contextual'), true);
  assert.equal(panelOwner('editor', 'docked'), false);
});

test('panelActionText 覆盖全部五种面板模式，inline 为 原位输入', () => {
  for (const mode of ['docked', 'hidden', 'floating', 'contextual', 'inline']) {
    assert.ok(panelActionText(mode).length > 0, mode);
  }
  assert.equal(panelActionText('inline'), '原位输入');
});

// ---- 开始编辑 key 与 activation 门禁 ----

test('inlineBeginKey 由 documentId:nodeId:activation 构成，几何/caret 更新不产生新 key', () => {
  const key = inlineBeginKey(placement());
  assert.equal(key, `${DOC_ID}:n12:3`);
  assert.equal(inlineBeginKey(placement({ caret: 99 })), key, 'caret 变化不是新激活');
  assert.equal(inlineBeginKey(placement({ rect: { x: 0, y: 0, width: 50, height: 12 } })), key, '几何刷新不是新激活');
  assert.notEqual(inlineBeginKey(placement({ activation: 4 })), key, '新点击（activation 递增）是新 key');
  assert.notEqual(inlineBeginKey(placement({ nodeId: 'n13' })), key, '新 node 是新 key');
  assert.notEqual(inlineBeginKey(placement({ documentId: randomUUID() })), key, '新文档是新 key');
});

test('InlineActivationGate：每个 activation 最多尝试一次，修订/失焦更新不重开同一文字', () => {
  const gate = new InlineActivationGate();
  const key = inlineBeginKey(placement());
  assert.equal(gate.attempt(key), true, '首次激活允许 begin');
  assert.equal(gate.attempt(key), false, '同一 activation 不得因 revision 更新重开');
  assert.equal(gate.attempt(key), false, 'flush/失焦结束后同一 key 仍不得重开');
  assert.equal(gate.attempt(inlineBeginKey(placement({ activation: 4 }))), true, '新点击才重新开始');
  assert.equal(gate.attempt(inlineBeginKey(placement({ nodeId: 'n7' }))), true, '新 node 才重新开始');
});

// ---- 光标 clamp ----

test('clampCaret：caret 提示 clamp 到值范围，非法输入归零', () => {
  assert.equal(clampCaret(5, 10), 5);
  assert.equal(clampCaret(-3, 10), 0);
  assert.equal(clampCaret(99, 10), 10, '不得越过值末尾');
  assert.equal(clampCaret(0, 0), 0);
  assert.equal(clampCaret(2.6, 10), 3);
  assert.equal(clampCaret(Number.NaN, 10), 0);
  assert.equal(clampCaret(5, Number.NaN), 0);
});

// ---- 样式匹配（逐项 CSSOM 赋值，绝不拼接 CSS 文本） ----

test('inlineStyleProps：全部值为字符串，长度显式带 px（lineHeight 不是无单位倍数）', () => {
  const props = inlineStyleProps(STYLE);
  assert.deepEqual(Object.keys(props).sort(), [
    'backgroundColor', 'color', 'direction', 'fontFamily', 'fontSize', 'fontStyle',
    'fontWeight', 'letterSpacing', 'lineHeight', 'textAlign', 'textIndent', 'whiteSpace',
  ]);
  for (const [key, value] of Object.entries(props)) {
    assert.equal(typeof value, 'string', `${key} 必须是字符串（逐项 CSSOM 赋值）`);
  }
  assert.equal(props.fontFamily, STYLE.fontFamily);
  assert.equal(props.fontSize, '16px');
  assert.equal(props.lineHeight, '24px', 'lineHeight 必须是 px 长度，否则被当作字号倍数');
  assert.equal(props.letterSpacing, '0.5px');
  assert.equal(props.textIndent, '32px');
  assert.equal(props.color, 'rgb(31, 35, 41)');
  assert.equal(props.backgroundColor, 'rgba(0, 0, 0, 0)', 'background 映射为 backgroundColor');
  assert.equal(props.whiteSpace, 'pre-wrap');
  assert.equal(props.textAlign, 'start');
  assert.equal(props.direction, 'ltr');
});

test('inlineWrap：仅 pre 不软换行；break-spaces 仍软换行', () => {
  assert.equal(inlineWrap('pre'), 'off');
  assert.equal(inlineWrap('break-spaces'), 'soft');
  assert.equal(inlineWrap('normal'), 'soft');
  assert.equal(inlineWrap('pre-wrap'), 'soft');
  assert.equal(inlineWrap('pre-line'), 'soft');
});

test('inlineEffectiveStyle：detached 临时面板不套源样式（CSS 类提供可读外观），正常模式返回逐项属性', () => {
  assert.equal(inlineEffectiveStyle(placement({ detached: true })), null, 'detached 不得套用小字号源样式');
  const matched = inlineEffectiveStyle(placement());
  assert.ok(matched);
  assert.equal(matched.fontSize, '16px');
  assert.equal(inlineEffectiveStyle(placement({ detached: false }))?.fontSize, '16px');
});

// ---- 聚焦/光标决策（激活、旧 token、IME、迟到几何） ----

const focusState = (over = {}) => ({
  binding: 'tok-1:3', caret: 5, textLength: 10,
  frozen: false, composing: false, dirty: false, ...over,
});

test('新绑定聚焦一次并应用 clamp 后的 caret；之后输入/预览回执/几何更新不抢焦点', () => {
  const tracker = new InlineFocusTracker();
  assert.deepEqual(tracker.evaluate(focusState()), { caret: 5 });
  for (let i = 0; i < 5; ++i) assert.equal(tracker.evaluate(focusState()), null, '同一 token/activation 不得再次聚焦');
  // 迟到几何：同 activation 不同 caret 不得再次应用
  assert.equal(tracker.evaluate(focusState({ caret: 99 })), null, '迟到 placement.caret 不得套用');
});

test('caret clamp 到当前值长度', () => {
  const tracker = new InlineFocusTracker();
  assert.deepEqual(tracker.evaluate(focusState({ caret: 99, textLength: 4 })), { caret: 4 });
});

test('IME 组词与冻结期间不聚焦也不消费绑定，就绪后仍聚焦一次', () => {
  const tracker = new InlineFocusTracker();
  assert.equal(tracker.evaluate(focusState({ composing: true })), null, '组词期间禁止聚焦');
  assert.equal(tracker.evaluate(focusState({ composing: true })), null);
  assert.deepEqual(tracker.evaluate(focusState()), { caret: 5 }, '组词结束后聚焦一次，不丢绑定');
  assert.equal(tracker.evaluate(focusState()), null);

  const frozen = new InlineFocusTracker();
  assert.equal(frozen.evaluate(focusState({ binding: 'tok-9:1', frozen: true })), null, '排空/保存/历史期间禁止聚焦');
  assert.deepEqual(frozen.evaluate(focusState({ binding: 'tok-9:1' })), { caret: 5 });
});

test('已有本地输入（dirty）只聚焦不移动光标；迟到的 caret 不得覆盖用户光标', () => {
  const tracker = new InlineFocusTracker();
  assert.deepEqual(tracker.evaluate(focusState({ dirty: true })), { caret: null }, '聚焦但不设置光标');
  assert.equal(tracker.evaluate(focusState({ dirty: false })), null, '绑定已消费，不再应用 caret');
});

test('旧 token 不得复用：新 token 或新 activation 视为新绑定；失去绑定后重置', () => {
  const tracker = new InlineFocusTracker();
  assert.deepEqual(tracker.evaluate(focusState()), { caret: 5 });
  assert.deepEqual(tracker.evaluate(focusState({ binding: 'tok-2:3' })), { caret: 5 }, '旧 token 的聚焦不覆盖新会话');
  assert.deepEqual(tracker.evaluate(focusState({ binding: 'tok-2:4' })), { caret: 5 }, '新点击（activation）重新聚焦');
  assert.equal(tracker.evaluate(focusState({ binding: null })), null, '无绑定不聚焦');
  assert.deepEqual(tracker.evaluate(focusState({ binding: 'tok-2:4' })), { caret: 5 }, '失去绑定后重进同一绑定会再次聚焦');
});

// ---- 复核打开流程（复核无需收回侧栏） ----

function reviewHarness({ gate = () => null, flush = async () => true } = {}) {
  const toasts = [];
  let flushCalls = 0;
  let opens = 0;
  const deps = {
    maintenanceGate: () => gate(),
    flush: async () => { flushCalls += 1; return flush(); },
    open: () => { opens += 1; },
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, toasts, flushCalls: () => flushCalls, opens: () => opens };
}

test('打开复核：先排空实际输入 owner，再打开；成功时只打开一次', async () => {
  const h = reviewHarness();
  const ok = await runReviewOpen(h.deps);
  assert.equal(ok, true);
  assert.equal(h.flushCalls(), 1, '打开前必须排空实际输入 owner');
  assert.equal(h.opens(), 1);
  assert.equal(h.toasts.length, 0);
});

test('维护门禁在排空前拒绝：不排空、不打开', async () => {
  const h = reviewHarness({ gate: () => '正在清理本地记录，其他操作暂不可用。' });
  const ok = await runReviewOpen(h.deps);
  assert.equal(ok, false);
  assert.equal(h.flushCalls(), 0);
  assert.equal(h.opens(), 0);
  assert.equal(h.toasts[0]?.kind, 'error');
});

test('组词/投递失败（flush false 或抛错）：不打开复核并解释原因', async () => {
  const failed = reviewHarness({ flush: async () => false });
  assert.equal(await runReviewOpen(failed.deps), false);
  assert.equal(failed.opens(), 0, 'flush 失败绝不能打开复核界面');
  assert.match(failed.toasts[0]?.text ?? '', /完成当前输入/);

  const thrown = reviewHarness({ flush: async () => { throw new Error('disconnected'); } });
  assert.equal(await runReviewOpen(thrown.deps), false);
  assert.equal(thrown.opens(), 0);
  assert.match(thrown.toasts[0]?.text ?? '', /完成当前输入/);
});

// ---- 身份绑定核对（排空前后 pin 一致才继续） ----

test('复核 pin：排空后 documentId:mode 一致才打开；变化则取消', async () => {
  let pin = 'doc-a:proofread';
  const same = reviewHarness();
  assert.equal(await runReviewOpen({ ...same.deps, pin: () => pin }), true);
  assert.equal(same.opens(), 1);

  let pin2 = 'doc-a:proofread';
  const changed = reviewHarness({
    flush: async () => { pin2 = 'doc-b:proofread'; return true; }, // 排空期间文档被更换
  });
  assert.equal(await runReviewOpen({ ...changed.deps, pin: () => pin2 }), false);
  assert.equal(changed.opens(), 0, '复核界面不得开到已更换的文档');
  assert.match(changed.toasts[0]?.text ?? '', /文档已变化/);

  let pin3 = 'doc-a:proofread';
  const modeChanged = reviewHarness({
    flush: async () => { pin3 = 'doc-a:interactive'; return true; },
  });
  assert.equal(await runReviewOpen({ ...modeChanged.deps, pin: () => pin3 }), false);
  assert.equal(modeChanged.opens(), 0, '排空后进入只读预览不得打开复核');
});

test('面板切换 pin：排空后绑定变化不发送 panel 命令；一致才请求', async () => {
  const panelHarness = (flush) => {
    const toasts = [];
    const calls = [];
    const deps = {
      maintenanceGate: () => null,
      flush,
      request: async mode => { calls.push(mode); return okResult(); },
      showToast: (text, kind = 'info') => toasts.push({ text, kind }),
    };
    return { deps, toasts, calls };
  };
  const pinValue = { current: 'doc-a:proofread' };
  const steady = panelHarness(async () => true);
  const ok = await runPanelChange({ ...steady.deps, pin: () => pinValue.current }, 'inline');
  assert.equal(ok, true);
  assert.deepEqual(steady.calls, ['inline']);

  const moved = panelHarness(async () => { pinValue.current = 'doc-b:proofread'; return true; });
  const ok2 = await runPanelChange({ ...moved.deps, pin: () => pinValue.current }, 'inline');
  assert.equal(ok2, false, '文档已变化不得切换面板');
  assert.equal(moved.calls.length, 0);
  assert.match(moved.toasts[0]?.text ?? '', /已取消/);
});

// ---- 模式切换返回合同：取消/错误不能切面板 ----

const inputSnapshot = () => ({ stateRevision: 2, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 3, draftPhase: 'idle', candidateHash: 'c'.repeat(64), changes: [], lastCopy: null,
  canApply: false, canSaveCopy: true, history: { undoCount: 0, redoCount: 0, canUndo: false, canRedo: false } });

const readonlyState = () => ({
  stateRevision: 5, phase: 'idle',
  current: { id: DOC_ID, name: 'a.html', mode: 'interactive', input: null,
    project: { name: '站点', entry: 'pages/a.html' }, persistence: null },
  review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
});

function modeHarness({ switchImpl = async () => okResult({ outcome: 'opened' }) } = {}) {
  const box = { state: readonlyState() };
  const toasts = [];
  const deps = {
    getState: () => box.state,
    isComposing: () => false,
    flush: async () => true,
    switchMode: async (documentId, stateRevision, mode) => switchImpl(documentId, stateRevision, mode),
    showToast: (text, kind = 'info') => toasts.push({ text, kind }),
  };
  return { deps, box, toasts };
}

test('runModeSwitch：真实切换成功返回 true（可衔接原位输入面板）', async () => {
  const h = modeHarness();
  assert.equal(await runModeSwitch(h.deps), true);
  assert.equal(h.toasts.length, 0);
});

test('runModeSwitch：原生复核取消返回 false 且保持安静（不能切面板）', async () => {
  const h = modeHarness({ switchImpl: async () => okResult({ outcome: 'cancelled' }) });
  assert.equal(await runModeSwitch(h.deps), false, '取消不得触发后续面板切换');
  assert.equal(h.toasts.length, 0);
});

test('runModeSwitch：Main 拒绝返回 false 并展示错误（不能切面板）', async () => {
  const h = modeHarness({ switchImpl: async () => ({ ...okResult(), ok: false, code: 'FILE_CHANGED' }) });
  assert.equal(await runModeSwitch(h.deps), false);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].text, /其他程序修改/);
});

test('runModeSwitch：传输断开返回 false，不产生未处理拒绝', async () => {
  const h = modeHarness({ switchImpl: async () => { throw new Error('ipc gone'); } });
  assert.equal(await runModeSwitch(h.deps), false);
  assert.match(h.toasts[0]?.text ?? '', /连接已断开/);
});
