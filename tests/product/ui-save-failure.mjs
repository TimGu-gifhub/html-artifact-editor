import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveInputController } from '../../src/ui/live-input.ts';
import { draftFrozen, frozenCopyAvailable, preservedText, quiesced } from '../../src/ui/input-quiescence.ts';

// Minimal InputSnapshot/LiveInputView fixtures shaped after the real contracts;
// defaults describe a normal live editing moment (idle phase, ready mapping).
const input = (over = {}) => ({
  stateRevision: 1, phase: 'idle', mappingStatus: 'ready', mappingReason: null,
  selection: null, input: null, hasUnappliedInput: false, intent: null,
  draftRevision: 1, draftPhase: 'idle', candidateHash: 'a'.repeat(64),
  changes: [], lastCopy: null, canApply: true, canSaveCopy: false, history: null,
  ...over,
});
const view = (over = {}) => ({
  phase: 'active', nodeId: 'n1', localText: '修改后的文字', appliedText: '原文', beginText: '原文',
  composing: false, busy: false, applying: false, flushing: false, resolving: false, dirty: true,
  canRestore: true, intentPending: false, error: null,
  ...over,
});

test('an uncertain save draft quiesces input even though phase is back to idle and canSaveCopy is true', () => {
  const failed = input({ draftPhase: 'uncertain', canSaveCopy: true });
  assert.equal(draftFrozen(failed), true);
  assert.equal(quiesced(failed, view()), true, 'save-failure freeze must not be lifted by canSaveCopy');
  assert.equal(quiesced(failed, view({ composing: true })), true, 'composition during the failure stays frozen, not discarded');
});

test('a closed draft quiesces input', () => {
  const closed = input({ draftPhase: 'closed' });
  assert.equal(draftFrozen(closed), true);
  assert.equal(quiesced(closed, view()), true);
});

test('preparing/applying drafts are normal live input and must not be quiesced', () => {
  for (const draftPhase of ['preparing', 'applying']) {
    assert.equal(draftFrozen(input({ draftPhase })), false, draftPhase);
    assert.equal(quiesced(input({ draftPhase }), view()), false, draftPhase);
    assert.equal(quiesced(input({ draftPhase }), view({ composing: true })), false,
      `${draftPhase} must not interrupt IME composition`);
  }
});

test('an idle draft with ready mapping and no local transaction stays editable, even with canSaveCopy', () => {
  assert.equal(quiesced(input(), view()), false);
  assert.equal(quiesced(input({ canSaveCopy: true }), view()), false,
    'copy authorization alone is neither a freeze nor edit authority');
});

test('transaction phases still quiesce regardless of an idle draft', () => {
  for (const phase of ['saving', 'leaving', 'closed', 'history', 'resolving', 'beginning']) {
    assert.equal(quiesced(input({ phase }), view()), true, phase);
  }
});

test('local flush/resolve rounds quiesce without any draft freeze', () => {
  assert.equal(quiesced(input(), view({ flushing: true })), true);
  assert.equal(quiesced(input(), view({ resolving: true })), true);
});

test('missing input session or unready mapping quiesce independently of the draft phase', () => {
  assert.equal(quiesced(null, view()), true, 'null input is never write authority');
  for (const mappingStatus of ['binding', 'invalidated', 'closed']) {
    assert.equal(quiesced(input({ mappingStatus }), view()), true, mappingStatus);
  }
});

test('failure-frozen text is preserved as read-only (focusable/copyable), not disabled', () => {
  // Clean, fully applied local text still counts as preserved once the save failed.
  const clean = view({ localText: '已确认的候选文字', appliedText: '已确认的候选文字', dirty: false });
  assert.equal(preservedText(input({ draftPhase: 'uncertain' }), clean), true);
  assert.equal(preservedText(input({ draftPhase: 'closed' }), clean), true);
  // Unapplied/failed/composing text keeps its existing preserved semantics.
  assert.equal(preservedText(input({ phase: 'saving' }), view()), true, 'dirty text during a transaction');
  assert.equal(preservedText(input({ phase: 'saving' }), view({ dirty: false, phase: 'failed', error: { message: 'x', detail: '' } })), true);
  // Nothing to preserve: the textarea may stay disabled.
  assert.equal(preservedText(input({ draftPhase: 'uncertain' }), view({ localText: '', dirty: false })), false);
  // Not frozen at all: normal editing, never read-only.
  assert.equal(preservedText(input({ draftPhase: 'preparing' }), view({ composing: true })), false);
  assert.equal(preservedText(input(), view()), false);
});

