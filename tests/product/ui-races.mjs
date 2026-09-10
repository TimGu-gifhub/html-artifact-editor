import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveInputController, validateInputText } from '../../src/ui/live-input.ts';

const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
async function until(check, message) {
  const limit = Date.now() + 1500;
  while (!check()) { if (Date.now() > limit) throw new Error(message); await delay(5); }
}
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
    await delay(1); // Like IPC, yield to input events; also bound a bad retry loop.
    if (calls.length > 25) return { ok: false, code: 'TEST_RETRY_LOOP' };
    assert.equal(id, documentId);
    if (command.kind === 'change') {
      assert.equal(input.phase, 'idle'); assert.equal(command.value.editToken, editToken);
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
      assert.equal(command.value.intentSequence, input.intent.sequence);
      input.input = null; input.intent = null; publish();
    } else throw new Error('unexpected UI command');
    return { ok: true, code: null, documentId, state: null, copy: null, outcome: null };
  };
  controller = new LiveInputController(edit, () => ({ documentId, input }));
  controller.setOwner(true); controller.sync();
  return { controller, input, calls, publish, hold: () => { hold = barrier(); return hold; } };
}

test('newer typing survives a delayed Apply acknowledgement and flush commits the latest text', async () => {
  const f = fixture(); const held = f.hold();
  try {
    f.controller.onChange('第一次'); const draining = f.controller.flush();
    await until(() => f.input.phase === 'applying', 'Apply did not start');
    f.controller.onChange('后来的文字 😀'); held.release();
    assert.equal(await draining, true);
    assert.equal(f.controller.getView().localText, '后来的文字 😀');
    assert.equal(f.input.input.appliedText, '后来的文字 😀');
  } finally { held.release(); f.controller.dispose(); }
});
test('composition is retained in Main, blocks Apply and flush, and clears only on composition end', async () => {
  const f = fixture();
  try {
    f.controller.onCompositionStart(); f.controller.onChange('中文组词');
    await until(() => f.input.input.composing, 'Main never received composing=true');
    assert.equal(await f.controller.flush(), false); await delay(300);
    assert.equal(f.calls.filter(value => value.kind === 'apply').length, 0);
    f.controller.onCompositionEnd('中文完成'); assert.equal(await f.controller.flush(), true);
    assert.equal(f.input.input.composing, false); assert.equal(f.input.input.appliedText, '中文完成');
  } finally { f.controller.dispose(); }
});
test('a selection intent during a flush resolves once after the latest text, without looping Apply', async () => {
  const f = fixture();
  try {
    f.controller.onChange('更新文字'); const draining = f.controller.flush();
    f.input.intent = { sequence: 1, nodeId: 'n2', text: '下一段' }; f.publish();
    assert.equal(await draining, true);
    await until(() => f.calls.some(value => value.kind === 'resolve'), 'selection intent was not resolved');
    assert.ok(f.calls.filter(value => value.kind === 'apply').length <= 2);
    assert.equal(f.calls.filter(value => value.kind === 'resolve').length, 1);
  } finally { f.controller.dispose(); }
});
test('disposing a controller does not send buffered input after an already accepted Apply settles', async () => {
  const f = fixture(); const held = f.hold();
  try {
    f.controller.onChange('已接受文字'); const draining = f.controller.flush();
    await until(() => f.input.phase === 'applying', 'Apply did not start');
    f.controller.onChange('不得迟到发送'); f.controller.dispose();
    const acceptedCount = f.calls.length; held.release(); await draining; await delay(40);
    assert.equal(f.calls.length, acceptedCount);
  } finally { held.release(); f.controller.dispose(); }
});
test('Escape before auto Apply restores the current preview and creates no Apply operation', async () => {
  const f = fixture();
  try {
    f.controller.onChange('取消的输入'); await until(() => f.input.input.text === '取消的输入', 'change did not reach Main');
    assert.equal(f.controller.escape(), true); await delay(350);
    assert.equal(f.input.input.text, '原文'); assert.equal(f.input.input.appliedText, '原文');
    assert.equal(f.calls.filter(value => value.kind === 'apply').length, 0);
  } finally { f.controller.dispose(); }
});

test('composition start alone reaches Main before any subsequent text event', async () => {
  const f = fixture();
  try {
    f.controller.onCompositionStart();
    await until(() => f.input.input.composing, 'composition start was never sent to Main');
    assert.equal(f.input.input.text, '原文'); assert.equal(await f.controller.flush(), false);
  } finally { f.controller.dispose(); }
});

test('typing after Escape during an accepted Apply supersedes the cancellation and survives the old reply', async () => {
  const f = fixture(); const held = f.hold();
  try {
    f.controller.onChange('已接受'); const draining = f.controller.flush();
    await until(() => f.input.phase === 'applying', 'Apply did not start');
    f.controller.onChange('取消这次输入'); assert.equal(f.controller.escape(), true);
    f.controller.onChange('取消后重新输入 🧪'); held.release();
    assert.equal(await draining, true);
    assert.equal(f.controller.getView().localText, '取消后重新输入 🧪');
    assert.equal(f.input.input.appliedText, '取消后重新输入 🧪');
  } finally { held.release(); f.controller.dispose(); }
});

test('visible text limits respect the 64 KiB UTF-8 patch cap without splitting Chinese or emoji', () => {
  assert.equal(validateInputText('a'.repeat(64 * 1024)), null);
  assert.equal(validateInputText('🧪'.repeat(16 * 1024)), null);
  assert.notEqual(validateInputText('中'.repeat(22 * 1024)), null);
  assert.notEqual(validateInputText('🧪'.repeat(16 * 1024 + 1)), null);
});
