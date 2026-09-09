import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createHistorySource } from '../../src/core/history/source.ts';
import { isMappingInstall } from '../../src/contracts/mapping.ts';
import { isMappingHistory, isMappingHistoryResult } from '../../src/contracts/mapping-history.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { preview: { version: 1, sessionId: randomUUID(), generation: 1, mode: 'proofread' },
  documentId: randomUUID(), baseHash: 'a'.repeat(64) };
const sourceId = { projectId: 'history', documentId: 'fixture', generation: 1 };

test('empty Text installation requires an explicit bounded ordered list of fresh empty identities, not inferred offsets or arbitrary nodes', () => {
  const bytes = Buffer.from('<!doctype html><p>A</p><p>B</p>'); const original = createSourceIndex(bytes, sourceId, hash);
  const source = createHistorySource(Buffer.from('<!doctype html><p></p><p></p>'), sourceId,
    { originBytes: bytes, values: original.nodes.map(node => ({ nodeId: node.nodeId, text: '' })) }, hash).source;
  const emptyTextIndices = source.nodes.map(node => node.treeIndex);
  const message = { identity, tree: source.tree, emptyTextIndices };
  assert.equal(isMappingInstall(message), true); assert.equal(isMappingInstall({ identity, tree: original.tree }), true);
  for (const value of [{ ...message, offset: 0 }, { ...message, lineage: source.lineage }, { ...message, tree: [] },
    { ...message, emptyTextIndices: undefined }, { ...message, emptyTextIndices: [-1] }, { ...message, emptyTextIndices: [0] },
    { ...message, emptyTextIndices: [1.5] }, { ...message, emptyTextIndices: [source.tree.length] },
    { ...message, emptyTextIndices: [emptyTextIndices[0], emptyTextIndices[0]] }, { ...message, emptyTextIndices: [...emptyTextIndices].reverse() },
    { ...message, emptyTextIndices: Array(1001).fill(emptyTextIndices[0]) }, { ...message, tree: original.tree },
    ...[{ value: 'A' }, { editable: false }, { readOnlyReason: 'PARSE_ERROR' }, { nodeId: 'n6' }, { parent: 0 }, { parent: 999999 }]
      .map(change => ({ ...message, tree: source.tree.map((node, i) => i === emptyTextIndices[0] ? { ...node, ...change } : node) })),
  ]) assert.equal(isMappingInstall(value), false);
});

test('history mutation carries one canonical changed Text and a fresh mapping revision, without selection, paths, force or batch authority', () => {
  const request = { identity, requestId: randomUUID(), revision: 12, nodeId: 'n100006', expectedText: '', newText: '<&> 😀\n文字' };
  assert.equal(isMappingHistory(request), true);
  for (const value of [{ ...request, revision: 0 }, { ...request, revision: Number.MAX_SAFE_INTEGER },
    { ...request, revision: NaN }, { ...request, selection: null }, { ...request, offset: 3 }, { ...request, force: true },
    { ...request, newText: '' }, { ...request, nodeId: 'n1000000' }, { ...request, identity: { ...identity, baseHash: 'bad' } },
    ...['\0', '\r', '\ud800', '\udfff', 'x'.repeat(65537)].map(newText => ({ ...request, newText })),
  ]) assert.equal(isMappingHistory(value), false);
  const result = { identity, requestId: request.requestId, revision: 12, nodeId: request.nodeId, nextRevision: 13, outcome: 'applied' };
  assert.equal(isMappingHistoryResult(result), true);
  for (const value of [{ ...result, outcome: 'saved' }, { ...result, nextRevision: 0 }, { ...result, originBytes: [] }]) {
    assert.equal(isMappingHistoryResult(value), false);
  }
});
