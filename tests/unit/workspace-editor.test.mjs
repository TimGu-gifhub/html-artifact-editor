import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isWorkspaceCommand, isWorkspaceRequest } from '../../src/contracts/workspace-editor.ts';
import { isBackupDecision } from '../../src/contracts/backup.ts';

test('backup commands bind a current document and an exact private-record reference without file or confirmation authority', () => {
  const documentId = randomUUID(); const reference = { transactionId: randomUUID(), intentHash: 'a'.repeat(64) };
  const request = { kind: 'backup-restore', stateRevision: 1, documentId, reference };
  assert.ok(isWorkspaceCommand(request)); assert.ok(isWorkspaceCommand({ kind: 'backup-list', documentId }));
  for (const value of [ { kind: 'backup-list' }, { kind: 'backup-list', documentId, path: 'private' },
    { ...request, documentId: null }, { ...request, stateRevision: 0 }, { ...request, force: true },
    { ...request, decision: 'restore' }, { ...request, bytes: [] }, { ...request, path: 'other.html' },
    ...[null, {}, { transactionId: '../other', intentHash: reference.intentHash }, { ...reference, intentHash: 'invalid' },
      { ...reference, path: 'backup.bin' }, { ...reference, bytes: [] }].map(reference => ({ ...request, reference })) ]) {
    assert.equal(isWorkspaceCommand(value), false, JSON.stringify(value));
  }
  const decision = { reviewId: randomUUID(), decision: 'restore' };
  assert.ok(isBackupDecision(decision)); assert.ok(isBackupDecision({ ...decision, decision: 'cancel' }));
  for (const value of [null, [], { ...decision, reviewId: 'old' }, { ...decision, decision: 'discard' }, { ...decision, force: true }]) {
    assert.equal(isBackupDecision(value), false);
  }
});

test('workspace requests require a specific document identity for every edit and exclude file authority', () => {
  const documentId = randomUUID(); const sessionId = randomUUID();
  const valid = [ { kind: 'read' }, { kind: 'open', stateRevision: 1 }, { kind: 'open-directory', stateRevision: 1 },
    { kind: 'switch-entry', stateRevision: 1, documentId }, { kind: 'save', stateRevision: 1, documentId },
    { kind: 'retry-persistence', draftRevision: 2, documentId },
    { kind: 'edit', documentId, value: { kind: 'save-copy', stateRevision: 1 } },
    { kind: 'edit', documentId, value: { kind: 'change', value: { editToken: randomUUID(), inputRevision: 2, newText: '中文😀', composing: true } } } ];
  for (const command of valid) {
    assert.ok(isWorkspaceCommand(command)); assert.ok(isWorkspaceRequest({ sessionId, sequence: 1, command }));
  }
  const bad = [null, [], {}, { kind: 'dispose' }, { kind: 'close', force: true },
    { kind: 'save', stateRevision: 1 }, { kind: 'save', stateRevision: 0, documentId },
    { kind: 'save', stateRevision: 1, documentId, path: 'outside.html' },
    { kind: 'save', stateRevision: 1, documentId, candidate: 'injected bytes' },
    { kind: 'retry-persistence', draftRevision: 2 }, { kind: 'retry-persistence', draftRevision: 0, documentId },
    { kind: 'retry-persistence', draftRevision: 2, documentId, path: 'outside' },
    { kind: 'retry-persistence', draftRevision: 2, documentId, candidate: 'untrusted' },
    { kind: 'open-directory', stateRevision: 1, root: 'outside' },
    { kind: 'switch-entry', stateRevision: 1, documentId, entry: 'outside.html' },
    { kind: 'open', stateRevision: 1, path: 'report.html' }, { kind: 'open', stateRevision: NaN },
    { kind: 'edit', value: { kind: 'save-copy', stateRevision: 1 } },
    { kind: 'edit', documentId: 'unknown', value: { kind: 'save-copy', stateRevision: 1 } },
    { kind: 'edit', documentId, value: { kind: 'read' } },
    { kind: 'edit', documentId, value: { kind: 'save-copy', stateRevision: 1, overwrite: true } }];
  for (const command of bad) assert.equal(isWorkspaceCommand(command), false);
  for (const envelope of [ { sessionId, sequence: 0, command: valid[0] },
    { sessionId, sequence: 1.5, command: valid[0] }, { sessionId, sequence: 1, command: valid[0], path: 'x' },
    { sessionId: 'unknown', sequence: 1, command: valid[0] }]) assert.equal(isWorkspaceRequest(envelope), false);
});
