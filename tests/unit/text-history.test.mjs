import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTextHistory, MAX_HISTORY_STEPS, MAX_HISTORY_TEXT_BYTES } from '../../src/core/history/timeline.ts';
import { buildSourceDiff } from '../../src/core/patch/source-diff.ts';
import { captureTextIntents, rebuildCheckpoint } from '../../src/core/history/checkpoint.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = generation => ({ projectId: 'history', documentId: `doc-${generation}`, generation });
const text = history => Buffer.from(history.candidate.bytes).toString();
const open = html => createTextHistory(Buffer.from(html), identity(1), hash);
const first = (history, value) => history.source.nodes.find(node => node.editable && history.textFor(node.nodeId) === value).nodeId;
function planEdit(history, nodeId, value) {
  return history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
    nodeId, expectedText: history.textFor(nodeId), newText: value });
}
function edit(history, nodeId, value) { const plan = planEdit(history, nodeId, value); history.commit(plan); return plan; }
function move(history, direction) { const plan = history.prepareMove(direction); history.commit(plan); return plan; }
function save(history, generation) { return history.rebaseSaved(history.candidate.bytes, identity(generation)); }

test('Apply groups produce net A-to-C, no-op input keeps Redo, and only a confirmed new branch invalidates Redo', () => {
  const history = open('<!doctype html><p>A &#65;</p>'); const id = first(history, 'A A');
  const prepared = planEdit(history, id, 'B'); assert.equal(text(history), '<!doctype html><p>A &#65;</p>');
  assert.equal(history.summary().undoCount, 0); history.commit(prepared);
  edit(history, id, 'C'); assert.equal(history.candidate.patches.length, 1);
  assert.equal(history.candidate.patches[0].expectedText, 'A A'); assert.equal(history.candidate.patches[0].newText, 'C');
  move(history, 'undo'); assert.equal(history.textFor(id), 'B'); assert.equal(history.summary().redoCount, 1);
  const revision = history.revision; edit(history, id, 'B'); assert.equal(history.revision, revision); assert.equal(history.summary().redoCount, 1);
  const abandoned = planEdit(history, id, 'D'); assert.equal(history.summary().redoCount, 1);
  move(history, 'redo'); assert.equal(history.textFor(id), 'C'); assert.throws(() => history.commit(abandoned), /STALE_HISTORY_TRANSITION/);
  move(history, 'undo'); edit(history, id, 'D'); assert.equal(history.summary().redoCount, 0); assert.throws(() => move(history, 'redo'), /HISTORY_UNAVAILABLE/);
  move(history, 'undo'); move(history, 'undo'); assert.equal(text(history), '<!doctype html><p>A &#65;</p>');
  assert.equal(history.candidate.patches.length, 0); assert.equal(history.summary().dirty, false);
});

test('Save establishes a new byte baseline while Undo/Redo remain logical, use fresh identities and never mutate the saved bytes', () => {
  const original = '\ufeff<!doctype html>\r\n<p>A &#65;</p><!-- keep --><p>末😀</p>';
  let history = open(original); const id = first(history, 'A A'); const tailId = first(history, '末😀'); const tailLogical = history.logicalTarget(tailId);
  edit(history, id, 'B <&> 😀'); edit(history, tailId, '新增很长的末尾🧪');
  const saved = history.candidate.bytes; const oldIdentity = history.source.identity;
  history = save(history, 2); assert.equal(history.summary().dirty, false); assert.equal(history.summary().undoCount, 2);
  const reverse = move(history, 'undo'); assert.deepEqual(reverse.candidate.identity, identity(2)); assert.notDeepEqual(reverse.candidate.identity, oldIdentity);
  assert.equal(history.summary().dirty, true); assert.equal(history.textFor(history.sourceTarget(tailLogical)), '末😀');
  assert.deepEqual(history.source.bytes, saved); assert.equal(text(history), original.replace('A &#65;', 'B &lt;&amp;&gt; 😀'));
  move(history, 'redo'); assert.deepEqual(history.candidate.bytes, saved); assert.equal(history.summary().dirty, false);
  move(history, 'undo'); history = save(history, 3); assert.equal(history.summary().dirty, false); assert.equal(history.summary().redoCount, 1);
  move(history, 'redo'); assert.equal(history.summary().dirty, true); assert.deepEqual(history.candidate.bytes, saved);
});

