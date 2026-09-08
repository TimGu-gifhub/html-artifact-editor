import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isWorkspaceCommand, isWorkspaceRequest } from '../../src/contracts/workspace-editor.ts';

test('workspace requests require a specific document identity for every edit and exclude file authority', () => {
  const documentId = randomUUID(); const sessionId = randomUUID();
  const valid = [ { kind: 'read' }, { kind: 'open', stateRevision: 1 }, { kind: 'open-directory', stateRevision: 1 },
    { kind: 'switch-entry', stateRevision: 1, documentId },
    { kind: 'edit', documentId, value: { kind: 'save-copy', stateRevision: 1 } },
    { kind: 'edit', documentId, value: { kind: 'change', value: { editToken: randomUUID(), inputRevision: 2, newText: '中文😀', composing: true } } } ];
  for (const command of valid) {
    assert.ok(isWorkspaceCommand(command)); assert.ok(isWorkspaceRequest({ sessionId, sequence: 1, command }));
  }
  const bad = [null, [], {}, { kind: 'dispose' }, { kind: 'close', force: true },
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
