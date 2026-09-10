import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { WorkspaceStore } from '../../src/ui/store.ts';
import { ReviewChannel } from '../../src/ui/review-channel.ts';

const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
const NUL = String.fromCharCode(0);
async function until(check, message) {
  const limit = Date.now() + 1500;
  while (!check()) { if (Date.now() > limit) throw new Error(message); await delay(5); }
}

// A Main-like fixture with real ordering: state is published before the
// invoke reply resolves, and each command yields like IPC.
function fixture() {
  const documentId = randomUUID(); const editToken = randomUUID(); const calls = [];
  const input = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', mappingStatus: 'ready', draftRevision: 1,
    candidateHash: 'a'.repeat(64), hasUnappliedInput: false, canApply: true, intent: null, changes: [],
    input: { editToken, nodeId: 'n1', revision: 1, text: '原文', appliedText: '原文', composing: false } };
  let hold = null; let controller;
  const publish = () => { input.stateRevision++; input.hasUnappliedInput = !!input.input && input.input.text !== input.input.appliedText;
    input.canApply = input.phase === 'idle' && !!input.input && !input.input.composing; controller.sync(); };
  const edit = async (id, command) => {
    calls.push(structuredClone(command));
    await delay(1);
    assert.equal(id, documentId);
    if (command.kind === 'begin') {
      input.input = { editToken, nodeId: command.value.selection.nodeId, revision: 1, text: '原文', appliedText: '原文', composing: false };
      publish();
    } else if (command.kind === 'change') {
      assert.equal(input.phase, 'idle');
      assert.equal(command.value.inputRevision, input.input.revision + 1);
      input.input = { ...input.input, text: command.value.newText, composing: command.value.composing, revision: command.value.inputRevision }; publish();
    } else if (command.kind === 'apply') {
      assert.equal(input.phase, 'idle'); assert.equal(input.input.composing, false);
      assert.equal(command.value.inputRevision, input.input.revision);
      const accepted = { ...input.input }; input.phase = 'applying'; publish();
      if (hold) { const pending = hold; hold = null; await pending.promise; }
      input.input = { ...accepted, appliedText: accepted.text, revision: accepted.revision + 1 };
      input.phase = 'idle'; input.draftRevision++; publish();
    } else if (command.kind === 'resolve') {
      input.input = null; input.intent = null; publish();
    } else throw new Error(`unexpected UI command ${command.kind}`);
    return { ok: true, code: null, documentId, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId, input }));
  controller.setOwner(true); controller.sync();
  return { controller, input, calls, publish, documentId, editToken,
    hold: () => { hold = barrier(); return hold; } };
}

test('composition streams to Main serially and post-composition typing is delivered before Apply settles', async () => {
  const f = fixture(); const held = f.hold();
  try {
    f.controller.onCompositionStart();
    f.controller.onChange('拼');
    await until(() => f.input.input.composing === true, 'Main never saw composing=true');
    f.controller.onChange('拼音');
    await until(() => f.input.input.text === '拼音', 'second composition change not delivered');
    assert.ok(f.calls.filter(value => value.kind === 'change').every(value => value.value.composing === true));
    assert.equal(f.calls.filter(value => value.kind === 'apply').length, 0);
    f.controller.onCompositionEnd('拼音');
    await until(() => f.input.phase === 'applying', 'apply did not start after compositionend');
    assert.equal(f.input.input.appliedText, '原文', 'apply must not settle while held');
    held.release();
    await until(() => f.input.input.appliedText === '拼音', 'post-composition text not applied');
    assert.equal(f.input.input.composing, false);
  } finally { held.release(); f.controller.dispose(); }
});

test('a newer selection intent replaces an older one during drain; resolve uses the exact latest sequence once', async () => {
  const f = fixture();
  try {
    f.controller.onChange('更新');
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '下一段' }; f.publish();
    f.input.intent = { sequence: 2, nodeId: 'n3', text: '再下一段' }; f.publish();
    await until(() => f.calls.some(value => value.kind === 'resolve'), 'intent was not resolved');
    const resolves = f.calls.filter(value => value.kind === 'resolve');
    assert.equal(resolves.length, 1);
    assert.equal(resolves[0].value.intentSequence, 2, 'stale intent must not be resolved');
    assert.ok(f.calls.filter(value => value.kind === 'apply').length <= 2);
  } finally { f.controller.dispose(); }
});

