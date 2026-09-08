import assert from 'node:assert/strict';
import test from 'node:test';
import { isMappingEditRequest, isMappingEditResult, isMappingEditIntent } from '../../src/contracts/edit-guard.ts';
const identity = { preview: { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', generation: 1, mode: 'proofread' },
  documentId: '00000000-0000-4000-8000-000000000002', baseHash: 'a'.repeat(64) };
const base = { identity, revision: 2, nodeId: 'n12', requestId: '00000000-0000-4000-8000-000000000003' };
test('edit ownership requests bind a selection; resolution requires exact token and optional current intent sequence', () => {
  const begin = { ...base, kind: 'begin' };
  const finish = { ...base, kind: 'finish', editToken: base.requestId, intentSequence: 1, decision: 'accept' };
  assert.ok(isMappingEditRequest(begin)); assert.ok(isMappingEditRequest(finish));
  assert.ok(isMappingEditRequest({ ...finish, decision: 'release', intentSequence: null }));
  assert.ok(isMappingEditRequest({ ...finish, decision: 'stay' }));
  for (const bad of [{ ...begin, path: 'x' }, { ...begin, newText: 'x' }, { ...begin, revision: 0 },
    { ...finish, decision: 'save' }, { ...finish, editToken: '' }, { ...finish, intentSequence: 0 },
    { ...finish, intentSequence: 1.5 }, { ...finish, intentSequence: NaN }, { ...finish, offset: 8 }]) assert.equal(isMappingEditRequest(bad), false);
});
test('ownership replies require complete bounded state and cannot carry file or DOM authority', () => {
  const reply = { ...base, kind: 'begin', accepted: true, editToken: base.requestId, nextRevision: 2, nextNodeId: 'n12' };
  assert.ok(isMappingEditResult(reply));
  assert.ok(isMappingEditResult({ ...reply, kind: 'finish', editToken: null, nextRevision: 3, nextNodeId: null }));
  for (const bad of [{ ...reply, accepted: 1 }, { ...reply, nodePath: ['p'] }, { ...reply, nextRevision: 0 },
    { ...reply, nextNodeId: 'n9999999' }, { ...reply, kind: 'overwrite' }]) assert.equal(isMappingEditResult(bad), false);
});
test('native switch intents identify only an edit owner, sequence and optional source node', () => {
  const intent = { identity, editToken: base.requestId, sequence: 1, nodeId: 'n14' };
  assert.ok(isMappingEditIntent(intent)); assert.ok(isMappingEditIntent({ ...intent, nodeId: null }));
  for (const bad of [{ ...intent, html: 'x' }, { ...intent, expectedText: 'x' }, { ...intent, sequence: -1 },
    { ...intent, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...intent, nodeId: '#title' }, { ...intent, editToken: '../owner' }]) assert.equal(isMappingEditIntent(bad), false);
});
