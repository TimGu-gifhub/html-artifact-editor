import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { bindWorkspaceWindow } from '../../src/main/workspace/window.ts';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(options = {}, save = null) {
  const window = new EventEmitter(); const errors = []; const calls = { review: 0, destroyed: 0, disposal: 0 };
  let destroyed = false; let answer = async () => ({ status: 'closed' });
  window.isDestroyed = () => destroyed;
  window.destroy = () => { destroyed = true; calls.destroyed++; window.emit('closed'); };
  window.close = () => { let prevented = false; window.emit('close', { preventDefault: () => { prevented = true; } }); assert.ok(prevented); };
  const workspace = { snapshot: () => ({ stateRevision: 1 }), waitForSave: () => save,
    requestClose: async () => { calls.review++; return answer(); }, dispose: async () => { calls.disposal++; } };
  const guard = bindWorkspaceWindow(window, workspace, code => errors.push(code), options);
  return { window, errors, calls, guard, answer: value => { answer = value; } };
}
test('native and Main close requests join one decision; cancellation preserves the native window', async () => {
  const response = deferred(); const started = deferred(); const f = fixture();
  f.answer(() => { started.resolve(); return response.promise; });
  f.window.close(); const first = f.guard.requestClose(); assert.equal(first, f.guard.requestClose());
  f.window.close(); await started.promise; assert.equal(f.calls.review, 1); assert.equal(f.calls.destroyed, 0);
  response.resolve({ status: 'cancelled' }); assert.equal(await first, 'cancelled'); assert.equal(f.guard.closing, false);
  assert.equal(f.calls.disposal, 0); assert.equal(f.calls.destroyed, 0); f.guard.detach();
});
test('approved close keeps the native window until teardown completes; a failed barrier cannot destroy it', async () => {
  for (const failed of [false, true]) {
    const hold = deferred(); const started = deferred();
    const f = fixture({ beforeClose: () => { started.resolve(); return hold.promise; } });
    const closing = f.guard.requestClose(); await started.promise;
    assert.equal(f.calls.destroyed, 0); f.window.close(); assert.equal(f.calls.review, 1);
    if (failed) hold.reject(new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED')); else hold.resolve();
    assert.equal(await closing, failed ? 'blocked' : 'closed'); assert.equal(f.calls.destroyed, failed ? 0 : 1);
    assert.deepEqual(f.errors, failed ? ['EDITOR_RUNTIME_CLEANUP_REQUIRED'] : []); f.guard.detach();
    if (failed) { f.window.close(); assert.equal(await f.guard.requestClose(), 'blocked'); assert.equal(f.calls.destroyed, 0); assert.equal(f.calls.review, 1); }
  }
});
test('close waits for the exact existing Save and accepts only a verified result without cleanup warnings', async () => {
  for (const report of [null, ...['saved', 'backup-restored', 'unchanged', 'cancelled', 'failed', 'unknown', 'rebase-required']
    .map(status => ({ status, requiresReview: false, cleanupPending: false })),
    { status: 'saved', requiresReview: true, cleanupPending: false }, { status: 'saved', requiresReview: false, cleanupPending: true }]) {
    const save = deferred(); const f = fixture({ waitForSave: true }, save.promise); const closing = f.guard.requestClose();
    await Promise.resolve(); assert.equal(f.calls.review, 0); assert.equal(f.calls.destroyed, 0);
    save.resolve(report); const accepted = report && ['saved', 'backup-restored', 'unchanged'].includes(report.status) && !report.requiresReview && !report.cleanupPending;
    assert.equal(await closing, accepted ? 'closed' : 'blocked'); assert.equal(f.calls.review, accepted ? 1 : 0);
    assert.equal(f.calls.destroyed, accepted ? 1 : 0); f.guard.detach();
  }
});