test('lost mapping preserves local text; explicit discard clears binding; a new document never receives old text', async () => {
  const f = fixture();
  try {
    f.controller.onChange('未投递的修改');
    await until(() => f.input.input.text === '未投递的修改', 'change did not reach Main');
    // External invalidation before apply: session ends with unsent preview text.
    f.input.input = null; f.publish();
    const view = f.controller.getView();
    assert.equal(view.phase, 'failed');
    assert.equal(view.localText, '未投递的修改', 'local text must be preserved');
    const callsBefore = f.calls.length;
    f.controller.discardFailed();
    assert.equal(f.controller.getView().phase, 'idle');
    assert.equal(f.controller.getView().localText, '');
    // A selection in a new document begins a fresh session bound to that document.
    const documentIdB = randomUUID();
    const inputB = { ...f.input, input: null };
    const callsB = [];
    const editB = async (id, command) => {
      callsB.push(command);
      assert.equal(id, documentIdB, 'old document binding must not leak');
      assert.equal(command.kind, 'begin');
      inputB.input = { editToken: randomUUID(), nodeId: command.value.selection.nodeId, revision: 1, text: 'B 原文', appliedText: 'B 原文', composing: false };
      inputB.stateRevision++;
      controllerB.sync();
      return { ok: true, code: null, documentId: id, state: null, copy: null, outcome: null };
    };
    const controllerB = new LiveInputController(editB, () => ({ documentId: documentIdB, input: inputB }));
    controllerB.setOwner(true);
    const selection = { identity: { preview: { sessionId: randomUUID(), generation: 1, mode: 'proofread', version: 1 }, documentId: documentIdB, baseHash: 'b'.repeat(64) }, revision: 1, nodeId: 'n7' };
    await controllerB.begin('k1', selection, 1);
    assert.equal(controllerB.getView().phase, 'active');
    assert.equal(controllerB.getView().localText, 'B 原文');
    assert.ok(callsB.every(value => value.kind === 'begin'), 'no old text may be sent to the new document');
    controllerB.dispose();
    assert.equal(f.calls.length, callsBefore, 'old controller must not send after failure+discard');
  } finally { f.controller.dispose(); }
});

test('invalid text is never sent; correcting it resumes delivery', async () => {
  const f = fixture();
  try {
    f.controller.onChange(`坏的${NUL}文本`);
    await delay(50);
    assert.equal(f.calls.length, 0, 'invalid text must not reach Main');
    assert.ok(f.controller.getView().error, 'validation error must be visible');
    f.controller.onChange('好的文本');
    await until(() => f.input.input.text === '好的文本', 'corrected text was not delivered');
    assert.equal(f.controller.getView().error, null);
  } finally { f.controller.dispose(); }
});

test('Escape during an in-flight Apply keeps the accepted text and sends no reverting change', async () => {
  const f = fixture(); const held = f.hold();
  try {
    f.controller.onChange('保留这段');
    const draining = f.controller.flush();
    await until(() => f.input.phase === 'applying', 'apply did not start');
    assert.equal(f.controller.escape(), true);
    held.release();
    assert.equal(await draining, true);
    assert.equal(f.input.input.appliedText, '保留这段', 'accepted apply must not be undone');
    assert.equal(f.controller.getView().localText, '保留这段');
    assert.equal(f.calls.filter(value => value.kind === 'change' && value.value.newText === '原文').length, 0,
      'no reverting change may follow an accepted apply');
  } finally { held.release(); f.controller.dispose(); }
});

test('flush waits for an in-flight begin instead of reporting an early true', async () => {
  const documentId = randomUUID(); const editToken = randomUUID();
  const input = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', mappingStatus: 'ready', draftRevision: 1,
    candidateHash: 'a'.repeat(64), hasUnappliedInput: false, canApply: true, intent: null, changes: [], input: null };
  const gate = barrier(); let controller;
  const publish = () => { input.stateRevision++; controller.sync(); };
  const edit = async (id, command) => {
    assert.equal(command.kind, 'begin');
    await gate.promise;
    input.input = { editToken, nodeId: 'n1', revision: 1, text: '原文', appliedText: '原文', composing: false };
    publish();
    return { ok: true, code: null, documentId: id, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId, input }));
  controller.setOwner(true);
  const selection = { identity: { preview: { sessionId: randomUUID(), generation: 1, mode: 'proofread', version: 1 }, documentId, baseHash: 'b'.repeat(64) }, revision: 1, nodeId: 'n1' };
  const beginning = controller.begin('k', selection, 1);
  let settled = null;
  const flushing = controller.flush().then(ok => { settled = ok; });
  await delay(30);
  assert.equal(settled, null, 'flush must not resolve while begin is in flight');
  gate.release();
  await beginning;
  await flushing;
  assert.equal(settled, true, 'flush must resolve once the begun session is drained');
  controller.dispose();
});

