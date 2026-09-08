import assert from 'node:assert/strict';
import test from 'node:test';
import { isMappingIdentity, isMappingEvent, isMappingCheck, isMappingCheckResult, isMappingApply, isMappingApplyResult, sameMapping } from '../../src/contracts/mapping.ts';
import { isDraftApply } from '../../src/contracts/draft.ts';
const identity = { preview: { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', generation: 1, mode: 'proofread' },
  documentId: '00000000-0000-4000-8000-000000000002', baseHash: 'a'.repeat(64) };
test('mapping identity binds document, snapshot, preview session and generation', () => {
  assert.ok(isMappingIdentity(identity));
  assert.ok(sameMapping(identity, structuredClone(identity)));
  for (const bad of [null, {}, [], { ...identity, file: 'secret' }, { ...identity, baseHash: 'bad' },
    { ...identity, documentId: '../bad' }, { ...identity, preview: { ...identity.preview, mode: 'interactive' } }]) {
    assert.equal(isMappingIdentity(bad), false);
  }
  assert.equal(sameMapping(identity, { ...identity, baseHash: 'b'.repeat(64) }), false);
});
test('draft commands carry only selection, text and version; mutation replies carry no source authority', () => {
  const selection = { identity, revision: 2, nodeId: 'n5' };
  const input = { selection, draftRevision: 1, newText: '中文😀\n<script>&</script>' };
  assert.ok(isDraftApply(input));
  for (const bad of [{ ...input, path: 'x' }, { ...input, draftRevision: 0 }, { ...input, draftRevision: NaN },
    { ...input, newText: 'x'.repeat(128 * 1024 + 1) }, { ...input, selection: { ...selection, startByte: 1 } }]) assert.equal(isDraftApply(bad), false);
  const request = { ...selection, requestId: '00000000-0000-4000-8000-000000000003', expectedText: '原文', newText: input.newText };
  assert.ok(isMappingApply(request));
  for (const bad of [{ ...request, path: 'x' }, { ...request, newText: '\0' }, { ...request, newText: '\ud800' },
    { ...request, newText: '\udc00' }, { ...request, newText: '\r' }, { ...request, newText: 'x'.repeat(65537) }]) assert.equal(isMappingApply(bad), false);
  const result = { ...selection, requestId: request.requestId, outcome: 'applied', nextRevision: 3 };
  assert.ok(isMappingApplyResult(result));
  assert.equal(isMappingApplyResult({ ...result, newText: 'forged' }), false);
  assert.equal(isMappingApplyResult({ ...result, outcome: 'saved' }), false);
  assert.equal(isMappingApplyResult({ ...result, nextRevision: 0 }), false);
});
test('mapping events require exact small schemas, bounded ids and positive revisions', () => {
  for (const event of [
    { kind: 'ready', identity, revision: 1, editableCount: 10 },
    { kind: 'selection', identity, revision: 2, nodeId: 'n12' },
    { kind: 'selection', identity, revision: 3, nodeId: null },
    { kind: 'invalidated', identity, revision: 4, reason: 'DOM_MUTATED' },
  ]) {
    assert.ok(isMappingEvent(event));
    for (const bad of [{ ...event, offset: 0 }, { ...event, path: 'x' }, { ...event, text: 'x' },
      { ...event, revision: NaN }, { ...event, revision: 0 }, { ...event, revision: 0.5 }]) assert.equal(isMappingEvent(bad), false);
  }
  assert.equal(isMappingEvent({ kind: 'selection', identity, revision: 2, nodeId: 'n'.repeat(10000) }), false);
});
test('selection confirmation requires a request identity and grants no arbitrary operation', () => {
  const check = { identity, revision: 2, nodeId: 'n5', requestId: '00000000-0000-4000-8000-000000000003' };
  assert.ok(isMappingCheck(check));
  assert.ok(isMappingCheckResult({ ...check, valid: true }));
  for (const bad of [{ ...check, op: 'save' }, { ...check, offset: 8 }, { ...check, requestId: '' }]) assert.equal(isMappingCheck(bad), false);
  assert.equal(isMappingCheckResult({ ...check, valid: 1 }), false);
  assert.equal(isMappingCheckResult({ ...check, valid: true, path: 'x' }), false);
});
