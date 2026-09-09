import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><!-- untouched --><script>const n=41</script>');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>已应用 &lt;&amp;&gt; 🧪</h1><!-- untouched --><script>const n=41</script>');
async function fixture(onStep = async () => {}) {
  const base = resolve('test-results'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'draft-checkpoint-'));
  const project = join(root, '项目 🧪'); const privateRoot = join(root, 'private'); await mkdir(project); await mkdir(privateRoot);
  const entry = join(project, '报告 😀.html'); await writeFile(entry, original);
  const source = await openSaveSource(entry, original); const sessionId = randomUUID();
  const index = createSourceIndex(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const node = index.nodes.find(node => node.decodedText === 'A & 😀');
  const candidate = (text = '已应用 <&> 🧪') => createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash,
    nodeId: node.nodeId, expectedText: node.decodedText, newText: text });
  const control = { step: onStep }; const store = await createDraftCheckpointStore(privateRoot, step => control.step(step));
  const write = (revision, value = candidate()) => store.write(source, index, value, sessionId, revision);
  return { root, project, privateRoot, entry, source, sessionId, index, candidate, control, store, write };
}
const folder = (f, id) => join(f.privateRoot, id);

test('a reopened private checkpoint restores exact candidate bytes with new mapping identity and never writes HTML', async () => {
  const f = await fixture(); const mutable = { ...f.candidate(), bytes: f.candidate().bytes };
  const pending = f.write(2, mutable); mutable.bytes.fill(0); const result = await pending; assert.equal(result.status, 'persisted', result.code);
  assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(join(folder(f, result.checkpointId), 'baseline.bin')), original);
  const store = await createDraftCheckpointStore(f.privateRoot); const read = await store.inspect(result.checkpointId, f.source.current);
  assert.equal(read.phase, 'complete'); assert.equal(read.state, 'baseline-matches'); assert.equal(read.checkpoint.draftRevision, 2);
  assert.ok(Object.isFrozen(read.checkpoint) && Object.isFrozen(read.checkpoint.intents));
  assert.equal(JSON.stringify(read.checkpoint).includes(f.root), false);
  const fresh = createSourceIndex(original, { projectId: 'reopen', documentId: 'new', generation: 5 }, digest);
  const recovered = await store.restoreCandidate(result.checkpointId, f.source, fresh);
  assert.deepEqual(recovered.identity, fresh.identity); assert.deepEqual(Buffer.from(recovered.bytes), expected);
  assert.deepEqual(await readFile(f.entry), original); assert.equal((await store.scan()).locked, false);
  const summary = (await store.scan()).records[0].summary; assert.equal(summary.changeCount, 1); assert.equal('intents' in summary, false);
});

test('external changes do not prevent retaining opened-baseline drafts but block recovery; candidate bytes alone are not a commit', async () => {
  for (const bytes of [original, expected, Buffer.from('external source')]) {
    const f = await fixture(); await writeFile(f.entry, bytes);
    const result = await f.write(2); assert.equal(result.status, 'persisted');
    const source = await openSaveSource(f.entry, bytes); const read = await f.store.inspect(result.checkpointId, source.current);
    assert.equal(read.state, bytes === expected ? 'candidate-on-disk' : 'conflict');
    await assert.rejects(f.store.restoreCandidate(result.checkpointId, source, f.index), /DRAFT_RECOVERY_CONFLICT/);
    assert.deepEqual(await readFile(f.entry), bytes); assert.deepEqual(await readFile(join(folder(f, result.checkpointId), 'baseline.bin')), original);
  }
});