test('clearing and saving duplicate Texts still allows exact targeted Undo, repeated Save and Redo using re-proven zero-length ranges', () => {
  const original = '<!doctype html><h1>A</h1><p>重复</p><p>重复</p><pre>原</pre>';
  let history = open(original); const duplicates = history.source.nodes.filter(node => node.decodedText === '重复');
  const target = history.logicalTarget(duplicates[1].nodeId);
  edit(history, first(history, 'A'), '前置很长😀'); edit(history, duplicates[1].nodeId, '');
  const empty = text(history); history = save(history, 2); const virtualId = history.sourceTarget(target);
  assert.notEqual(virtualId, duplicates[1].nodeId); assert.equal(history.textFor(virtualId), '');
  move(history, 'undo'); const restored = empty.replace('<p></p>', '<p>重复</p>'); assert.equal(text(history), restored);
  const diff = buildSourceDiff(history.source, history.candidate, hash); assert.equal(diff.changes[0].before.text, ''); assert.equal(diff.changes[0].after.text, '重复');
  assert.equal(diff.unchangedBytes, Buffer.byteLength(empty));
  history = save(history, 3); move(history, 'redo'); assert.equal(text(history), empty); history = save(history, 4);
  move(history, 'undo'); move(history, 'undo'); assert.equal(text(history), original);
  const oldRequest = { identity: identity(1), baseHash: hash(Buffer.from(original)), nodeId: duplicates[1].nodeId, expectedText: '', newText: 'wrong' };
  assert.throws(() => history.prepareEdit(oldRequest), /CHANGE_BINDING_MISMATCH/);
});

test('a new branch after undoing a saved edit retains the actual savepoint even when the saved operation leaves the Redo branch', () => {
  let history = open('<!doctype html><p>A</p><p>X</p>'); const a = history.logicalTarget(first(history, 'A')); const x = history.logicalTarget(first(history, 'X'));
  edit(history, history.sourceTarget(a), 'B'); history = save(history, 2); move(history, 'undo');
  edit(history, history.sourceTarget(x), 'Y'); assert.equal(history.summary().redoCount, 0); assert.equal(text(history), '<!doctype html><p>A</p><p>Y</p>');
  assert.equal(history.candidate.patches.length, 2); assert.equal(history.summary().undoCount, 1);
  history = save(history, 3); move(history, 'undo'); assert.equal(text(history), '<!doctype html><p>A</p><p>X</p>');
  assert.equal(history.source.nodes.find(node => node.nodeId === history.sourceTarget(a)).decodedText, 'A');
});

test('private history round-trips its complete current branch and saved values; restored empty Texts and Redo use a new source identity', () => {
  let history = open('\ufeff<!doctype html>\r\n<p>A &#65;</p><p>B</p>');
  const a = history.logicalTarget(first(history, 'A A')); const b = history.logicalTarget(first(history, 'B'));
  edit(history, history.sourceTarget(a), ''); edit(history, history.sourceTarget(b), 'C'); history = save(history, 2); move(history, 'undo');
  const capture = history.capture(); const raw = JSON.stringify(capture.record);
  for (const forbidden of ['startByte', 'endByte', 'offset', 'selector', 'replacementBytes', 'filePath']) assert.equal(raw.includes(forbidden), false);
  const restored = createTextHistory(history.source.bytes, identity(9), hash, { originBytes: capture.originBytes, record: JSON.parse(raw) });
  assert.equal(text(restored), text(history)); assert.equal(restored.summary().redoCount, 1); assert.equal(restored.revision, history.revision);
  move(restored, 'undo'); assert.equal(text(restored), '\ufeff<!doctype html>\r\n<p>A A</p><p>B</p>');
  move(restored, 'redo'); move(restored, 'redo'); assert.deepEqual(restored.candidate.bytes, history.source.bytes);
});