test('the save-copy note is authorized only for an uncertain save with Main-granted canSaveCopy', () => {
  assert.equal(frozenCopyAvailable(input({ draftPhase: 'uncertain', canSaveCopy: true })), true);
  assert.equal(frozenCopyAvailable(input({ draftPhase: 'uncertain' })), false,
    'Preview Apply unknown / history failure without copy authority must not promise a preservable candidate');
  assert.equal(frozenCopyAvailable(input({ draftPhase: 'closed', canSaveCopy: true })), false);
  assert.equal(frozenCopyAvailable(input({ canSaveCopy: true })), false);
  assert.equal(frozenCopyAvailable(null), false);
});

// ---------------------------------------------------------------------------
// Behavior tests against the real LiveInputController with a Main-like fixture
// (state is published before each invoke reply resolves, like the real IPC).
// ---------------------------------------------------------------------------

async function until(check, message) {
  const limit = Date.now() + 1500;
  while (!check()) { if (Date.now() > limit) throw new Error(message); await delay(5); }
}

function controllerFixture(over = {}) {
  const documentId = randomUUID(); const editToken = randomUUID(); const calls = [];
  const input = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', mappingStatus: 'ready', mappingReason: null,
    selection: null, draftRevision: 1, candidateHash: 'a'.repeat(64), hasUnappliedInput: false, canApply: true,
    intent: null, changes: [], lastCopy: null, canSaveCopy: false, history: null,
    input: { editToken, nodeId: 'n1', revision: 1, text: '原文', appliedText: '原文', composing: false },
    ...over };
  let controller;
  const publish = () => { input.stateRevision++;
    input.hasUnappliedInput = !!input.input && input.input.text !== input.input.appliedText;
    input.canApply = input.phase === 'idle' && !!input.input && !input.input.composing; controller.sync(); };
  const edit = async (id, command) => {
    calls.push(structuredClone(command));
    await delay(1);
    assert.equal(id, documentId);
    if (command.kind === 'change') {
      assert.equal(input.phase, 'idle');
      input.input = { ...input.input, text: command.value.newText, composing: command.value.composing,
        revision: command.value.inputRevision };
      publish();
    } else if (command.kind === 'apply') {
      assert.equal(input.phase, 'idle');
      const accepted = { ...input.input }; input.phase = 'applying'; publish();
      input.input = { ...accepted, appliedText: accepted.text, revision: accepted.revision + 1 };
      input.phase = 'idle'; input.draftRevision++; publish();
    } else if (command.kind === 'resolve') {
      input.input = null; input.intent = null; publish();
    } else throw new Error(`unexpected UI command ${command.kind}`);
    return { ok: true, code: null, documentId, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId, input }));
  controller.setOwner(true); controller.sync();
  return { controller, input, calls, publish, documentId, editToken };
}

const selectionFor = (documentId, nodeId) => ({
  identity: { preview: { sessionId: randomUUID(), generation: 1, mode: 'proofread', version: 1 },
    documentId, baseHash: 'b'.repeat(64) },
  revision: 1, nodeId,
});

test('a frozen owner with a pending different-target intent sends nothing and preserves its session', async () => {
  const f = controllerFixture();
  try {
    // Save outcome becomes uncertain (copy of the confirmed candidate authorized),
    // and the user has meanwhile clicked another Text.
    f.input.draftPhase = 'uncertain'; f.input.canSaveCopy = true;
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '另一段' };
    f.publish();
    await delay(350); // well beyond AUTO_APPLY_MS: no automatic change may fire
    assert.deepEqual(f.calls, [], 'frozen draft must not send change/apply/resolve');
    const v = f.controller.getView();
    assert.equal(v.phase, 'active', 'original token/session must be retained');
    assert.equal(v.nodeId, 'n1');
    assert.equal(v.localText, '原文', 'original text must be retained');
    assert.equal(v.intentPending, true, 'the pending intent is preserved, never auto-resolved');
    assert.equal(f.controller.hasSessionOrPending(), true);
    // Clean, fully applied owner may still acknowledge a flush (exclusive copy save-as).
    assert.equal(await f.controller.flush(), true, 'clean frozen owner must flush true');
    assert.deepEqual(f.calls, [], 'flush must not send any modification under a freeze');
    assert.equal(f.controller.hasSessionOrPending(), true, 'flush must not release the token');
    // Frozen Escape must not attempt any restore of modifications.
    assert.equal(f.controller.escape(), false);
    f.controller.restoreParagraph();
    f.controller.retry();
    await delay(30);
    assert.deepEqual(f.calls, [], 'escape/restore/retry must not send under a freeze');
  } finally { f.controller.dispose(); }
});

