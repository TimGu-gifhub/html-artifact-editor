import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine, buildTextIntentCandidate } from '../../src/core/patch/engine.ts';
import { buildSourceDiff } from '../../src/core/patch/source-diff.ts';
import { isDiffReview, isSourceDiff } from '../../src/contracts/source-diff.ts';
import { isWorkspaceCommand } from '../../src/contracts/workspace-editor.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const setup = html => {
  const source = createSourceIndex(Buffer.from(html), { projectId: 'diff', documentId: 'source', generation: 1 }, hash);
  const engine = createPatchEngine(source, hash);
  const apply = (old, next) => {
    const node = source.nodes.find(value => value.editable && value.decodedText === old);
    return engine.apply({ identity: source.identity, baseHash: source.baseHash, nodeId: node.nodeId,
      expectedText: engine.candidate.patches.find(patch => patch.nodeId === node.nodeId)?.newText ?? old, newText: next });
  };
  const diff = () => buildSourceDiff(source, engine.candidate, hash);
  return { source, engine, apply, diff };
};
function verify(source, candidate, diff) {
  assert.equal(isSourceDiff(diff), true); assert.equal(diff.baseHash, hash(source.bytes)); assert.equal(diff.candidateHash, hash(candidate.bytes));
  const before = Buffer.from(source.bytes); const after = Buffer.from(candidate.bytes); let oldEnd = 0; let newEnd = 0; const rebuilt = [];
  for (const change of diff.changes) {
    assert.deepEqual(Buffer.from(change.before.text), before.subarray(change.before.startByte, change.before.endByte));
    assert.deepEqual(Buffer.from(change.after.text), after.subarray(change.after.startByte, change.after.endByte));
    assert.deepEqual(before.subarray(oldEnd, change.before.startByte), after.subarray(newEnd, change.after.startByte));
    rebuilt.push(before.subarray(oldEnd, change.before.startByte), Buffer.from(change.after.text));
    oldEnd = change.before.endByte; newEnd = change.after.endByte;
  }
  assert.deepEqual(before.subarray(oldEnd), after.subarray(newEnd)); rebuilt.push(before.subarray(oldEnd));
  assert.deepEqual(Buffer.concat(rebuilt), after); assert.equal(diff.unchangedBytes, before.length - diff.changes.reduce((sum, value) => sum + value.before.endByte - value.before.startByte, 0));
}

test('source Diff exposes full lexical replacements and UTF-8 ranges, preserving entity spellings, BOM and unmodified scripts/attributes/resources', () => {
  const html = '\ufeff<!doctype html>\r\n<script>const keep="&amp;";</script><h1 data-x="&#160;">A &#x1f600; &#160; &amp;</h1><!-- unchanged -->';
  const f = setup(html); f.apply('A 😀 \u00a0 &', 'B 😀 \u00a0 <&>'); const diff = f.diff(); const change = diff.changes[0];
  assert.equal(change.before.text, 'A &#x1f600; &#160; &amp;'); assert.equal(change.after.text, 'B 😀 \u00a0 &lt;&amp;&gt;');
  assert.equal(change.before.startByte, Buffer.from(html).indexOf('A &#x1f600;'));
  assert.equal(change.lineEnding, 'crlf'); verify(f.source, f.engine.candidate, diff); assert.deepEqual(Buffer.from(f.source.bytes), Buffer.from(html));
  assert.throws(() => { diff.changes[0].after.text = 'hidden replacement'; }, TypeError);
});

test('different-length and emptied Texts report separate before/after positions and reconstruct the entire candidate with every untouched byte', () => {
  const f = setup('<!doctype html><p>甲😀</p>\r\n<p>乙 &amp; 原文</p>\n<p>丙</p>');
  f.apply('丙', '末尾加长🧪'); f.apply('甲😀', '短'); f.apply('乙 & 原文', ''); const diff = f.diff();
  assert.equal(diff.changes.length, 3); assert.equal(diff.changes[1].after.startByte, diff.changes[1].after.endByte);
  assert.notEqual(diff.changes[2].before.startByte, diff.changes[2].after.startByte); verify(f.source, f.engine.candidate, diff);
});

