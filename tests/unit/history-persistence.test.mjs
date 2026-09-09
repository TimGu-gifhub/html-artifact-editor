import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftPersistence } from '../../src/main/draft/persistence.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { isDraftCheckpoint } from '../../src/contracts/draft-checkpoint.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"></head><body><h1>A &#38; 😀</h1><p>保留</p><!-- literal --></body></html>');
const identity = () => ({ projectId: randomUUID(), documentId: randomUUID(), generation: 1 });
const edit = (h, text) => {
  const node = h.source.nodes.find(node => node.parentTag === 'h1');
  h.commit(h.prepareEdit({ identity: h.source.identity, baseHash: h.source.baseHash,
    nodeId: node.nodeId, expectedText: h.textFor(node.nodeId), newText: text }));
};
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results/history-storage-')); const privateRoot = join(root, 'private'); await mkdir(privateRoot);
  const entry = join(root, 'report.html'); await writeFile(entry, original);
  const source = await openSaveSource(entry, original); const h = createTextHistory(original, identity(), digest);
  const sessionId = randomUUID(); const control = { step: async () => {} };
  const store = await createDraftCheckpointStore(privateRoot, value => control.step(value));
  const write = (history = h, opened = source, id = sessionId) => store.write(opened, history.source, history.candidate, id, history.revision, history.capture());
  return { root, privateRoot, entry, source, h, sessionId, control, store, write };
}

test('v2 independently reconstructs ordered history and Redo using a fresh source identity, preserving bytes outside Text', async () => {
  const f = await fixture(); edit(f.h, 'B <&> 🧪'); edit(f.h, 'C'); f.h.commit(f.h.prepareMove('undo'));
  const saved = await f.write(); assert.equal(saved.status, 'persisted', saved.code);
  const store = await createDraftCheckpointStore(f.privateRoot);
  const before = await store.readLatestHistory(f.sessionId, f.source);
  assert.equal(before.record.cursor, 1); assert.equal(before.record.operations.length, 2);
  const fresh = createSourceIndex(original, identity(), digest);
  const recovered = await store.resolveLatest(f.sessionId, f.source, fresh);
  assert.deepEqual(recovered.candidate.bytes, f.h.candidate.bytes); assert.deepEqual(recovered.candidate.identity, fresh.identity);
  const h = createTextHistory(original, fresh.identity, digest, recovered.history);
  h.commit(h.prepareMove('redo')); assert.equal(h.summary().undoCount, 2);
  h.commit(h.prepareMove('undo')); assert.deepEqual(h.candidate.bytes, f.h.candidate.bytes);
  assert.deepEqual(await readFile(f.entry), original);
  assert.deepEqual(await readFile(join(f.privateRoot, saved.checkpointId, 'origin.bin')), original);
  const record = (await store.inspect(saved.checkpointId)).checkpoint;
  assert.equal(record.version, 2); assert.ok(Object.isFrozen(record.history.operations[0])); assert.equal(JSON.stringify(record).includes(f.root), false);
  const bad = { ...record, version: 1 }; assert.equal(isDraftCheckpoint(bad), false);
  assert.equal(isDraftCheckpoint({ ...record, intents: [{ ...record.intents[0], nodeId: 'n200000' }] }), false);
});

test('a latest clean v2 point restores only its history and Redo, never an older dirty candidate', async () => {
  const f = await fixture(); edit(f.h, 'B'); await f.write(); f.h.commit(f.h.prepareMove('undo')); const clean = await f.write();
  const group = (await f.store.catalog(f.source.current)).groups[0];
  assert.equal(group.status, 'clean'); assert.equal(group.historyAvailable, true); assert.equal(group.checkpointId, clean.checkpointId);
  const result = await f.store.resolveLatest(f.sessionId, f.source, createSourceIndex(original, identity(), digest));
  assert.equal(result.candidate.patches.length, 0); assert.deepEqual(Buffer.from(result.candidate.bytes), original);
  const h = createTextHistory(original, identity(), digest, result.history); h.commit(h.prepareMove('redo')); assert.equal(h.summary().dirty, true);
  const retired = await f.store.retire(f.source, f.sessionId, f.h.revision, 'discarded'); assert.equal(retired.status, 'retired');
  await assert.rejects(f.store.readLatestHistory(f.sessionId, f.source), /DRAFT_RECOVERY_UNAVAILABLE/);
});

