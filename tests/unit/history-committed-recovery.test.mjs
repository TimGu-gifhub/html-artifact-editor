import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const win = { skip: process.platform !== 'win32', timeout: 20000 };
const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"></head><body><h1>A &#38; 😀</h1><p>原样</p><!-- literal --></body></html>');
const identity = () => ({ projectId: randomUUID(), documentId: randomUUID(), generation: 1 });
const edit = (history, text) => {
  const node = history.source.nodes.find(node => node.parentTag === 'h1');
  history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
    nodeId: node.nodeId, expectedText: history.textFor(node.nodeId), newText: text }));
};
async function fixture(saveStep = async () => {}) {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results/history-committed-')); const privateRoot = join(root, 'private'); await mkdir(privateRoot);
  const entry = join(root, 'report.html'); await writeFile(entry, original);
  const source = await openSaveSource(entry, original); const history = createTextHistory(original, identity(), digest);
  edit(history, ''); edit(history, 'B <&> 🧪'); history.commit(history.prepareMove('undo'));
  const sessionId = randomUUID(); const control = { step: async () => {} };
  const saves = await createSavePreparationStore(privateRoot, saveStep, await createWindowsReplacer(resolve('out/native/ReplaceHelper.exe')));
  const store = await createDraftCheckpointStore(privateRoot, step => control.step(step), saves);
  const point = await store.write(source, history.source, history.candidate, sessionId, history.revision, history.capture());
  assert.equal(point.status, 'persisted');
  const prepared = await saves.prepare(source, history.candidate); assert.equal(prepared.status, 'prepared');
  const result = await prepared.commit();
  const current = await openSaveSource(entry, history.candidate.bytes);
  return { root, privateRoot, entry, source, history, sessionId, control, saves, store, point, prepared, result, current };
}

test('a verified committed v2 point rebuilds clean history on fresh bytes without replay or disk writes, preserving Undo and Redo', win, async () => {
  const f = await fixture(); assert.equal(f.result.status, 'committed');
  const files = await readdir(f.privateRoot); const baseline = await readFile(f.entry); const continuation = randomUUID();
  const plan = await f.store.prepareRecovery(f.sessionId, f.current, continuation);
  assert.equal(plan.kind, 'saved'); assert.equal(plan.sessionId, continuation);
  const history = createTextHistory(baseline, identity(), digest, plan.history);
  const recovery = await plan.resolve(history.source);
  assert.equal(recovery.checkpointId, null); assert.equal(recovery.draftRevision, f.history.revision + 1);
  assert.equal(recovery.candidate.patches.length, 0); assert.deepEqual(Buffer.from(recovery.candidate.bytes), baseline);
  assert.equal(history.summary().undoCount, 1); assert.equal(history.summary().redoCount, 1);
  history.commit(history.prepareMove('undo'));
  assert.equal(history.candidate.patches[0].startByte, history.candidate.patches[0].endByte);
  assert.deepEqual(Buffer.from(history.candidate.bytes), Buffer.from(original.toString().replace('&#38;', '&amp;')));
  history.commit(history.prepareMove('redo')); assert.deepEqual(Buffer.from(history.candidate.bytes), baseline);
  history.commit(history.prepareMove('redo')); assert.ok(Buffer.from(history.candidate.bytes).includes(Buffer.from('B &lt;&amp;&gt; 🧪')));
  await recovery.verify(); assert.deepEqual(await readdir(f.privateRoot), files); assert.deepEqual(await readFile(f.entry), baseline);
  await assert.rejects(f.store.restoreCandidate(f.point.checkpointId, f.current, history.source), /DRAFT_ALREADY_SAVED/);
});

test('sealing a continuation prevents another recovery of the old saved point, while the new clean point restores without duplication', win, async () => {
  const f = await fixture(); const id = randomUUID(); const plan = await f.store.prepareRecovery(f.sessionId, f.current, id);
  const h = createTextHistory(f.current.bytes, identity(), digest, plan.history); const recovery = await plan.resolve(h.source);
  const point = await f.store.write(f.current, h.source, h.candidate, id, h.revision, h.capture()); assert.equal(point.status, 'persisted');
  await recovery.verify();
  await assert.rejects(f.store.prepareRecovery(f.sessionId, f.current, randomUUID()), /DRAFT_SAVED_HISTORY_SUPERSEDED/);
  const resumed = await f.store.prepareRecovery(id, f.current, randomUUID()); assert.equal(resumed.kind, 'draft');
  const fresh = createTextHistory(f.current.bytes, identity(), digest, resumed.history);
  const again = await resumed.resolve(fresh.source); assert.equal(again.checkpointId, point.checkpointId);
  assert.equal(again.draftRevision, h.revision); assert.deepEqual(again.candidate.bytes, h.candidate.bytes);
  h.commit(h.prepareMove('undo')); assert.equal((await f.store.write(f.current, h.source, h.candidate, id, h.revision, h.capture())).status, 'persisted');
  await assert.rejects(recovery.verify(), /DRAFT_CHECKPOINT_CHANGED/);
  assert.deepEqual(await readFile(f.entry), Buffer.from(f.current.bytes));
});

