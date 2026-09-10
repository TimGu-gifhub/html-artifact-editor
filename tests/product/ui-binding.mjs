import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { ReviewChannel } from '../../src/ui/review-channel.ts';
import { ensureInputFlushed } from '../../src/ui/flush.ts';
import { classifySaveResult } from '../../src/ui/save-result.ts';

const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
async function until(check, message) {
  const limit = Date.now() + 1500;
  while (!check()) { if (Date.now() > limit) throw new Error(message); await delay(5); }
}

// Adopted-session fixture with Main-like ordering. hooks.pre runs before Main
// processes a command (request in flight); hooks.post holds the reply after
// Main already published the resulting state.
function adoptFixture(hooks = {}) {
  const box = { documentId: randomUUID() };
  const editToken = randomUUID();
  const calls = [];
  const input = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', mappingStatus: 'ready', draftRevision: 1,
    candidateHash: 'a'.repeat(64), hasUnappliedInput: false, canApply: true, intent: null, changes: [],
    input: { editToken, nodeId: 'n1', revision: 1, text: '原文', appliedText: '原文', composing: false } };
  let controller;
  const publish = () => {
    input.stateRevision++;
    input.hasUnappliedInput = !!input.input && input.input.text !== input.input.appliedText;
    input.canApply = input.phase === 'idle' && !!input.input && !input.input.composing;
    controller.sync();
  };
  const edit = async (id, command) => {
    calls.push(structuredClone(command));
    assert.equal(id, box.documentId);
    if (hooks.pre) await hooks.pre(command);
    await delay(1);
    if (command.kind === 'change') {
      input.input = { ...input.input, text: command.value.newText, composing: command.value.composing, revision: command.value.inputRevision };
      publish();
    } else if (command.kind === 'apply') {
      input.input = { ...input.input, appliedText: input.input.text, revision: input.input.revision + 1 };
      input.draftRevision++;
      publish();
    } else if (command.kind === 'resolve') {
      input.input = null; input.intent = null; publish();
    }
    if (hooks.post) await hooks.post(command);
    return { ok: true, code: null, documentId: id, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId: box.documentId, input }));
  controller.setOwner(true); controller.sync();
  return { controller, input, calls, publish, box, editToken };
}

test('a stale change reply from an ended session never mutates the rebound session', async () => {
  const gate = barrier();
  const f = adoptFixture({ post: async command => {
    if (command.kind === 'change' && command.value.newText === '旧会话修改') await gate.promise;
  } });
  try {
    f.controller.onChange('旧会话修改');
    await until(() => f.input.input.text === '旧会话修改', 'change did not reach Main');
    // Session ends externally while the change reply is still in flight.
    f.input.input = null; f.publish();
    assert.equal(f.controller.getView().phase, 'failed');
    f.controller.discardFailed();
    assert.equal(f.controller.getView().phase, 'idle');
    // A new document binds the panel (new editToken/nodeId/generation).
    f.box.documentId = randomUUID();
    f.input.input = { editToken: randomUUID(), nodeId: 'n9', revision: 1, text: '新文档原文', appliedText: '新文档原文', composing: false };
    f.publish();
    assert.equal(f.controller.getView().localText, '新文档原文');
    gate.release(); // the old session's reply arrives late
    await delay(40);
    const view = f.controller.getView();
    assert.equal(view.localText, '新文档原文');
    assert.equal(view.appliedText, '新文档原文');
    assert.equal(view.dirty, false, 'stale reply must not mark the new session dirty');
    // The rebound session still delivers its own input.
    f.controller.onChange('新会话修改');
    await until(() => f.input.input.text === '新会话修改', 'new session input blocked by the stale reply');
  } finally { gate.release(); f.controller.dispose(); }
});