test('v2 stores the origin proof for a saved empty Text, restores it at a fresh zero range and preserves the independent savepoint', async () => {
  const f = await fixture(); edit(f.h, ''); const baseline = f.h.candidate.bytes;
  // Storage-only fixture: native commit and verified rebase are covered by the Electron window suite.
  await writeFile(f.entry, baseline); const source = await openSaveSource(f.entry, baseline);
  const h = f.h.rebaseSaved(baseline, identity()); h.commit(h.prepareMove('undo'));
  const id = randomUUID(); const result = await f.write(h, source, id); assert.equal(result.status, 'persisted', result.code);
  const prior = await f.store.readLatestHistory(id, source);
  const reconstructed = createTextHistory(baseline, identity(), digest, prior);
  const recovery = await f.store.resolveLatest(id, source, reconstructed.source);
  assert.deepEqual(recovery.candidate.bytes, h.candidate.bytes); assert.equal(recovery.candidate.patches[0].startByte, recovery.candidate.patches[0].endByte);
  reconstructed.commit(reconstructed.prepareMove('redo')); assert.deepEqual(reconstructed.candidate.bytes, baseline);
  assert.deepEqual(await readFile(f.entry), Buffer.from(baseline));
  await assert.rejects(f.store.restoreLatest(id, source, createSourceIndex(baseline, identity(), digest)));
});

test('same candidate hash and revision cannot replace a different operation branch, including a v1 downgrade', async () => {
  const f = await fixture(); edit(f.h, 'B'); edit(f.h, 'A & 😀'); const first = await f.write();
  const other = createTextHistory(original, f.h.source.identity, digest); edit(other, 'C'); edit(other, 'A & 😀');
  assert.equal(other.candidate.resultHash, f.h.candidate.resultHash); assert.equal(other.revision, f.h.revision);
  assert.equal((await f.write(other)).code, 'DRAFT_CHECKPOINT_STALE');
  assert.equal((await f.write()).checkpointId, first.checkpointId);
  const plain = createSourceIndex(original, f.h.source.identity, digest);
  assert.equal((await f.store.write(f.source, plain, f.h.candidate, f.sessionId, f.h.revision)).code, 'DRAFT_CHECKPOINT_STALE');
  assert.equal((await readdir(f.privateRoot)).length, 1);
});