test('wrong or unavailable targets and a changed current version during restore never return a recoverable candidate', async () => {
  const f = await fixture(); const result = await f.write(2); const otherPath = join(f.project, '另一份.html'); await writeFile(otherPath, original);
  const other = await openSaveSource(otherPath, original);
  assert.equal((await f.store.inspect(result.checkpointId, other.current)).state, 'wrong-target');
  assert.equal((await f.store.inspect(result.checkpointId)).state, 'unavailable');
  assert.equal((await f.store.inspect(result.checkpointId, async () => { throw new Error('unreadable'); })).state, 'unavailable');
  await assert.rejects(f.store.restoreCandidate(result.checkpointId, other, f.index), /DRAFT_RECOVERY_CONFLICT/);
  const changedDuringCheck = { ...f.source, current: async () => { const state = await f.source.current(); await writeFile(f.entry, original); return state; } };
  await assert.rejects(f.store.restoreCandidate(result.checkpointId, changedDuringCheck, f.index), /FILE_CHANGED/);
});

test('identical retries confirm the same checkpoint, stale/reused revisions reject, and a clean newest checkpoint does not resurrect old edits', async () => {
  const f = await fixture(); const first = await f.write(2); const again = await f.write(2);
  assert.equal(again.status, 'persisted'); assert.equal(again.checkpointId, first.checkpointId); assert.equal((await f.store.scan()).records.length, 1);
  assert.equal((await f.write(2, f.candidate('different'))).code, 'DRAFT_CHECKPOINT_STALE');
  const clean = createPatchEngine(f.index, digest).candidate; const last = await f.write(3, clean); assert.equal(last.status, 'persisted');
  assert.equal((await f.write(2)).code, 'DRAFT_CHECKPOINT_STALE');
  const list = (await f.store.scan()).records.map(value => value.summary).sort((a, b) => b.draftRevision - a.draftRevision);
  assert.equal(list[0].draftRevision, 3); assert.equal(list[0].changeCount, 0); assert.equal(list[0].resultHash, f.source.baseHash);
  assert.deepEqual(Buffer.from((await f.store.restoreCandidate(last.checkpointId, f.source, f.index)).bytes), original);
});

