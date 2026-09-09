import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isMappingRestore, isMappingRestoreResult } from '../../src/contracts/mapping-restore.ts';
import { isWorkspaceCommand } from '../../src/contracts/workspace-editor.ts';
import { draftOwnership } from '../../src/main/storage/draft-ownership.ts';

test('fresh restore batches are bounded unique Text changes and carry no paths, offsets or stale selection authority', () => {
  const identity = { preview: { version: 1, sessionId: randomUUID(), generation: 1, mode: 'proofread' }, documentId: randomUUID(), baseHash: 'a'.repeat(64) };
  const request = { identity, requestId: randomUUID(), revision: 1, changes: [{ nodeId: 'n1', expectedText: 'A & 😀', newText: '<&> 🧪\nnext' }] };
  assert.equal(isMappingRestore(request), true);
  for (const value of [ { ...request, revision: 2 }, { ...request, offset: 0 }, { ...request, changes: [] },
    { ...request, changes: Array(1001).fill(request.changes[0]) }, { ...request, changes: [...request.changes, ...request.changes] },
    ...['\0', '\ud800', '\udfff', '\r', 'x'.repeat(65537)].map(newText => ({ ...request, changes: [{ ...request.changes[0], newText }] })),
    { ...request, changes: [{ ...request.changes[0], expectedText: 'x'.repeat(5 * 1024 * 1024 + 1) }] },
    { ...request, changes: [{ ...request.changes[0], nodeId: 'n1000000' }] },
    { ...request, changes: [{ ...request.changes[0], startByte: 0 }] } ]) assert.equal(isMappingRestore(value), false);
  const response = { identity, requestId: request.requestId, revision: 1, nextRevision: 2, outcome: 'applied' };
  assert.equal(isMappingRestoreResult(response), true);
  for (const value of [{ ...response, revision: 2 }, { ...response, nextRevision: NaN }, { ...response, outcome: 'saved' }, { ...response, path: 'x' }]) assert.equal(isMappingRestoreResult(value), false);
});

test('trusted recovery IPC authorizes a chooser mode and session, never a private record path or caller-supplied write range', () => {
  assert.equal(isWorkspaceCommand({ kind: 'recovery-list' }), true);
  const request = { kind: 'restore', recoverySessionId: randomUUID(), stateRevision: 1, sourceMode: 'file' };
  assert.equal(isWorkspaceCommand(request), true); assert.equal(isWorkspaceCommand({ ...request, sourceMode: 'directory' }), true);
  for (const value of [{ kind: 'recovery-list', path: 'x' }, { ...request, sourceMode: 'network' }, { ...request, stateRevision: 0 },
    { ...request, recoverySessionId: 'latest' }, { ...request, path: 'x' }, { ...request, checkpointId: randomUUID() },
    { ...request, offset: 2 }, { ...request, force: true }]) assert.equal(isWorkspaceCommand(value), false);
});

test('independent Main store objects cannot own the same persistent sequence until its document closes', () => {
  const first = draftOwnership(randomUUID()); const namespace = randomUUID();
  const a = draftOwnership(namespace); const b = draftOwnership(namespace); const id = randomUUID();
  const release = a.claim(id); assert.equal(b.isActive(id), true); assert.throws(() => b.claim(id), /DRAFT_SESSION_ACTIVE/);
  const otherNamespace = first.claim(id); otherNamespace(); assert.throws(() => a.claim(''), /DRAFT_CHECKPOINT_INVALID/);
  const other = a.claim(randomUUID()); release(); release(); assert.equal(b.isActive(id), false);
  const next = b.claim(id); assert.equal(a.isActive(id), true); next(); other();
});