test('origin corruption and a resealed invalid logical chain invalidate the newest checkpoint without falling back', async () => {
  for (const mode of ['origin', 'chain', 'intents']) {
    const f = await fixture(); edit(f.h, 'B'); const first = await f.write(); edit(f.h, 'C'); const next = await f.write();
    const folder = join(f.privateRoot, next.checkpointId);
    if (mode === 'origin') await writeFile(join(folder, 'origin.bin'), 'different');
    else {
      const record = JSON.parse(await readFile(join(folder, 'record.json'), 'utf8'));
      if (mode === 'chain') record.history.operations[1].before = 'wrong prior value'; else record.intents[0].newText = 'wrong candidate';
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`); await writeFile(join(folder, 'record.json'), bytes);
      await writeFile(join(folder, 'complete.json'), JSON.stringify({ version: 1, checkpointId: next.checkpointId, recordHash: digest(bytes) }));
    }
    assert.equal((await f.store.inspect(next.checkpointId)).phase, 'invalid');
    assert.equal((await f.store.inspect(first.checkpointId)).phase, 'complete');
    await assert.rejects(f.store.readLatestHistory(f.sessionId, f.source), /DRAFT_RECOVERY_UNAVAILABLE/);
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('origin and seal write failures preserve evidence, stop latest recovery and permit only an exact explicit retry', async () => {
  for (const stage of ['origin-created', 'origin-synced', 'complete-synced']) {
    const f = await fixture(); edit(f.h, 'B'); const first = await f.write(); edit(f.h, 'C');
    f.control.step = async step => { if (step === stage) throw Object.assign(Error('fault'), { code: 'ENOSPC' }); };
    const failed = await f.write(); assert.equal(failed.status, stage.startsWith('complete') ? 'unknown' : 'failed');
    assert.equal((await f.store.inspect(first.checkpointId)).phase, 'complete');
    if (stage.startsWith('origin')) await assert.rejects(f.store.readLatestHistory(f.sessionId, f.source), /DRAFT_RECOVERY_UNAVAILABLE/);
    f.control.step = async () => {}; const again = await f.write(); assert.equal(again.status, 'persisted', again.code);
    assert.equal(again.checkpointId === failed.checkpointId, stage.startsWith('complete'));
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('full history recovery rechecks current file version and never treats identical bytes rewritten by another process as authorized', async () => {
  const f = await fixture(); edit(f.h, 'B'); await f.write(); await writeFile(f.entry, original);
  const current = await openSaveSource(f.entry, original);
  await assert.rejects(f.store.readLatestHistory(f.sessionId, current), /DRAFT_RECOVERY_UNAVAILABLE/);
  assert.deepEqual(await readFile(f.entry), original);
});

test('adding origin evidence to a v1 record cannot bypass the original strict format or the shared Save inventory', async () => {
  const f = await fixture(); edit(f.h, 'B'); const plain = createSourceIndex(original, f.h.source.identity, digest);
  const legacy = await f.store.write(f.source, plain, f.h.candidate, f.sessionId, 2); assert.equal(legacy.status, 'persisted');
  await writeFile(join(f.privateRoot, legacy.checkpointId, 'origin.bin'), original);
  assert.equal((await f.store.inspect(legacy.checkpointId)).phase, 'invalid');
  assert.equal((await f.store.write(f.source, plain, f.h.candidate, f.sessionId, 3)).code, 'DRAFT_STORAGE_REVIEW_REQUIRED');
  const saves = await createSavePreparationStore(f.privateRoot); const prepared = await saves.prepare(f.source, f.h.candidate);
  assert.equal(prepared.status, 'failed'); assert.equal(prepared.code, 'STORAGE_REVIEW_REQUIRED'); assert.deepEqual(await readFile(f.entry), original);
});

test('coalescing persistence freezes each candidate together with its exact history branch and origin bytes', async () => {
  const f = await fixture(); let release; let started;
  const ready = new Promise(done => { started = done; }); const wait = new Promise(done => { release = done; }); const written = [];
  const queue = createDraftPersistence(async (candidate, revision, history) => {
    written.push({ candidate, revision, history }); if (written.length === 1) { started(); await wait; }
    return { status: 'persisted', checkpointId: randomUUID(), draftRevision: revision, resultHash: candidate.resultHash, cleanupPending: false, code: null };
  });
  edit(f.h, 'B'); const mutable = { originBytes: f.h.capture().originBytes, record: JSON.parse(JSON.stringify(f.h.capture().record)) };
  queue.enqueue(f.h.candidate, f.h.revision, mutable); await ready; mutable.originBytes.fill(0); mutable.record.operations[0].after = 'corrupt';
  edit(f.h, 'C'); queue.enqueue(f.h.candidate, f.h.revision, f.h.capture()); f.h.commit(f.h.prepareMove('undo')); queue.enqueue(f.h.candidate, f.h.revision, f.h.capture());
  release(); const settled = await queue.settle(); assert.equal(settled.status, 'persisted'); assert.deepEqual(written.map(item => item.revision), [2, 4]);
  assert.deepEqual(Buffer.from(written[0].history.originBytes), original); assert.equal(written[0].history.record.operations[0].after, 'B');
  assert.equal(written[1].history.record.cursor, 1); assert.equal(written[1].history.record.operations[1].after, 'C');
  await queue.close();
});