test('partial/checksum-corrupt/forged-semantic checkpoints reject while a previous complete point remains readable', async () => {
  for (const mode of ['baseline', 'record', 'complete', 'semantic', 'parent']) {
    const f = await fixture(); const first = await f.write(2); const next = await f.write(3, f.candidate('later'));
    const where = folder(f, next.checkpointId);
    if (mode === 'parent') { await rename(where, join(f.root, 'moved-evidence')); await mkdir(where); }
    else if (mode === 'semantic') {
      const record = JSON.parse(await readFile(join(where, 'record.json'), 'utf8')); record.intents[0].expectedText = 'wrong original';
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`); await writeFile(join(where, 'record.json'), bytes);
      await writeFile(join(where, 'complete.json'), JSON.stringify({ version: 1, checkpointId: next.checkpointId, recordHash: digest(bytes) }));
    } else await writeFile(join(where, mode === 'baseline' ? 'baseline.bin' : `${mode}.json`), 'damaged');
    assert.notEqual((await f.store.inspect(next.checkpointId)).phase, 'complete');
    await assert.rejects(f.store.restoreCandidate(next.checkpointId, f.source, f.index));
    assert.equal((await f.store.inspect(first.checkpointId, f.source.current)).state, 'baseline-matches');
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('write faults retain previous durable points; incomplete same-revision retries can persist without overwriting their evidence', async () => {
  for (const stage of ['lock-created', 'record-created', 'record-synced', 'baseline-created', 'baseline-synced', 'complete-created', 'complete-synced']) {
    const f = await fixture(); const first = await f.write(2);
    f.control.step = async step => { if (step === stage) throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' }); };
    const result = await f.write(3, f.candidate('later'));
    assert.equal(result.status, stage.startsWith('complete-') ? 'unknown' : 'failed', stage);
    if (stage === 'lock-created') assert.equal(result.cleanupPending, true);
    assert.equal((await f.store.inspect(first.checkpointId, f.source.current)).phase, 'complete');
    assert.deepEqual(await readFile(f.entry), original); f.control.step = async () => {};
    if (stage === 'baseline-synced' || stage === 'complete-synced') {
      const retried = await f.write(3, f.candidate('later')); assert.equal(retried.status, 'persisted', retried.code);
      assert.equal(retried.checkpointId === result.checkpointId, stage === 'complete-synced');
    }
  }
});

test('concurrent checkpoint writes cannot overlap and lock cleanup failure preserves a confirmed persisted status', async () => {
  const f = await fixture(); let release; let started;
  const ready = new Promise(done => { started = done; }); const wait = new Promise(done => { release = done; });
  f.control.step = async step => { if (step === 'baseline-synced') { started(); await wait; } };
  const pending = f.write(2); await ready;
  try {
    assert.equal((await f.write(3)).code, 'DRAFT_STORAGE_BUSY');
    const second = await createDraftCheckpointStore(f.privateRoot);
    assert.equal((await second.write(f.source, f.index, f.candidate(), f.sessionId, 3)).code, 'DRAFT_STORAGE_LOCKED');
  } finally { release(); }
  assert.equal((await pending).status, 'persisted');
  f.control.step = async step => { if (step === 'release-lock') throw new Error('cleanup failure'); };
  const last = await f.write(3); assert.equal(last.status, 'persisted'); assert.equal(last.cleanupPending, true);
  assert.equal(last.code, 'DRAFT_CLEANUP_PENDING'); assert.equal((await f.store.scan()).locked, true);
  assert.equal((await f.store.inspect(last.checkpointId, f.source.current)).phase, 'complete');
});

test('the retention limit preserves all twenty existing points and rejects a twenty-first checkpoint without changing source', async () => {
  const f = await fixture();
  for (let revision = 1; revision <= 20; revision++) assert.equal((await f.write(revision)).status, 'persisted');
  const before = await readdir(f.privateRoot); assert.equal((await f.write(21)).code, 'DRAFT_STORAGE_LIMIT');
  assert.deepEqual(await readdir(f.privateRoot), before); assert.equal((await f.store.scan()).records.length, 20);
  assert.deepEqual(await readFile(f.entry), original);
});

test('checkpoints and saves share an exclusive writer lock and discover only their own records after reopening', async () => {
  const f = await fixture(); const saves = await createSavePreparationStore(f.privateRoot);
  const prepared = await saves.prepare(f.source, f.candidate()); assert.equal(prepared.status, 'prepared');
  try { assert.equal((await f.write(2)).code, 'DRAFT_STORAGE_LOCKED'); }
  finally { await prepared.cancel(); }
  let release; let started;
  const ready = new Promise(done => { started = done; }); const wait = new Promise(done => { release = done; });
  f.control.step = async step => { if (step === 'baseline-synced') { started(); await wait; } };
  const pending = f.write(2); await ready;
  try { assert.equal((await saves.prepare(f.source, f.candidate())).code, 'SAVE_LOCKED'); }
  finally { release(); }
  const checkpoint = await pending; assert.equal(checkpoint.status, 'persisted');
  const reopenedSaves = await createSavePreparationStore(f.privateRoot);
  const reopenedDrafts = await createDraftCheckpointStore(f.privateRoot, undefined, reopenedSaves);
  const saveRecords = await reopenedSaves.scan(); const draftRecords = await reopenedDrafts.scan();
  assert.deepEqual(saveRecords.records.map(record => record.transactionId), [prepared.transactionId]);
  assert.deepEqual(draftRecords.records.map(record => record.checkpointId), [checkpoint.checkpointId]);
  assert.equal(saveRecords.locked, false); assert.equal(draftRecords.locked, false);
  assert.equal(saveRecords.records[0].phase, 'cancelled'); assert.equal(draftRecords.records[0].phase, 'complete');
  assert.deepEqual(await readFile(f.entry), original);
  const other = join(f.root, 'other-private'); await mkdir(other);
  await assert.rejects(createDraftCheckpointStore(other, undefined, reopenedSaves), /DRAFT_STORAGE_ROOT_MISMATCH/);
});

test('the twenty-record quota counts save transactions and checkpoints together for both writers', async () => {
  const f = await fixture(); const saves = await createSavePreparationStore(f.privateRoot);
  for (let revision = 1; revision <= 10; revision++) {
    assert.equal((await f.write(revision)).status, 'persisted');
    const prepared = await saves.prepare(f.source, f.candidate()); assert.equal(prepared.status, 'prepared', prepared.code);
    await prepared.cancel();
  }
  const before = await readdir(f.privateRoot);
  assert.equal((await f.write(11)).code, 'DRAFT_STORAGE_LIMIT');
  assert.equal((await saves.prepare(f.source, f.candidate())).code, 'BACKUP_LIMIT');
  assert.deepEqual(await readdir(f.privateRoot), before);
  assert.equal((await f.store.scan()).records.length, 10); assert.equal((await saves.scan()).records.length, 10);
  assert.deepEqual(await readFile(f.entry), original);
});

test('a valid checkpoint remains readable when save discovery is unavailable, without falsely confirming candidate bytes as saved', async () => {
  const f = await fixture(); const checkpoint = await f.write(2); await writeFile(f.entry, expected);
  const saves = await createSavePreparationStore(f.privateRoot);
  const unreadableSaves = { ...saves, scan: async () => { throw new Error('save discovery unavailable'); } };
  const drafts = await createDraftCheckpointStore(f.privateRoot, undefined, unreadableSaves);
  const source = await openSaveSource(f.entry, expected); const read = await drafts.inspect(checkpoint.checkpointId, source.current);
  assert.equal(read.phase, 'complete'); assert.equal(read.state, 'candidate-on-disk');
  await assert.rejects(drafts.restoreCandidate(checkpoint.checkpointId, source, f.index), /DRAFT_RECOVERY_CONFLICT/);
  assert.deepEqual(await readFile(f.entry), expected);
});

test('actual writer SIGKILL leaves the previous checkpoint usable; an unacknowledged sealed point is independently verified without HTML replay', { timeout: 25000 }, async () => {
  for (const stage of ['baseline-synced', 'complete-created', 'complete-synced']) {
    const f = await fixture(); const first = await f.write(2);
    const task = fork(resolve('tests/storage/checkpoint-child.mjs'), [f.privateRoot, f.entry, f.sessionId, stage],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let timer; let errors = ''; task.stderr.on('data', bytes => { errors += bytes; });
    try {
      const value = await Promise.race([once(task, 'message').then(([message]) => message),
        once(task, 'exit').then(([code]) => { throw new Error(`early writer exit ${code}: ${errors}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`checkpoint barrier timeout: ${errors}`)), 6000); })]).finally(() => clearTimeout(timer));
      assert.equal(value.stage, stage); const ended = once(task, 'exit'); task.kill('SIGKILL');
      const [code, signal] = await ended; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      const store = await createDraftCheckpointStore(f.privateRoot); const scan = await store.scan(); assert.equal(scan.locked, true);
      assert.equal((await store.inspect(first.checkpointId, f.source.current)).state, 'baseline-matches');
      const last = scan.records.find(value => value.checkpointId !== first.checkpointId); assert.ok(last);
      assert.equal(last.phase === 'complete', stage === 'complete-synced');
      if (stage === 'complete-synced') {
        const recovered = await store.restoreCandidate(last.checkpointId, f.source, f.index);
        assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(original.toString().replace('A &amp; 😀', '进程终止前的新草稿 🧪')));
      }
      assert.deepEqual(await readFile(f.entry), original);
      assert.equal((await store.write(f.source, f.index, f.candidate(), f.sessionId, 4)).code, 'DRAFT_STORAGE_LOCKED');
    } finally { if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL'); }
  }
});