test('history rejects wrong file bytes, broken operation chains, malformed records and unauthorized source changes', () => {
  let history = open('<!doctype html><p>A</p><script>const x=1</script>'); const id = first(history, 'A'); edit(history, id, 'B');
  const capture = history.capture(); const record = capture.record;
  for (const changed of [{ ...record, version: 2 }, { ...record, cursor: -1 }, { ...record, cursor: 2 }, { ...record, candidateHash: 'a'.repeat(64) },
    { ...record, path: '/tmp/page.html' }, { ...record, operations: [{ ...record.operations[0], before: 'wrong' }] },
    { ...record, operations: [{ ...record.operations[0], offset: 0 }] }, { ...record, operations: [{ ...record.operations[0], after: '\ud800' }] },
    { ...record, operations: [{ ...record.operations[0], target: history.source.nodes.find(node => node.parentTag === 'script').nodeId }] },
    { ...record, savedValues: [{ nodeId: id, text: 'X' }] }]) {
    assert.throws(() => createTextHistory(history.source.bytes, identity(2), hash, { originBytes: capture.originBytes, record: changed }));
  }
  assert.throws(() => createTextHistory(Buffer.from('<!doctype html><p>A</p><script>const x=2</script>'), identity(2), hash, capture), /HISTORY_RECORD_INVALID/);
  assert.throws(() => history.rebaseSaved(Buffer.from('<!doctype html><p>external</p>'), identity(2)), /HISTORY_SAVED_BYTES_MISMATCH/);
  assert.throws(() => history.rebaseSaved(history.candidate.bytes, { generation: 1, documentId: 'doc-1', projectId: 'history' }), /HISTORY_REBASE_IDENTITY/);
});

test('prepared but rejected, superseded or foreign transitions leave history and bytes unchanged until one authorized commit', () => {
  const one = open('<!doctype html><p>A</p>'); const two = open('<!doctype html><p>A</p>'); const id = first(one, 'A');
  const prepared = planEdit(one, id, 'B'); const before = one.capture(); const bytes = one.candidate.bytes;
  assert.deepEqual(one.capture().record, before.record); assert.deepEqual(one.candidate.bytes, bytes);
  assert.throws(() => two.commit(prepared), /STALE_HISTORY_TRANSITION/); assert.throws(() => one.commit({ ...prepared }), /STALE_HISTORY_TRANSITION/);
  const competing = planEdit(one, id, 'C'); one.commit(prepared); assert.throws(() => one.commit(competing), /STALE_HISTORY_TRANSITION/);
  assert.throws(() => one.commit(prepared), /STALE_HISTORY_TRANSITION/); assert.equal(text(one), '<!doctype html><p>B</p>');
  assert.throws(() => { prepared.candidate.patches[0].newText = 'X'; }, TypeError);
  prepared.candidate.bytes.fill(0); before.originBytes.fill(0); assert.equal(text(one), '<!doctype html><p>B</p>');
  assert.throws(() => planEdit(one, id, '\0'), /INVALID_TEXT_NUL/); assert.equal(one.summary().undoCount, 1);
});

test('Unicode, mixed line endings and pre leading LF stay logical across repeated savepoints while Diff exposes actual source encoding', () => {
  let history = open('\ufeff<!doctype html>\r\n<pre>原</pre><p>A\r\nB\nC\rD</p>');
  const pre = history.logicalTarget(first(history, '原')); const mixed = history.logicalTarget(first(history, 'A\nB\nC\nD'));
  edit(history, history.sourceTarget(pre), '\n首😀 <&>'); edit(history, history.sourceTarget(mixed), '新\n行');
  history = save(history, 2); move(history, 'undo');
  assert.equal(history.textFor(history.sourceTarget(mixed)), 'A\nB\nC\nD');
  assert.equal(buildSourceDiff(history.source, history.candidate, hash).changes[0].after.text, 'A\r\nB\r\nC\r\nD');
  history = save(history, 3); move(history, 'undo'); assert.equal(history.textFor(history.sourceTarget(pre)), '原');
  move(history, 'redo'); assert.equal(history.textFor(history.sourceTarget(pre)), '\n首😀 <&>');
  assert.equal(text(history).includes('<pre>\r\n\r\n首😀 &lt;&amp;&gt;</pre>'), true);
});

