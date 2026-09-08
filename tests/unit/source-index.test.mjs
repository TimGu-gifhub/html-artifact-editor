import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { MAX_SOURCE_BYTES, MAX_TREE_DEPTH, MAX_TREE_NODES } from '../../src/contracts/source-tree.ts';
import { mappingCases } from '../fixtures/mapping/cases.ts';

const identity = { projectId: 'p1', documentId: 'd1', generation: 1 };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const index = (html) => createSourceIndex(Buffer.from(html), identity, hash);
const sample = (id) => index(mappingCases.find((item) => item.id === id).html);

test('ten identical strings and duplicate ids keep ten distinct, exact byte ranges', () => {
  const source = sample('repeated');
  const nodes = source.nodes.filter((node) => node.decodedText === '相同文字 & 😀');
  assert.equal(nodes.length, 10);
  assert.equal(new Set(nodes.map((node) => node.nodeId)).size, 10);
  assert.equal(new Set(nodes.map((node) => node.startByte)).size, 10);
  for (const [i, node] of nodes.entries()) {
    assert.equal(node.editable, true);
    const bytes = source.bytes.slice(node.startByte, node.endByte);
    assert.equal(Buffer.from(bytes).toString(), '相同文字 &amp; 😀');
    assert.equal(node.rawSliceHash, hash(bytes));
    assert.match(Buffer.from(source.bytes.slice(0, node.startByte)).toString(), new RegExp(`data-order="${i}">$`));
  }
});

test('nested and comment-separated text, implicit tbody, and pre newline have unique source ranges', () => {
  const source = sample('nested');
  assert.deepEqual(source.nodes.map((node) => node.decodedText), ['前', '内', '深', '尾', '后', '邻', '末', '单元']);
  assert.ok(source.nodes.every((node) => node.editable));
  const body = source.tree.findIndex((node) => node.kind === 'element' && node.name === 'tbody');
  assert.ok(body > 0);
  const cell = source.nodes.at(-1);
  assert.equal(source.tree[source.tree[cell.treeIndex].parent].name, 'td');
  assert.equal(sample('pre-leading-newline').nodes[0].decodedText, '开头 LF 被解析器消耗');
  assert.ok(sample('pre-leading-newline').nodes[0].editable);
});

test('raw slices retain BOM/entity spelling/Unicode/mixed endings while decoded text follows HTML', () => {
  const html = mappingCases.find((item) => item.id === 'entities').html;
  const input = Buffer.from(html);
  const before = Buffer.from(input);
  const source = createSourceIndex(input, identity, hash);
  assert.equal(source.hasBom, true);
  assert.equal(source.baseHash, hash(before));
  assert.deepEqual(Buffer.from(source.bytes), before);
  const node = source.nodes.find((n) => n.parentTag === 'p');
  assert.equal(node.decodedText, '中文😀e\u0301 & \u00a0 😀 <tag>\n第二行\n第三行\n末');
  assert.ok(node.editable);
  assert.equal(Buffer.from(source.bytes.slice(node.startByte, node.endByte)).toString(), html.slice(html.indexOf('<p>') + 3, html.indexOf('</p>')));
  input.fill(0);
  assert.deepEqual(Buffer.from(source.bytes), before); // Caller cannot mutate the captured source.
  source.bytes.fill(0);
  assert.deepEqual(Buffer.from(source.bytes), before); // Returned views cannot mutate it either.
  assert.ok(Object.isFrozen(source.tree));
  assert.ok(Object.isFrozen(source.nodes[0]));
});

test('noscript uses scripting-enabled parsing even when CSP prevents all script execution', () => {
  const source = sample('noscript');
  assert.equal(source.nodes[0].decodedText, '<p>脚本关闭也不是可改段落</p>');
  assert.equal(source.nodes[0].readOnlyReason, 'UNSUPPORTED_CONTEXT');
  assert.ok(source.nodes[1].editable);
});

test('raw text, form/current values, template, foreign content and contenteditable are read-only', () => {
  const source = sample('contexts');
  assert.deepEqual(source.nodes.filter((node) => node.editable).map((node) => node.decodedText), ['普通正文']);
  for (const value of ['SVG', '外来 HTML', '数学']) {
    assert.equal(source.nodes.find((node) => node.decodedText === value).readOnlyReason, 'FOREIGN_CONTENT');
  }
  assert.ok(source.tree.some((node) => node.kind === 'fragment'));
});

test('fostered merged text is rejected and adoption-agency clones make the entire document read-only', () => {
  const foster = sample('foster');
  assert.ok(foster.nodes.every((node) => node.readOnlyReason === 'OVERLAPPING_SOURCE'));
  const noncontiguous = index('<!doctype html><table>错位前<tr></tr>错位后</table>');
  assert.equal(noncontiguous.nodes[0].readOnlyReason, 'NONCONTIGUOUS_TEXT');
  assert.ok(sample('adoption').nodes.every((node) => node.readOnlyReason === 'REPAIRED_TREE'));
});

test('parse errors fail closed, except a missing doctype with an exact quirks-mode tree', () => {
  assert.ok(sample('parse-error').nodes.every((node) => node.readOnlyReason === 'PARSE_ERROR'));
  assert.deepEqual(sample('parse-error').parseErrors, ['duplicate-attribute']);
  assert.equal(sample('no-doctype').tree[0].mode, 'BackCompat');
  assert.ok(sample('no-doctype').nodes[0].editable);
  assert.ok(index('<!doctype html><p>NUL\0</p>').nodes.every((node) => !node.editable));
});

test('source, tree count/depth and identity limits reject before an editable index is returned', () => {
  assert.throws(() => createSourceIndex(new Uint8Array(MAX_SOURCE_BYTES + 1), identity, hash), /SOURCE_SIZE_LIMIT/);
  assert.throws(() => index('<!doctype html>' + '<div>'.repeat(MAX_TREE_DEPTH + 1)), /SOURCE_TREE_LIMIT/);
  assert.throws(() => index('<!doctype html>' + '<br>'.repeat(MAX_TREE_NODES)), /SOURCE_TREE_LIMIT/);
  for (const bad of [{ ...identity, generation: 0 }, { ...identity, documentId: '../bad' }]) {
    assert.throws(() => createSourceIndex(new Uint8Array(), bad, hash), /INVALID_SOURCE_IDENTITY/);
  }
});

test('10,000-line source keeps independently verified middle and last Unicode offsets', () => {
  const html = '<!doctype html>\r\n' + Array.from({ length: 10_000 }, (_, i) => `<p>行${i} 中文😀 &amp;</p>\r\n`).join('');
  const source = index(html);
  for (const line of [0, 4999, 9999]) {
    const node = source.nodes.find((item) => item.decodedText === `行${line} 中文😀 &`);
    const before = html.slice(0, html.indexOf(`行${line} 中文`));
    assert.equal(node.startByte, Buffer.byteLength(before));
    assert.equal(Buffer.from(source.bytes.slice(node.startByte, node.endByte)).toString(), `行${line} 中文😀 &amp;`);
    assert.ok(node.editable);
  }
});