test('a dirty frozen owner flushes false, keeps its buffer and never auto-applies', async () => {
  const f = controllerFixture();
  try {
    f.controller.onChange('未应用的修改');
    await until(() => f.input.input.text === '未应用的修改', 'change not delivered before freeze');
    const before = f.calls.length;
    // Freeze before the auto-apply timer fires.
    f.input.draftPhase = 'uncertain'; f.input.canSaveCopy = true; f.publish();
    await delay(350);
    assert.equal(f.calls.length, before, 'the scheduled auto-apply must be suspended by the freeze');
    assert.equal(f.calls.filter(value => value.kind === 'apply').length, 0);
    assert.equal(f.controller.getView().localText, '未应用的修改', 'buffered text must be preserved');
    assert.equal(await f.controller.flush(), false, 'dirty owner must not flush');
    assert.equal(f.controller.escape(), false, 'frozen Escape must not revert the preserved text');
    assert.equal(f.controller.getView().localText, '未应用的修改');
    f.controller.restoreParagraph();
    assert.equal(f.controller.getView().localText, '未应用的修改', 'frozen restore must not overwrite text');
    assert.equal(f.calls.length, before);
    // A different-target intent arriving while dirty is parked, not resolved.
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '另一段' }; f.publish();
    await delay(50);
    assert.equal(f.calls.filter(value => value.kind === 'resolve').length, 0);
  } finally { f.controller.dispose(); }
});

test('a composing frozen owner flushes false and keeps its composition state', async () => {
  const f = controllerFixture();
  try {
    f.controller.onCompositionStart();
    f.controller.onChange('拼');
    await until(() => f.input.input.composing === true, 'composing change not delivered');
    const before = f.calls.length;
    f.input.draftPhase = 'uncertain'; f.publish();
    await delay(350);
    assert.equal(f.calls.length, before, 'no automatic apply/resolve while frozen mid-composition');
    assert.equal(f.controller.isComposing(), true, 'composition state must be preserved');
    assert.equal(await f.controller.flush(), false);
    // Late input events under the freeze are ignored wholesale: text/composition stay.
    f.controller.onCompositionEnd('拼音');
    f.controller.onChange('拼音');
    assert.equal(f.controller.isComposing(), true);
    assert.equal(f.controller.getView().localText, '拼');
    assert.equal(f.calls.length, before);
  } finally { f.controller.dispose(); }
});

test('a failed frozen owner flushes false, keeps the failure and rejects retry/escape', async () => {
  const f = controllerFixture();
  try {
    f.controller.onChange('未投递的修改');
    await until(() => f.input.input.text === '未投递的修改', 'change not delivered');
    // Session is lost with unapplied text, then the save outcome turns uncertain.
    f.input.input = null; f.input.draftPhase = 'uncertain'; f.input.canSaveCopy = true; f.publish();
    assert.equal(f.controller.getView().phase, 'failed');
    const before = f.calls.length;
    assert.equal(await f.controller.flush(), false, 'failed owner must not flush');
    f.controller.retry();
    f.controller.escape();
    f.controller.restoreParagraph();
    await delay(30);
    assert.equal(f.calls.length, before, 'retry/escape/restore must not send under a freeze');
    assert.equal(f.controller.getView().phase, 'failed', 'the failure must be preserved, not cleared');
    assert.equal(f.controller.getView().localText, '未投递的修改');
  } finally { f.controller.dispose(); }
});

test('begin is refused under a frozen draft (covers the app.tsx automatic begin path)', async () => {
  const f = controllerFixture({ input: null, draftPhase: 'uncertain', canSaveCopy: true,
    selection: null });
  try {
    const selection = selectionFor(f.documentId, 'n9');
    await f.controller.begin('k1', selection, 1);
    await f.controller.begin('k1', selection, 1);
    assert.deepEqual(f.calls, [], 'no begin command may reach Main under a freeze');
    assert.equal(f.controller.getView().phase, 'idle');
    assert.equal(f.controller.getView().error, null, 'a refused frozen begin is not a fake failure');
    assert.equal(f.controller.hasSessionOrPending(), false);
  } finally { f.controller.dispose(); }
});

test('normal preparing/applying draft phases are not frozen: buffering, apply and resolve keep working', async () => {
  const f = controllerFixture();
  try {
    f.input.draftPhase = 'preparing'; f.publish();
    f.controller.onChange('新内容');
    await until(() => f.input.input.text === '新内容', 'change blocked by a normal preparing phase');
    await until(() => f.input.input.appliedText === '新内容', 'auto-apply blocked by a normal preparing phase');
    assert.ok(f.calls.some(value => value.kind === 'apply'));
    // A different-target intent is still drained and resolved normally.
    f.input.draftPhase = 'applying';
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '另一段' }; f.publish();
    await until(() => f.controller.getView().phase === 'idle', 'resolve blocked by a normal applying phase');
    const resolves = f.calls.filter(value => value.kind === 'resolve');
    assert.equal(resolves.length, 1);
    assert.equal(resolves[0].value.intentSequence, 1);
    assert.equal(f.controller.getView().phase, 'idle', 'accepted resolve ends the session normally');
  } finally { f.controller.dispose(); }
});
