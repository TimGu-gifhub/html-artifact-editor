import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine, buildPatchCandidate, MAX_PATCHES } from '../../src/core/patch/engine.ts';
import { defaultLineEnding, chooseLineEnding, MAX_TEXT_BYTES } from '../../src/core/patch/encoding.ts';
import { MAX_SOURCE_BYTES } from '../../src/contracts/source-tree.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = { projectId: 'p1', documentId: 'd1', generation: 1 };
const fixture = (html) => {
  const source = createSourceIndex(Buffer.from(html), identity, hash);
  return { source, engine: createPatchEngine(source, hash) };
};
function apply(engine, node, text, expectedText) {
  return engine.apply({ identity: engine.source.identity, baseHash: engine.source.baseHash, nodeId: node.nodeId,
    expectedText: expectedText ?? engine.candidate.patches.find((patch) => patch.nodeId === node.nodeId)?.newText ?? node.decodedText,
    newText: text });
}
const raw = (bytes) => Buffer.from(bytes).toString('utf8');
function assertOutside(original, result, patches) {
  let previousOld = 0;
  let previousNew = 0;
  for (const patch of [...patches].sort((a, b) => a.startByte - b.startByte)) {
    const length = patch.startByte - previousOld;
    assert.deepEqual(Buffer.from(result.subarray(previousNew, previousNew + length)), original.subarray(previousOld, patch.startByte));
    previousNew += length + patch.replacementBytes.length;
    previousOld = patch.endByte;
  }
  assert.deepEqual(Buffer.from(result.subarray(previousNew)), original.subarray(previousOld));
}

test('10,000 lines: only middle Text bytes change, with BOM/mixed endings/scripts/attrs/comments intact', () => {
  const html = '\ufeff<!doctype html>\r\n<script>const x="do not touch";</script><!--原注释-->'
    + Array.from({ length: 10_000 }, (_, i) => `<p id='r${i}' data-v="&amp;">行${i} 😀 &amp; 原文</p>${i % 3 ? '\r\n' : '\n'}`).join('');
  const original = Buffer.from(html);
  const { source, engine } = fixture(html);
  const node = source.nodes.find((item) => item.decodedText === '行5000 😀 & 原文');
  const candidate = apply(engine, node, '已修正 🧪 <标签> & 新文字');
  const before = html.slice(0, html.indexOf('行5000 😀'));
  const after = html.slice(html.indexOf('行5000 😀') + '行5000 😀 &amp; 原文'.length);
  assert.deepEqual(Buffer.from(candidate.bytes), Buffer.concat([Buffer.from(before), Buffer.from('已修正 🧪 &lt;标签&gt; &amp; 新文字'), Buffer.from(after)]));
  assertOutside(original, candidate.bytes, candidate.patches);
  assert.equal(candidate.resultHash, hash(candidate.bytes));
  assert.deepEqual(Buffer.from(source.bytes), original);
});

test('different-length multi-node edits use the original offsets regardless of edit order', () => {
  const html = '<!doctype html><p>甲😀</p><!--保留--><p>乙 &amp; 原文</p><p>丙</p>';
  const { source, engine } = fixture(html);
  apply(engine, source.nodes[2], '末尾加长内容');
  apply(engine, source.nodes[0], '短');
  const candidate = apply(engine, source.nodes[1], '');
  assert.equal(raw(candidate.bytes), '<!doctype html><p>短</p><!--保留--><p></p><p>末尾加长内容</p>');
  assertOutside(Buffer.from(html), candidate.bytes, candidate.patches);
  assert.deepEqual(candidate.patches.map((p) => p.startByte), [...candidate.patches.map((p) => p.startByte)].sort((a,b)=>a-b));
  apply(engine, source.nodes[1], '恢复😀', '');
  assert.equal(raw(engine.candidate.bytes), '<!doctype html><p>短</p><!--保留--><p>恢复😀</p><p>末尾加长内容</p>');
});

test('same-node A→B→C is one net patch; no-op and A→B→A preserve original entity spellings', () => {
  const html = '\ufeff<!doctype html><p>A &#x1f600; &#160; &amp;</p>';
  const { source, engine } = fixture(html);
  const node = source.nodes[0];
  const initial = engine.candidate;
  assert.equal(apply(engine, node, node.decodedText), initial);
  const b = apply(engine, node, 'B😀');
  assert.equal(apply(engine, node, 'B😀'), b);
  const c = apply(engine, node, 'C😀');
  assert.equal(c.patches.length, 1);
  assert.equal(c.patches[0].expectedText, node.decodedText);
  const restored = apply(engine, node, node.decodedText);
  assert.equal(restored.patches.length, 0);
  assert.equal(raw(restored.bytes), html);
  assert.equal(restored.resultHash, source.baseHash);
});