test('workspace store dedupes identical and stale snapshots', () => {
  const store = new WorkspaceStore();
  let emissions = 0;
  store.subscribe(() => { emissions++; });
  const base = { stateRevision: 5, phase: 'idle', current: null, review: null, backupReview: null,
    cleanupPending: false, lastSave: null, lastDeparture: null, canSave: false };
  store.accept(base);
  store.accept(base);
  assert.equal(emissions, 1, 'same object must not re-emit');
  store.accept({ ...base, stateRevision: 4 });
  assert.equal(emissions, 1, 'older revision must be ignored');
  store.accept({ ...base });
  assert.equal(emissions, 1, 'equal revision without desktop bump must be ignored');
  store.accept({ ...base, desktop: { revision: 2, role: 'main', panel: 'docked', reviewed: [], flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null } });
  assert.equal(emissions, 2, 'desktop revision bump must emit');
});

function reviewFixture() {
  const state = { stateRevision: 1, phase: 'reviewing', current: {
    id: randomUUID(), name: 'doc.html',
    input: { draftRevision: 3, candidateHash: 'c'.repeat(64), changes: [
      { nodeId: 'n1', oldText: 'a', newText: 'b' }, { nodeId: 'n2', oldText: 'c', newText: 'd' },
    ] },
    project: { name: 'p', entry: 'doc.html', resources: { items: [], truncated: false } },
    persistence: null,
  }, review: null, backupReview: null, cleanupPending: false, lastSave: null, lastDeparture: null,
    canSave: true, desktop: { revision: 1, role: 'main', panel: 'docked', reviewed: [], flush: null, pdf: null, pdfBusy: false, error: null, pdfExport: null } };
  return state;
}

test('review channel serializes rapid toggles and sends the exact latest full set', async () => {
  const state = reviewFixture();
  const sent = [];
  const gate = barrier();
  const channel = new ReviewChannel(() => state, async command => {
    sent.push(structuredClone(command));
    await gate.promise;
    return { ok: true, code: null, state: null, documentId: state.current.id, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  await until(() => sent.length === 1, 'first review request not sent');
  channel.toggle('n2', true);
  channel.toggle('n1', false);
  assert.deepEqual(channel.currentReviewed([]), ['n2'], 'local intent must drive the displayed set while pending');
  gate.release();
  await until(() => sent.length === 2 && channel.getStatus().pending === false, 'coalesced second request not sent');
  assert.deepEqual(sent[0].nodeIds, ['n1']);
  assert.deepEqual(sent[1].nodeIds, ['n2']);
  assert.equal(sent[1].draftRevision, 3);
  assert.equal(sent[1].candidateHash, state.current.input.candidateHash);
});

test('review channel surfaces rejection, stops the chain and never auto-retries', async () => {
  const state = reviewFixture();
  const sent = [];
  let fail = true;
  const channel = new ReviewChannel(() => state, async command => {
    sent.push(structuredClone(command));
    await delay(1);
    return fail
      ? { ok: false, code: 'REVIEW_STALE', state: null, documentId: state.current.id, copy: null, outcome: null }
      : { ok: true, code: null, state: null, documentId: state.current.id, copy: null, outcome: null };
  });
  channel.sync();
  channel.toggle('n1', true);
  channel.toggleAll(true);
  await until(() => channel.getStatus().error !== null, 'rejection was not surfaced');
  await delay(30);
  assert.equal(sent.length, 1, 'no automatic retry may follow a rejection');
  assert.equal(channel.getStatus().pending, false);
  assert.deepEqual(channel.currentReviewed(['n1']), ['n1'], 'after rejection the displayed set falls back to server truth');
  fail = false;
  // Server truth later gains n1 (recorded by another window); a new explicit
  // toggle must start from that server truth, not from stale local intent.
  state.desktop = { ...state.desktop, reviewed: ['n1'] };
  channel.toggle('n2', true);
  await until(() => sent.length === 2, 'explicit new intent must still be deliverable');
  assert.deepEqual(sent[1].nodeIds, ['n1', 'n2'], 'retry intent starts from server truth');
});