test('history limits reject a new operation without pruning prior steps or making a saved Undo exceed the reserved text budget', () => {
  const history = open('<!doctype html><p>A</p>'); const captured = history.capture(); const target = first(history, 'A');
  const operations = Array.from({ length: MAX_HISTORY_STEPS }, (_, i) => ({ target, before: i % 2 ? 'B' : 'A', after: i % 2 ? 'A' : 'B' }));
  const full = createTextHistory(history.source.bytes, identity(2), hash, { originBytes: captured.originBytes,
    record: { ...captured.record, operations, cursor: operations.length, revision: operations.length + 1 } });
  const before = full.capture().record; assert.throws(() => planEdit(full, full.sourceTarget(target), 'C'), /HISTORY_OPERATION_LIMIT/);
  assert.equal(full.capture().record, before); assert.equal(full.summary().undoCount, MAX_HISTORY_STEPS);
  const long = 'A'.repeat(64 * 1024); const other = 'B'.repeat(64 * 1024); const large = open(`<!doctype html><p>${long}</p>`);
  const seed = large.capture(); const id = first(large, long); const size = Buffer.byteLength(long);
  const steps = Math.floor(MAX_HISTORY_TEXT_BYTES / (size * 2));
  assert.throws(() => createTextHistory(large.source.bytes, identity(3), hash, { originBytes: seed.originBytes, record: {
    ...seed.record, operations: Array.from({ length: steps }, (_, i) => ({ target: id, before: i % 2 ? other : long, after: i % 2 ? long : other })),
    cursor: 0, revision: steps + 1,
  } }), /HISTORY_STORAGE_LIMIT/);
});

test('v1 checkpoint export/import cannot silently drop source lineage or the Undo/Redo branch', () => {
  const history = open('<!doctype html><p>A</p>'); edit(history, first(history, 'A'), 'B');
  assert.throws(() => captureTextIntents(history.source, history.candidate, hash), /DRAFT_HISTORY_UNSUPPORTED/);
  assert.throws(() => rebuildCheckpoint(history.source, {}, hash), /DRAFT_HISTORY_UNSUPPORTED/);
  assert.equal(history.summary().undoCount, 1); assert.equal(text(history), '<!doctype html><p>B</p>');
});

test('control-character entities stay read-only and cannot introduce unsupported text into history', () => {
  const original = '<!doctype html><p>A&#13;B</p>'; const history = open(original);
  const node = history.source.nodes.find(item => item.decodedText === 'A\rB');
  assert.equal(node.editable, false); assert.equal(node.readOnlyReason, 'PARSE_ERROR');
  assert.deepEqual(history.source.parseErrors, ['control-character-reference']);
  assert.throws(() => history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
    nodeId: node.nodeId, expectedText: node.decodedText, newText: 'new' }), /TARGET_READ_ONLY/);
  assert.equal(history.summary().undoCount, 0); assert.equal(text(history), original);
  const captured = history.capture();
  assert.throws(() => createTextHistory(history.source.bytes, identity(2), hash, { originBytes: captured.originBytes,
    record: { ...captured.record, revision: 2, cursor: 1, operations: [{ target: node.nodeId, before: node.decodedText, after: 'new' }] },
  }), /HISTORY_RECORD_INVALID/);
});

test('a restored empty Text that is still unsaved round-trips its complete candidate and Undo/Redo record', () => {
  let history = open('<!doctype html><p>A</p>'); edit(history, first(history, 'A'), ''); history = save(history, 2); move(history, 'undo');
  const captured = history.capture(); const restored = createTextHistory(history.source.bytes, identity(3), hash,
    { originBytes: captured.originBytes, record: JSON.parse(JSON.stringify(captured.record)) });
  assert.equal(text(restored), '<!doctype html><p>A</p>'); move(restored, 'redo'); assert.equal(text(restored), '<!doctype html><p></p>');
});
