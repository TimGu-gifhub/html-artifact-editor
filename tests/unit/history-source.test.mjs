import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createHistorySource, verifySourceIndex } from '../../src/core/history/source.ts';
import { buildTextIntentCandidate, createPatchEngine } from '../../src/core/patch/engine.ts';
import { buildSourceDiff } from '../../src/core/patch/source-diff.ts';
import { isSourceDiff } from '../../src/contracts/source-diff.ts';
import { isStoredTextIntent } from '../../src/contracts/draft-checkpoint.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = generation => ({ projectId: 'history', documentId: `source-${generation}`, generation });
const parse = (html, generation = 1) => createSourceIndex(Buffer.from(html), identity(generation), hash);
function replace(source, nodeId, text) {
  return createPatchEngine(source, hash).apply({ identity: source.identity, baseHash: source.baseHash,
    nodeId, expectedText: source.nodes.find(node => node.nodeId === nodeId).decodedText, newText: text });
}

test('a fresh baseline proves an emptied Text between exact literal gaps and gives it a fresh identity and zero-length insertion range', () => {
  const original = '\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><p>同文</p><p>同文</p><!-- untouched --><script>const x="&amp;"</script>';
  const saved = '\ufeff<!doctype html>\r\n<h1>前置加长🧪</h1><p>同文</p><p></p><!-- untouched --><script>const x="&amp;"</script>';
  const root = parse(original); const title = root.nodes.find(node => node.parentTag === 'h1'); const target = root.nodes.filter(node => node.decodedText === '同文')[1];
  const result = createHistorySource(Buffer.from(saved), identity(2), { originBytes: root.bytes,
    values: [{ nodeId: title.nodeId, text: '前置加长🧪' }, { nodeId: target.nodeId, text: '' }] }, hash);
  const nextId = result.bindings.find(binding => binding.originNodeId === target.nodeId).nodeId;
  const empty = result.source.nodes.find(node => node.nodeId === nextId);
  assert.notEqual(nextId, target.nodeId); assert.equal(empty.startByte, empty.endByte);
  assert.equal(empty.startByte, Buffer.from(saved).indexOf('<p></p>') + 3); assert.notEqual(empty.startByte, target.startByte);
  const candidate = replace(result.source, nextId, '同文');
  assert.equal(Buffer.from(candidate.bytes).toString(), saved.replace('<p></p>', '<p>同文</p>'));
  const diff = buildSourceDiff(result.source, candidate, hash); assert.equal(isSourceDiff(diff), true);
  assert.equal(diff.changes.length, 1); assert.equal(diff.changes[0].before.text, ''); assert.equal(diff.changes[0].after.text, '同文');
  assert.equal(diff.unchangedBytes, Buffer.byteLength(saved)); assert.deepEqual(verifySourceIndex(result.source, hash).bytes, result.source.bytes);
});

test('all non-Text lexical bytes and never-edited Text spellings remain part of the proof, even when a forged baseline has the same DOM', () => {
  const original = '<!doctype html><p class="keep">A</p><p>&#66;</p><!--x--><script>const x=1</script>';
  const root = parse(original); const target = root.nodes.find(node => node.decodedText === 'A');
  const proof = { originBytes: root.bytes, values: [{ nodeId: target.nodeId, text: '' }] };
  const saved = original.replace('>A<', '><');
  for (const changed of [saved.replace('class="keep"', "class='keep'"), saved.replace('&#66;', 'B'), saved.replace('<!--x-->', '<!--y-->'),
    saved.replace('const x=1', 'const x=2'), saved.replace('class="keep"></p>', 'class="keep"><span></span></p>'), saved + '<p>extra</p>']) {
    assert.notEqual(changed, saved);
    assert.throws(() => createHistorySource(Buffer.from(changed), identity(2), proof, hash), /HISTORY_SOURCE_MISMATCH/);
  }
  assert.equal(createHistorySource(Buffer.from(saved), identity(2), proof, hash).source.baseHash, hash(Buffer.from(saved)));
});

test('empty Text restoration handles implicit body, comment and element siblings, entities, pre compensation and Unicode boundaries', () => {
  for (const [html, oldText] of [
    ['<!doctype html><p>X</p>前😀<!-- keep -->', '前😀'],
    ['<!doctype html><p><b>B</b>尾😀<!-- keep --></p>', '尾😀'],
    ['<!doctype html><pre>\r\n\r\n首😀</pre>', '\n首😀'],
    ['<!doctype html><pre>\r\n首😀</pre>', '首😀'],
    ['<!doctype html><p>&#x1f600; &amp; 字</p>', '😀 & 字'],
  ]) {
    const root = parse(html); const node = root.nodes.find(value => value.decodedText === oldText); assert.ok(node?.editable, html);
    const empty = replace(root, node.nodeId, '');
    const rebound = createHistorySource(empty.bytes, identity(2), { originBytes: root.bytes, values: [{ nodeId: node.nodeId, text: '' }] }, hash);
    const id = rebound.bindings.find(value => value.originNodeId === node.nodeId).nodeId;
    const restored = replace(rebound.source, id, oldText); const final = parse(Buffer.from(restored.bytes).toString(), 3);
    assert.equal(final.nodes.filter(value => value.decodedText === oldText).length, 1);
    const patch = restored.patches[0];
    assert.deepEqual(restored.bytes.subarray(0, patch.startByte), empty.bytes.subarray(0, patch.startByte));
    assert.deepEqual(restored.bytes.subarray(patch.startByte + patch.replacementBytes.length), empty.bytes.subarray(patch.startByte));
  }
});