test('once the target resolve starts, old input is disabled and Escape cannot cancel', async () => {
  const gate = barrier();
  const f = adoptFixture({ pre: async command => { if (command.kind === 'resolve') await gate.promise; } });
  try {
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '下一段' };
    f.publish();
    await until(() => f.calls.some(value => value.kind === 'resolve'), 'resolve was not sent');
    assert.equal(f.controller.getView().resolving, true);
    f.controller.onChange('不应接受的输入');
    f.controller.onCompositionStart();
    assert.equal(f.controller.getView().localText, '原文', 'input must be disabled once resolve starts');
    assert.equal(f.controller.getView().composing, false);
    assert.equal(f.controller.escape(), false, 'Escape must not cancel during resolve');
    gate.release();
    await until(() => f.controller.getView().phase === 'idle', 'session did not settle after resolve');
    assert.equal(f.calls.filter(value => value.kind === 'change').length, 0);
  } finally { gate.release(); f.controller.dispose(); }
});

function idleController() {
  return new LiveInputController(
    async () => ({ ok: true, code: null, state: null, documentId: null, copy: null, outcome: null }),
    () => ({ documentId: null, input: null }),
  );
}

test('owner-side ensureInputFlushed drains the in-flight begin instead of trusting the Main snapshot', async () => {
  const documentId = randomUUID(); const editToken = randomUUID();
  const input = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', mappingStatus: 'ready', draftRevision: 1,
    candidateHash: 'a'.repeat(64), hasUnappliedInput: false, canApply: true, intent: null, changes: [], input: null };
  const gate = barrier(); let controller;
  const edit = async (id, command) => {
    assert.equal(command.kind, 'begin');
    await gate.promise;
    input.input = { editToken, nodeId: 'n1', revision: 1, text: '原文', appliedText: '原文', composing: false };
    input.stateRevision++;
    controller.sync();
    return { ok: true, code: null, documentId: id, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId, input }));
  controller.setOwner(true);
  const selection = { identity: { preview: { sessionId: randomUUID(), generation: 1, mode: 'proofread', version: 1 }, documentId, baseHash: 'b'.repeat(64) }, revision: 1, nodeId: 'n1' };
  const beginning = controller.begin('k', selection, 1);
  let settled = null;
  const pending = ensureInputFlushed({ owner: true, controller }, new WorkspaceStore(), null).then(ok => { settled = ok; });
  await delay(30);
  assert.equal(settled, null, 'flush must wait for the in-flight begin, not guess from the Main snapshot');
  gate.release();
  await beginning;
  await pending;
  assert.equal(settled, true, 'flush resolves once the begun session is drained');
  controller.dispose();
});

test('owner-side ensureInputFlushed never bypasses locally preserved failed input', async () => {
  const f = adoptFixture();
  try {
    f.controller.onChange('保留的修改');
    await until(() => f.input.input.text === '保留的修改', 'change did not reach Main');
    // Main session ends externally with unapplied local text; Main shows no input.
    f.input.input = null; f.publish();
    assert.equal(f.controller.getView().phase, 'failed');
    assert.equal(await ensureInputFlushed({ owner: true, controller: f.controller }, new WorkspaceStore(), null), false);
    assert.equal(f.controller.getView().localText, '保留的修改', 'local text must stay preserved');
  } finally { f.controller.dispose(); }
});

function storeWith(inputOverride = {}) {
  const store = new WorkspaceStore();
  const documentId = randomUUID();
  store.accept({
    stateRevision: 1, phase: 'idle',
    current: { id: documentId, name: 'a.html',
      input: { stateRevision: 1, phase: 'idle', mappingStatus: 'ready', mappingReason: null, selection: null,
        input: null, hasUnappliedInput: false, intent: null, draftRevision: 1, draftPhase: 'idle',
        candidateHash: 'a'.repeat(64), changes: [], lastCopy: null, canApply: false, canSaveCopy: true, history: null,
        ...inputOverride },
      project: { name: 'p', entry: 'a.html', resources: { items: [], truncated: false } }, persistence: null },
    review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false,
    desktop: { revision: 1, role: 'main', panel: 'floating', reviewed: [], flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null },
  });
  return { store, documentId };
}