test('line ending choice honors a single local style, otherwise document counts, with LF on ties', () => {
  assert.equal(defaultLineEnding('a\r\nb\nc'), '\n');
  assert.equal(defaultLineEnding('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(defaultLineEnding('a\rb\rc'), '\r');
  assert.deepEqual(chooseLineEnding('a\rb', '\r\n'), { ending: '\r', mixed: false });
  for (const [html, ending, mixed] of [
    ['<!doctype html>\r\n<p>旧\n局部</p>\r\n', '\n', false],
    ['<!doctype html>\r\n<p>旧无换行</p>\r\n', '\r\n', false],
    ['<!doctype html>\r\n<p>旧\r\n混合\n局部</p>\r\n', '\r\n', true],
    ['<!doctype html><p>旧\r局部</p>', '\r', false],
  ]) {
    const { source, engine } = fixture(html);
    const node = source.nodes.find((item) => item.parentTag === 'p');
    const candidate = apply(engine, node, '中😀\r\n组合e\u0301\r末\n行');
    const patch = candidate.patches[0];
    assert.equal(patch.newText, '中😀\n组合e\u0301\n末\n行');
    assert.equal(raw(patch.replacementBytes), ['中😀', '组合e\u0301', '末', '行'].join(ending));
    assert.equal(patch.lineEnding, ending);
    assert.equal(patch.mixedLineEndings, mixed);
    assertOutside(Buffer.from(html), candidate.bytes, candidate.patches);
  }
});

test('pre/listing initial newline compensation preserves intended logical LF and source proof', () => {
  for (const html of [
    '<!doctype html><pre>旧</pre>', '<!doctype html><pre>\n旧</pre>',
    '<!doctype html><pre>\n\n旧</pre>', '<!doctype html><pre>&#10;\n旧</pre>',
    '<!doctype html><pre>\r\n\r\n旧</pre>', '<!doctype html><listing>旧</listing>',
    '<!doctype html><pre><!--保留-->旧</pre>', '<!doctype html><pre><b>粗体</b>旧</pre>',
  ]) {
    const { source, engine } = fixture(html);
    const node = source.nodes.find((item) => item.decodedText.includes('旧'));
    assert.ok(node.editable, html);
    const candidate = apply(engine, node, '\n新增空行\n\n正文');
    const reparsed = createSourceIndex(candidate.bytes, identity, hash);
    const changed = reparsed.nodes.find((item) => item.decodedText.includes('新增'));
    assert.equal(changed.decodedText, '\n新增空行\n\n正文', html);
    assert.ok(changed.editable, html);
    assertOutside(Buffer.from(html), candidate.bytes, candidate.patches);
    apply(engine, node, node.decodedText);
    assert.equal(raw(engine.candidate.bytes), html);
  }
});

test('tag/script paste is text and never changes elements, attributes or script tokens', () => {
  const { source, engine } = fixture('<!doctype html><p data-secret="&quot;">旧</p><script>const kept="<b>";</script>');
  const input = '<script>alert(1)</script><img src=x onerror=boom()> & "单引号\'"';
  const candidate = apply(engine, source.nodes[0], input);
  assert.match(raw(candidate.bytes), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const reparsed = createSourceIndex(candidate.bytes, identity, hash);
  assert.equal(reparsed.nodes[0].decodedText, input);
  assert.equal(reparsed.tree.filter((n) => n.kind === 'element' && n.name === 'script').length, 1);
  assert.equal(reparsed.tree.filter((n) => n.kind === 'element' && n.name === 'img').length, 0);
});

test('failed input, stale bindings and unsafe contexts retain the previous candidate', () => {
  const { source, engine } = fixture('<!doctype html><p>原文</p><table> \n<tr><td>单元</td></tr></table><textarea>表单</textarea>');
  const node = source.nodes[0];
  const current = apply(engine, node, '有效草稿');
  for (const input of ['\0', '\ud800', '\udfff', '中'.repeat(Math.ceil(MAX_TEXT_BYTES / 3)), '\u0001']) {
    assert.throws(() => apply(engine, node, input));
    assert.equal(engine.candidate, current);
  }
  const change = { identity, baseHash: source.baseHash, nodeId: node.nodeId, expectedText: '有效草稿', newText: '下一次' };
  for (const bad of [{ ...change, offset: 0 }, { ...change, path: 'wrong.html' },
    { ...change, baseHash: '0'.repeat(64) }, { ...change, identity: { ...identity, generation: 2 } },
    { ...change, expectedText: '原文' }, { ...change, nodeId: 'fake' }]) {
    assert.throws(() => engine.apply(bad)); assert.equal(engine.candidate, current);
  }
  const form = source.nodes.find((item) => item.parentTag === 'textarea');
  assert.throws(() => apply(engine, form, '拒绝'), /TARGET_READ_ONLY/);
  const space = source.nodes.find((item) => item.parentTag === 'table');
  assert.throws(() => apply(engine, space, '这会被移出表格'), /CANDIDATE_/);
  assert.equal(engine.candidate, current);
});

test('canonical patch validation rejects overlap, altered byte ranges/hash/context and raw HTML replacement', () => {
  const { source, engine } = fixture('<!doctype html><p>甲</p><p>乙</p>');
  const candidate = apply(engine, source.nodes[0], '新值');
  const good = candidate.patches[0];
  for (const patches of [[good, good], [{ ...good, startByte: good.startByte - 1 }],
    [{ ...good, endByte: source.nodes[1].endByte }], [{ ...good, oldSliceHash: '0'.repeat(64) }],
    [{ ...good, contextFingerprint: '0'.repeat(64) }], [{ ...good, expectedText: '错' }],
    [{ ...good, newText: '\r' }], [{ ...good, replacementBytes: Buffer.from('<script>bad</script>') }],
    [{ ...good, identity: { ...identity, documentId: 'other' } }], Array(MAX_PATCHES + 1).fill(good)]) {
    assert.throws(() => buildPatchCandidate(source, patches, hash));
  }
  const forged = { ...source, nodes: source.nodes.map((node) => ({ ...node, startByte: 0 })) };
  assert.throws(() => createPatchEngine(forged, hash), /SOURCE_INDEX_MISMATCH/);
  assert.throws(() => createPatchEngine({ ...source, baseHash: '0'.repeat(64) }, hash), /SOURCE_INDEX_MISMATCH/);
});

test('candidate and patch byte views cannot mutate draft authority', () => {
  const { source, engine } = fixture('<!doctype html><p>原文</p>');
  const candidate = apply(engine, source.nodes[0], '新文');
  const expected = hash(candidate.bytes);
  candidate.bytes.fill(0);
  candidate.patches[0].replacementBytes.fill(0);
  assert.equal(hash(engine.candidate.bytes), expected);
  assert.equal(raw(candidate.patches[0].replacementBytes), '新文');
  assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.patches) && Object.isFrozen(candidate.patches[0]));
});

test('200 deterministic Unicode/entity cases match independently assembled expected bytes', () => {
  let seed = 0x91ba53;
  const random = (limit) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % limit; };
  const pairs = [['甲', '甲'], ['😀', '😀'], ['e\u0301', 'e\u0301'], ['&amp;', '&'],
    ['&#xA0;', '\u00a0'], ['&#128512;', '😀'], ['&lt;', '<'], ['&gt;', '>'], ['$', '$']];
  for (let i = 0; i < 200; i++) {
    const chosen = Array.from({ length: 1 + random(9) }, () => pairs[random(pairs.length)]);
    const encoded = chosen.map((item) => item[0]).join('');
    const decoded = chosen.map((item) => item[1]).join('');
    const prefix = (i % 2 ? '\ufeff' : '') + '<!doctype html>\r\n<p>不修改 &amp; 😀</p><!--保留--><section><strong>';
    const suffix = '</strong><span>尾部</span></section>\n<script>const x="&lt;";</script>';
    const { source, engine } = fixture(prefix + encoded + suffix);
    const node = source.nodes.find((n) => n.parentTag === 'strong');
    const next = Array.from({ length: random(10) }, () => pairs[random(pairs.length)][1]).join('');
    const candidate = apply(engine, node, next);
    const independentEncoding = [...next].map((character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character).join('');
    assert.equal(raw(candidate.bytes), prefix + (next === decoded ? encoded : independentEncoding) + suffix);
    assertOutside(Buffer.from(prefix + encoded + suffix), candidate.bytes, candidate.patches);
  }
});

test('1000 disjoint patches are accepted; 1001 are rejected before producing a candidate', () => {
  const { source, engine } = fixture('<!doctype html>' + '<p>x</p>'.repeat(MAX_PATCHES + 1));
  const first = apply(engine, source.nodes[0], 'y').patches[0];
  const patches = source.nodes.map((node) => ({ ...first, nodeId: node.nodeId, startByte: node.startByte,
    endByte: node.endByte, oldSliceHash: node.rawSliceHash, contextFingerprint: node.contextFingerprint }));
  const candidate = buildPatchCandidate(source, patches.slice(0, MAX_PATCHES), hash);
  assert.equal(raw(candidate.bytes), '<!doctype html>' + '<p>y</p>'.repeat(MAX_PATCHES) + '<p>x</p>');
  assert.throws(() => buildPatchCandidate(source, patches, hash), /PATCH_COUNT_LIMIT/);
});

test('UTF-8 input boundary and encoded output limit are enforced without changing an existing draft', () => {
  const { source, engine } = fixture('<!doctype html><p>x</p>');
  apply(engine, source.nodes[0], '😀'.repeat(MAX_TEXT_BYTES / 4));
  const valid = engine.candidate;
  assert.throws(() => apply(engine, source.nodes[0], '😀'.repeat(MAX_TEXT_BYTES / 4) + 'x'), /TEXT_SIZE_LIMIT/);
  assert.equal(engine.candidate, valid);
  const prefix = '<!doctype html><!--';
  const suffix = '--><p>x</p>';
  const nearLimit = prefix + 'c'.repeat(MAX_SOURCE_BYTES - 10 - prefix.length - suffix.length) + suffix;
  const large = fixture(nearLimit);
  const previous = large.engine.candidate;
  assert.throws(() => apply(large.engine, large.source.nodes[0], '&'.repeat(100)), /CANDIDATE_SIZE_LIMIT/);
  assert.equal(large.engine.candidate, previous);
});