test('incomplete, retired or damaged continuation evidence cannot be bypassed by recovering its older saved ancestor', win, async () => {
  for (const mode of ['incomplete', 'retired', 'damaged']) {
    const f = await fixture(); const id = randomUUID(); const plan = await f.store.prepareRecovery(f.sessionId, f.current, id);
    const h = createTextHistory(f.current.bytes, identity(), digest, plan.history);
    if (mode === 'incomplete') f.control.step = async step => { if (step === 'baseline-written') throw Error('test interrupted continuation'); };
    const point = await f.store.write(f.current, h.source, h.candidate, id, h.revision, h.capture());
    assert.equal(point.status, mode === 'incomplete' ? 'failed' : 'persisted');
    if (mode === 'retired') assert.equal((await f.store.retire(f.current, id, h.revision, 'discarded')).status, 'retired');
    if (mode === 'damaged') await writeFile(join(f.privateRoot, point.checkpointId, 'record.json'), '{broken');
    await assert.rejects(f.store.prepareRecovery(f.sessionId, f.current, randomUUID()), /DRAFT_(SAVED_HISTORY_SUPERSEDED|STORAGE_REVIEW_REQUIRED)/);
    assert.deepEqual(await readFile(f.entry), Buffer.from(f.current.bytes));
  }
});

test('saved history preparation rechecks both the authorized file version and exact commit journal before installation', win, async () => {
  for (const mode of ['file', 'commit', 'journal-version']) {
    const f = await fixture(); const plan = await f.store.prepareRecovery(f.sessionId, f.current, randomUUID());
    const h = createTextHistory(f.current.bytes, identity(), digest, plan.history); const recovery = await plan.resolve(h.source);
    if (mode === 'file') await writeFile(f.entry, f.current.bytes);
    else {
      const path = join(f.privateRoot, f.prepared.transactionId, 'committed.json');
      await writeFile(path, mode === 'commit' ? '{broken' : JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2));
    }
    await assert.rejects(recovery.verify(), /DRAFT_RECOVERY_CONFLICT|DRAFT_RECOVERY_UNAVAILABLE|DRAFT_CHECKPOINT_CHANGED/);
    if (mode !== 'journal-version') await assert.rejects(f.store.prepareRecovery(f.sessionId, await openSaveSource(f.entry, f.current.bytes), randomUUID()), /DRAFT_RECOVERY_UNAVAILABLE/);
    assert.deepEqual(await readFile(f.entry), Buffer.from(f.current.bytes));
  }
});

test('multiple valid-looking commit journals for the same saved version are ambiguous and cannot authorize a history continuation', win, async () => {
  const f = await fixture(); const originalRoot = join(f.privateRoot, f.prepared.transactionId);
  const id = randomUUID(); const duplicate = join(f.privateRoot, id); await mkdir(duplicate);
  const intent = { ...JSON.parse(await readFile(join(originalRoot, 'intent.json'), 'utf8')), transactionId: id };
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`); const intentHash = digest(bytes);
  await writeFile(join(duplicate, 'intent.json'), bytes);
  for (const name of ['backup.bin', 'candidate.bin']) await writeFile(join(duplicate, name), await readFile(join(originalRoot, name)));
  for (const name of ['prepared.json', 'replacing.json', 'committed.json']) {
    const value = { ...JSON.parse(await readFile(join(originalRoot, name), 'utf8')), transactionId: id, intentHash };
    await writeFile(join(duplicate, name), `${JSON.stringify(value)}\n`);
  }
  assert.equal((await f.saves.inspect(id, f.current.current)).state, 'committed-matches');
  await assert.rejects(f.store.prepareRecovery(f.sessionId, f.current, randomUUID()), /DRAFT_SAVED_HISTORY_UNCONFIRMED/);
  assert.deepEqual(await readFile(f.entry), Buffer.from(f.current.bytes));
});

test('a real replacement without a confirmed commit retains the lock and never permits saved history reconstruction', win, async () => {
  const f = await fixture(async step => { if (step === 'native-replaced') throw Error('test lost commit'); });
  assert.equal(f.result.status, 'unknown'); assert.equal((await f.saves.scan()).locked, true);
  await assert.rejects(f.store.prepareRecovery(f.sessionId, f.current, randomUUID()), /DRAFT_STORAGE_LOCKED/);
  assert.equal((await f.store.inspect(f.point.checkpointId, f.current.current)).state, 'candidate-on-disk');
  assert.deepEqual(await readFile(f.entry), Buffer.from(f.history.candidate.bytes));
});