test('mixed line endings and pre leading-LF compensation are visible as actual source bytes, not normalized DOM text', () => {
  const f = setup('<!doctype html><p>A\r\nB\nC\rD</p><pre>原</pre>'); f.apply('A\nB\nC\nD', '新\n行'); f.apply('原', '\n首行');
  const diff = f.diff(); assert.equal(diff.changes[0].before.text, 'A\r\nB\nC\rD'); assert.equal(diff.changes[0].after.text, '新\n行');
  assert.equal(diff.changes[0].mixedLineEndings, true); assert.equal(diff.changes[1].after.text, '\n\n首行'); assert.equal(diff.changes[1].leadingLfCompensation, true);
  verify(f.source, f.engine.candidate, diff);
});

test('a Text-internal leading U+FEFF survives both source slices and clean/no-op candidates retain every original byte', () => {
  const f = setup('\ufeff<!doctype html><p>\ufeff原</p><p>A &#65;</p>'); f.apply('\ufeff原', '\ufeff新');
  let diff = f.diff(); assert.equal(diff.changes[0].before.text, '\ufeff原'); assert.equal(diff.changes[0].after.text, '\ufeff新'); verify(f.source, f.engine.candidate, diff);
  f.apply('\ufeff原', '\ufeff原'); f.apply('A A', 'A A'); diff = f.diff(); assert.equal(diff.changes.length, 0); assert.equal(diff.unchangedBytes, f.source.bytes.length); verify(f.source, f.engine.candidate, diff);
});

test('all 1000 permitted changed nodes appear in source order without truncating or hiding additional replacements', () => {
  const f = setup('<!doctype html>' + Array.from({ length: 1000 }, (_, i) => `<p>${i} 😀</p>`).join(''));
  const candidate = buildTextIntentCandidate(f.source, f.source.nodes.map(node => ({ nodeId: node.nodeId,
    expectedText: node.decodedText, newText: '改 ' + node.decodedText, rawSliceHash: node.rawSliceHash, contextFingerprint: node.contextFingerprint })), hash);
  const diff = buildSourceDiff(f.source, candidate, hash); assert.equal(diff.changes.length, 1000); verify(f.source, candidate, diff);
});

test('forged candidate bytes, identity, hash and source ranges are rejected before producing a Diff', () => {
  const f = setup('<!doctype html><p>A</p>'); const candidate = f.apply('A', 'B');
  for (const value of [{ ...candidate, bytes: Buffer.from('<!doctype html><p>C</p>') }, { ...candidate, resultHash: 'b'.repeat(64) },
    { ...candidate, identity: { ...candidate.identity, documentId: 'another' } },
    { ...candidate, patches: [{ ...candidate.patches[0], startByte: 1 }] },
    { ...candidate, patches: [] }]) assert.throws(() => buildSourceDiff(f.source, value, hash));
});

test('Diff schemas reject concealed ranges, malformed UTF-8 lengths and page-provided write authority; Save reviews bind revision and hash', () => {
  const f = setup('<!doctype html><p>A</p>'); f.apply('A', '😀'); const diff = f.diff(); const change = diff.changes[0];
  for (const value of [{ ...diff, path: 'x' }, { ...diff, changes: [] }, { ...diff, changes: [...diff.changes, ...diff.changes] },
    { ...diff, unchangedBytes: diff.unchangedBytes + 1 }, { ...diff, baseSize: 5 * 1024 * 1024 + 1 },
    ...[{ ...change.after, startByte: 0 }, { ...change.after, text: '\ud800' }, { ...change.after, text: 'A' }, { ...change.after, endByte: NaN }]
      .map(after => ({ ...diff, changes: [{ ...change, after }] }))]) assert.equal(isSourceDiff(value), false);
  const documentId = randomUUID(); const review = { draftRevision: 2, candidateHash: diff.candidateHash };
  assert.equal(isDiffReview(review), true); assert.equal(isWorkspaceCommand({ kind: 'source-diff', documentId, ...review }), true);
  assert.equal(isWorkspaceCommand({ kind: 'save', documentId, stateRevision: 1, review }), true);
  for (const request of [{ kind: 'source-diff', documentId, ...review, path: 'x' }, { kind: 'source-diff', documentId, ...review, offset: 0 },
    { kind: 'save', documentId, stateRevision: 1, review: { ...review, patches: [] } },
    { kind: 'save', documentId, stateRevision: 1, review: { ...review, draftRevision: 0 } },
    { kind: 'save', documentId, stateRevision: 1, review: null }]) assert.equal(isWorkspaceCommand(request), false);
});