test('multiple missing Texts do not shift surviving targets onto another duplicate, and untouched empty slots are omitted during candidate reparse', () => {
  const root = parse('<!doctype html><p>A</p><p>B</p><p>C</p><p>D</p>');
  const texts = root.nodes.filter(node => node.editable);
  const result = createHistorySource(Buffer.from('<!doctype html><p></p><p></p><p>C</p><p></p>'), identity(2),
    { originBytes: root.bytes, values: [0, 1, 3].map(i => ({ nodeId: texts[i].nodeId, text: '' })) }, hash);
  const id = result.bindings.find(value => value.originNodeId === texts[2].nodeId).nodeId;
  const changed = replace(result.source, id, '新 C 😀');
  assert.equal(Buffer.from(changed.bytes).toString(), '<!doctype html><p></p><p></p><p>新 C 😀</p><p></p>');
  const engine = createPatchEngine(result.source, hash, changed.patches);
  for (const i of [3, 0, 1]) {
    const nextId = result.bindings.find(value => value.originNodeId === texts[i].nodeId).nodeId;
    engine.apply({ identity: result.source.identity, baseHash: result.source.baseHash, nodeId: nextId, expectedText: '', newText: texts[i].decodedText });
  }
  assert.equal(Buffer.from(engine.candidate.bytes).toString(), '<!doctype html><p>A</p><p>B</p><p>新 C 😀</p><p>D</p>');
});

test('unproven empty nodes, altered offsets, duplicate/foreign targets and source capability tampering are rejected', () => {
  const root = parse('<!doctype html><p>A</p><script>B</script>'); const node = root.nodes.find(value => value.decodedText === 'A');
  const saved = Buffer.from('<!doctype html><p></p><script>B</script>');
  const proof = { originBytes: root.bytes, values: [{ nodeId: node.nodeId, text: '' }] };
  for (const value of [{ ...proof, offset: 18 }, { ...proof, values: [...proof.values, ...proof.values] },
    { ...proof, values: [{ nodeId: root.nodes.find(value => value.parentTag === 'script').nodeId, text: '' }] },
    { ...proof, values: [{ ...proof.values[0], path: '/p' }] }, { ...proof, values: [{ nodeId: 'n999', text: '' }] },
    { ...proof, values: [{ ...proof.values[0], text: '\ud800' }] }]) assert.throws(() => createHistorySource(saved, identity(2), value, hash));
  const source = createHistorySource(saved, identity(2), proof, hash).source;
  const target = source.nodes.find(value => value.decodedText === '');
  const intent = { nodeId: target.nodeId, expectedText: '', newText: 'A', rawSliceHash: target.rawSliceHash,
    contextFingerprint: target.contextFingerprint };
  assert.equal(isStoredTextIntent(intent), false);
  assert.deepEqual(Buffer.from(buildTextIntentCandidate(source, [intent], hash).bytes), Buffer.from(root.bytes));
  for (const value of [{ ...intent, nodeId: node.nodeId }, { ...intent, nodeId: 'n999999' },
    { ...intent, expectedText: 'forged' }, { ...intent, rawSliceHash: hash(Buffer.from('forged')) },
    { ...intent, contextFingerprint: node.contextFingerprint }, { ...intent, offset: target.startByte },
    { ...intent, newText: 42 }, { ...intent, newText: '\ud800' }]) assert.throws(() => buildTextIntentCandidate(source, [value], hash));
  for (const value of [{ ...source, lineage: undefined }, { ...source, nodes: source.nodes.map(value => value === target ? { ...value, startByte: 0 } : value) },
    { ...source, tree: source.tree.slice(1) }]) assert.throws(() => replace(value, target.nodeId, 'A'), /SOURCE_INDEX_MISMATCH|HISTORY_SOURCE_MISMATCH/);
  assert.throws(() => replace(parse(saved.toString(), 2), target.nodeId, 'A'));
});

test('source proof owns its bytes and logical values; caller mutation cannot retarget a later reverse patch', () => {
  const input = Buffer.from('<!doctype html><p>A</p>'); const root = parse(input.toString());
  const saved = Buffer.from('<!doctype html><p></p>'); const values = [{ nodeId: root.nodes[0].nodeId, text: '' }];
  const source = createHistorySource(saved, identity(2), { originBytes: input, values }, hash).source;
  input.fill(0); saved.fill(0); values[0].text = 'X'; source.lineage.originBytes.fill(0); source.bytes.fill(0);
  const restored = replace(source, source.nodes[0].nodeId, 'A'); assert.equal(Buffer.from(restored.bytes).toString(), '<!doctype html><p>A</p>');
});

test('a ten-thousand-line baseline resolves a middle empty Text after preceding UTF-8 growth while preserving every other source byte', () => {
  const lines = Array.from({ length: 10000 }, (_, i) => `<p data-i="${i}">重复😀 ${i}</p>`);
  const html = '\ufeff<!doctype html>\r\n' + lines.join('\r\n'); const root = parse(html);
  const first = root.nodes.find(node => node.decodedText === '重复😀 0'); const middle = root.nodes.find(node => node.decodedText === '重复😀 5000');
  const saved = html.replace('重复😀 0</p>', '前置扩充 🧪 中文</p>').replace('重复😀 5000</p>', '</p>');
  const result = createHistorySource(Buffer.from(saved), identity(2), { originBytes: root.bytes,
    values: [{ nodeId: first.nodeId, text: '前置扩充 🧪 中文' }, { nodeId: middle.nodeId, text: '' }] }, hash);
  const id = result.bindings.find(value => value.originNodeId === middle.nodeId).nodeId;
  const restored = replace(result.source, id, '重复😀 5000');
  assert.deepEqual(Buffer.from(restored.bytes), Buffer.from(saved.replace('<p data-i="5000"></p>', '<p data-i="5000">重复😀 5000</p>')));
});
