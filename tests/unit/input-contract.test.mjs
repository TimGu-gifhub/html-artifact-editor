import assert from 'node:assert/strict';
import test from 'node:test';
import { isInputBegin, isInputChange, isInputResolution, isInputVersion } from '../../src/contracts/input.ts';
const identity = { preview: { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', generation: 1, mode: 'proofread' },
  documentId: '00000000-0000-4000-8000-000000000002', baseHash: 'a'.repeat(64) };
const version = { editToken: '00000000-0000-4000-8000-000000000003', inputRevision: 1 };
test('input start and version messages have no file or byte-offset authority', () => {
  const begin = { selection: { identity, revision: 2, nodeId: 'n5' }, draftRevision: 1 };
  assert.ok(isInputBegin(begin)); assert.ok(isInputVersion(version));
  for (const bad of [{ ...begin, path: 'x' }, { ...begin, draftRevision: 0 },
    { ...begin, selection: { ...begin.selection, offset: 1 } }]) assert.equal(isInputBegin(bad), false);
  for (const bad of [{ ...version, text: 'x' }, { ...version, inputRevision: 0 }, { ...version, editToken: 'n5' }]) assert.equal(isInputVersion(bad), false);
});
test('pending input is bounded and keeps raw invalid text for correction instead of silently applying it', () => {
  for (const text of ['中文😀', '<script>&</script>', '\0', '\ud800', 'x'.repeat(128 * 1024)]) {
    assert.ok(isInputChange({ ...version, newText: text, composing: false }));
  }
  assert.equal(isInputChange({ ...version, newText: 'x'.repeat(128 * 1024 + 1), composing: false }), false);
  assert.equal(isInputChange({ ...version, newText: 'x', composing: 'false' }), false);
  assert.equal(isInputChange({ ...version, newText: 'x', composing: false, path: 'x' }), false);
});
test('switch resolution requires input version and an explicit action; no implicit save or retry command', () => {
  for (const decision of ['stay', 'discard', 'apply']) {
    assert.ok(isInputResolution({ ...version, decision, intentSequence: 1 }));
    assert.ok(isInputResolution({ ...version, decision, intentSequence: null }));
  }
  for (const decision of ['save', 'overwrite', 'retry', 'force']) assert.equal(isInputResolution({ ...version, decision, intentSequence: null }), false);
  assert.equal(isInputResolution({ ...version, decision: 'apply', intentSequence: -1 }), false);
});
