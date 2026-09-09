import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../../src/main/workspace/controller.ts';

test('concurrent recovery listings share one scan and return only bounded display metadata, never stored source or target authority', async () => {
  const id = randomUUID(); let scans = 0; let complete;
  const workspace = createWorkspace('unused', {}, async () => { throw Error('unexpected prepare'); }, undefined, undefined, {
    catalog: () => { scans++; return new Promise(done => { complete = done; }); }, isSessionActive: value => value === id,
  });
  const one = workspace.listRecovery(); const two = workspace.listRecovery(); assert.equal(scans, 1);
  complete({ groups: [{ sessionId: id, name: 'report.html', draftRevision: 7, status: 'dirty', targetKey: 'private', checkpointId: randomUUID(), resultHash: 'a'.repeat(64) }],
    locked: false, reviewRequired: true, unclassified: ['private-id'] });
  const value = await one; assert.deepEqual(await two, value);
  assert.deepEqual(value, { entries: [{ sessionId: id, name: 'report.html', draftRevision: 7, status: 'dirty', active: true }], locked: false, reviewRequired: true });
  let chooses = 0; await assert.rejects(workspace.restore(1, id, async () => { chooses++; }), /DRAFT_SESSION_ACTIVE/); assert.equal(chooses, 0);
  await workspace.dispose(); await assert.rejects(workspace.listRecovery(), /WORKSPACE_BUSY/);
});

test('recovery into an empty workspace revalidates after native activation and closes the candidate when that proof fails', async () => {
  const id = randomUUID(); let validations = 0; let closed = 0; let mounted = null;
  const next = { id: randomUUID(), onState: () => () => {}, verifyRecovery: async () => { if (++validations === 2) throw Error('DRAFT_CHECKPOINT_CHANGED'); }, close: async () => { closed++; } };
  const workspace = createWorkspace('unused', {}, async (...args) => { assert.equal(args[5], id); return next; }, value => {
    const previous = mounted; mounted = value; return () => { mounted = previous; };
  }, undefined, { isSessionActive: () => false });
  await assert.rejects(workspace.restore(1, id, async () => 'authorized file'), /DRAFT_CHECKPOINT_CHANGED/);
  assert.equal(mounted, null); assert.equal(workspace.current, null); assert.equal(closed, 1); assert.equal(workspace.snapshot().phase, 'idle');
  await workspace.dispose();
});