test('non-owner ensureInputFlushed always routes flush-input through Main, even with no Main-side input', async () => {
  const { store } = storeWith();
  const requested = [];
  const ok = await ensureInputFlushed({ owner: false, controller: idleController() }, store, async command => {
    requested.push(command.kind);
    return { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };
  });
  assert.equal(ok, true);
  assert.deepEqual(requested, ['flush-input'], 'must not infer "no pending input" from the Main snapshot');
});

test('non-owner ensureInputFlushed reports failure when the desktop request fails', async () => {
  const { store } = storeWith();
  const ok = await ensureInputFlushed({ owner: false, controller: idleController() }, store,
    async () => ({ ok: false, code: 'EDITOR_DISCONNECTED', state: null, documentId: null, copy: null, outcome: null }));
  assert.equal(ok, false);
});

test('non-owner ensureInputFlushed waits for the routed owner flush to finish', async () => {
  const { store } = storeWith({
    input: { editToken: randomUUID(), nodeId: 'n1', revision: 2, text: '待排空', appliedText: '原文', composing: false },
    hasUnappliedInput: true,
  });
  const request = async command => {
    assert.equal(command.kind, 'flush-input');
    // Main routes the flush request to the owner window.
    const state = store.getState();
    store.accept({ ...state, stateRevision: 2, desktop: { ...state.desktop, revision: 2, flush: { id: randomUUID(), action: 'action' } } });
    return { ok: true, code: null, state: null, documentId: null, copy: null, outcome: null };
  };
  let settled = null;
  const pending = ensureInputFlushed({ owner: false, controller: idleController() }, store, request).then(ok => { settled = ok; });
  await delay(30);
  assert.equal(settled, null, 'must wait while the owner window drains');
  // Owner finishes: flush marker cleared, input drained.
  const state = store.getState();
  store.accept({ ...state, stateRevision: 3,
    current: { ...state.current, input: { ...state.current.input, input: null, hasUnappliedInput: false } },
    desktop: { ...state.desktop, revision: 3, flush: null } });
  await pending;
  assert.equal(settled, true);
});

const snap = lastSave => ({ stateRevision: 1, phase: 'idle', current: null, review: null, backupReview: null,
  cleanupPending: false, lastSave, lastDeparture: null, canSave: false });
const saveReport = (documentId, status, cleanupPending = false) => ({ documentId, status, code: null, cleanupPending, requiresReview: false });
const saveReply = over => ({ ok: false, code: null, state: null, documentId: null, copy: null, outcome: null, ...over });

test('save verdicts: only an authoritative matching report may claim a pre-commit failure', () => {
  const docId = randomUUID(); const other = randomUUID();
  // 断连且无报告：不能断言写入未提交。
  assert.equal(classifySaveResult(saveReply({ ok: false, code: 'EDITOR_DISCONNECTED', documentId: docId }), docId).kind, 'unknown');
  // 旧文档的失败报告与本次保存无关，同样不能断言。
  assert.equal(classifySaveResult(saveReply({ ok: false, documentId: docId, state: snap(saveReport(other, 'failed')) }), docId).kind, 'unknown');
  // 匹配 documentId 的权威 failed 报告：已知提交前失败。
  assert.equal(classifySaveResult(saveReply({ ok: false, documentId: docId, state: snap(saveReport(docId, 'failed')) }), docId).kind, 'failed');
  // 权威 unknown 报告。
  assert.equal(classifySaveResult(saveReply({ ok: false, documentId: docId, state: snap(saveReport(docId, 'unknown')) }), docId).kind, 'unknown');
  // rebase-required：来自 outcome 或权威报告。
  assert.equal(classifySaveResult(saveReply({ ok: true, outcome: 'rebase-required', documentId: docId }), docId).kind, 'rebase-required');
  assert.equal(classifySaveResult(saveReply({ ok: false, documentId: docId, state: snap(saveReport(docId, 'rebase-required')) }), docId).kind, 'rebase-required');
  // 旧文档的 rebase 报告不得当作本次保存的结果。
  assert.equal(classifySaveResult(saveReply({ ok: false, documentId: docId, state: snap(saveReport(other, 'rebase-required')) }), docId).kind, 'unknown');
  // 属于其他请求的结果不能结算本次保存。
  assert.equal(classifySaveResult(saveReply({ ok: true, outcome: 'saved', documentId: other }), docId).kind, 'unknown');
  // 已验证 saved 可附清理警告。
  assert.deepEqual(classifySaveResult(saveReply({ ok: true, outcome: 'saved', documentId: docId, state: snap(saveReport(docId, 'saved', true)) }), docId),
    { kind: 'saved', code: null, cleanupPending: true });
  // 取消与无变化。
  assert.equal(classifySaveResult(saveReply({ ok: true, outcome: 'cancelled', documentId: docId }), docId).kind, 'cancelled');
  assert.equal(classifySaveResult(saveReply({ ok: true, outcome: 'unchanged', documentId: docId }), docId).kind, 'unchanged');
});

