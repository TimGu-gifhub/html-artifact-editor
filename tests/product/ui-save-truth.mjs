import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySaveResult } from '../../src/ui/save-result.ts';

const documentId = '11111111-1111-4111-8111-111111111111';
const newDocumentId = '22222222-2222-4222-8222-222222222222';
const report = (status, extra = {}) => ({ documentId, status, code: 'SAVE_FAILED', cleanupPending: false, requiresReview: false, ...extra });
const reply = (lastSave, extra = {}) => ({ ok: false, code: 'EDITOR_DISCONNECTED', documentId, copy: null, outcome: null,
  state: { current: { id: documentId }, lastSave, cleanupPending: false }, ...extra });

test('a disconnected Save cannot reuse an earlier same-document failure or cancellation as proof of no commit', () => {
  for (const status of ['failed', 'cancelled', 'unchanged']) {
    assert.equal(classifySaveResult(reply(report(status)), documentId).kind, 'unknown', status);
  }
});
test('a Save acknowledgement without an exact result or report is unconfirmed', () => {
  assert.equal(classifySaveResult(reply(null, { ok: true, code: null }), documentId).kind, 'unknown');
});
test('a verified Save preserves cleanup warning when its report belongs to the fresh mapping document', () => {
  const result = reply(report('saved', { documentId: newDocumentId, code: 'SAVE_CLEANUP_PENDING', cleanupPending: true, requiresReview: true }), {
    ok: true, code: null, outcome: 'saved',
  });
  result.state.current.id = newDocumentId;
  const verdict = classifySaveResult(result, documentId);
  assert.equal(verdict.kind, 'saved'); assert.equal(verdict.cleanupPending, true);
});
test('a result targeting a different Save cannot settle this confirmation', () => {
  const result = reply(null, { ok: true, code: null, outcome: 'saved', documentId: newDocumentId });
  assert.equal(classifySaveResult(result, documentId).kind, 'unknown');
});

test('a newer current document failure is not a report for this earlier request', () => {
  const result = reply(report('failed', { documentId: newDocumentId }), { code: 'WORKSPACE_COMMAND_FAILED' });
  result.state.current.id = newDocumentId;
  assert.equal(classifySaveResult(result, documentId).kind, 'unknown');
});