function reviewState(documentId, reviewed = []) {
  return { stateRevision: 1, phase: 'reviewing', current: {
    id: documentId, name: 'doc.html',
    input: { draftRevision: 3, candidateHash: 'c'.repeat(64), changes: [
      { nodeId: 'n1', oldText: 'a', newText: 'b' }, { nodeId: 'n2', oldText: 'c', newText: 'd' },
    ] },
    project: { name: 'p', entry: 'doc.html', resources: { items: [], truncated: false } },
    persistence: null,
  }, review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null,
    canSave: true, desktop: { revision: 1, role: 'main', panel: 'docked', reviewed, flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null } };
}

test('a delayed review reply from an old document never clears or marks the new document intent', async () => {
  const docA = randomUUID(); const docB = randomUUID();
  const box = { state: reviewState(docA) };
  const sent = []; const gate = barrier();
  const channel = new ReviewChannel(() => box.state, async command => {
    sent.push(structuredClone(command));
    if (command.documentId === docA) await gate.promise;
    return { ok: true, code: null, state: null, documentId: command.documentId, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 1, 'first review request not sent');
  // Same draftRevision/candidateHash/nodeIds, different document (a saved-then-rebound baseline).
  box.state = reviewState(docB);
  channel.sync();
  channel.toggle('n1', true);
  gate.release(); // old document's reply arrives late
  await until(() => sent.length === 2, 'new document intent was swallowed by the old reply');
  assert.equal(sent[0].documentId, docA);
  assert.equal(sent[1].documentId, docB);
  assert.deepEqual(sent[1].nodeIds, ['n1']);
  await until(() => channel.getStatus().pending === false, 'channel did not settle');
  // Main confirms the new document's marks; a follow-up toggle extends them.
  box.state = reviewState(docB, ['n1']);
  channel.sync();
  channel.toggle('n2', true);
  await until(() => sent.length === 3, 'follow-up intent not delivered');
  assert.equal(sent[2].documentId, docB);
  assert.deepEqual(sent[2].nodeIds, ['n1', 'n2']);
});

test('toggle collects intent against the current binding even before an explicit sync', async () => {
  const docA = randomUUID(); const docB = randomUUID();
  const box = { state: reviewState(docA) };
  const sent = []; const gate = barrier();
  const channel = new ReviewChannel(() => box.state, async command => {
    sent.push(structuredClone(command));
    if (command.documentId === docA) await gate.promise;
    return { ok: true, code: null, state: null, documentId: command.documentId, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 1, 'first review request not sent');
  box.state = reviewState(docB); // document switches WITHOUT an explicit channel.sync()
  channel.toggle('n2', true); // must start from B's server truth, not A's pending intent
  gate.release();
  await until(() => sent.length === 2, 'new intent not delivered');
  assert.equal(sent[1].documentId, docB);
  assert.deepEqual(sent[1].nodeIds, ['n2'], 'stale intent from the old document must not leak into the new one');
});
