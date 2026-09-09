import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDraftRetirement } from '../../src/contracts/draft-checkpoint.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><!-- preserve -->');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>新 &lt;&amp;&gt; 🧪</h1><!-- preserve -->');
async function fixture() {
  const base = resolve('test-results'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'draft-lifecycle-'));
  const privateRoot = join(root, 'private'); const project = join(root, 'project'); await mkdir(privateRoot); await mkdir(project);
  const entry = join(project, '报告 🧪.html'); await writeFile(entry, original); const source = await openSaveSource(entry, original);
  const sessionId = randomUUID(); const index = createSourceIndex(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const node = index.nodes.find(node => node.decodedText === 'A & 😀');
  const candidate = (newText = '新 <&> 🧪') => createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash,
    nodeId: node.nodeId, expectedText: node.decodedText, newText });
  const control = { step: async () => {} }; const store = await createDraftCheckpointStore(privateRoot, step => control.step(step));
  const write = (revision, value = candidate()) => store.write(source, index, value, sessionId, revision);
  return { root, privateRoot, entry, source, sessionId, index, candidate, control, store, write };
}
const checkpointPath = (f, id, file) => join(f.privateRoot, id, file);

test('latest recovery follows revisions rather than timestamps; a new clean checkpoint never falls back to older dirty edits', async () => {
  const f = await fixture(); const first = await f.write(2);
  const oldHeader = JSON.parse(await readFile(checkpointPath(f, first.checkpointId, 'record.json'), 'utf8'));
  const dated = Buffer.from(JSON.stringify({ ...oldHeader, createdAt: Date.now() + 86400000 }));
  await writeFile(checkpointPath(f, first.checkpointId, 'record.json'), dated);
  await writeFile(checkpointPath(f, first.checkpointId, 'complete.json'), JSON.stringify({ version: 1, checkpointId: first.checkpointId, recordHash: digest(dated) }));
  const later = await f.write(3, f.candidate('later'));
  let catalog = await f.store.catalog(f.source.current); assert.equal(catalog.reviewRequired, false);
  assert.equal(catalog.groups.length, 1); assert.equal(catalog.groups[0].checkpointId, later.checkpointId);
  assert.equal(catalog.groups[0].status, 'dirty'); assert.equal(catalog.groups[0].targetState, 'baseline-matches');
  assert.deepEqual(Buffer.from((await f.store.restoreLatest(f.sessionId, f.source, f.index)).bytes), Buffer.from(original.toString().replace('A &amp; 😀', 'later')));
  const clean = await f.write(4, f.candidate('A & 😀')); catalog = await f.store.catalog(f.source.current);
  assert.equal(catalog.groups[0].checkpointId, clean.checkpointId); assert.equal(catalog.groups[0].status, 'clean');
  await assert.rejects(f.store.restoreLatest(f.sessionId, f.source, f.index), /DRAFT_RECOVERY_UNAVAILABLE/);
  assert.equal((await f.store.inspect(first.checkpointId)).phase, 'complete');
  assert.equal('intents' in catalog.groups[0], false); assert.equal(JSON.stringify(catalog).includes(f.root), false);
  assert.deepEqual(await readFile(f.entry), original);
});

test('a higher incomplete revision, conflicting retry or unclassified header prevents automatic recovery of an older point', async () => {
  for (const mode of ['incomplete', 'ambiguous', 'unclassified']) {
    const f = await fixture(); const first = await f.write(2);
    if (mode === 'incomplete') {
      f.control.step = async step => { if (step === 'baseline-created') throw new Error('interrupted'); };
      await f.write(3, f.candidate('newer'));
    } else {
      const id = randomUUID(); await mkdir(join(f.privateRoot, id));
      const header = JSON.parse(await readFile(checkpointPath(f, first.checkpointId, 'record.json'), 'utf8'));
      await writeFile(checkpointPath(f, id, 'record.json'), mode === 'unclassified' ? '{partial'
        : JSON.stringify({ ...header, checkpointId: id, resultHash: 'f'.repeat(64), createdAt: 1 }));
    }
    const catalog = await f.store.catalog(f.source.current); assert.equal(catalog.reviewRequired, true);
    if (mode === 'incomplete') assert.equal(catalog.groups[0].draftRevision, 3);
    if (mode === 'ambiguous') assert.equal(catalog.groups[0].status, 'ambiguous');
    if (mode === 'unclassified') assert.equal(catalog.unclassified.length, 1);
    await assert.rejects(f.store.restoreLatest(f.sessionId, f.source, f.index));
    assert.equal((await f.store.inspect(first.checkpointId)).phase, 'complete'); assert.deepEqual(await readFile(f.entry), original);
  }
  const f = await fixture(); f.control.step = async step => { if (step === 'baseline-created') throw new Error('interrupted attempt'); };
  await f.write(2); f.control.step = async () => {}; const complete = await f.write(2);
  const catalog = await f.store.catalog(f.source.current); assert.equal(catalog.groups[0].checkpointId, complete.checkpointId);
  assert.equal(catalog.reviewRequired, false); assert.deepEqual(Buffer.from((await f.store.restoreLatest(f.sessionId, f.source, f.index)).bytes), expected);
});

test('explicit retirement ends one session, is idempotent, preserves every original checkpoint byte and cannot be bypassed by a new writer', async () => {
  for (const reason of ['discarded', 'copied']) {
    const f = await fixture(); const first = await f.write(2); const last = await f.write(3, f.candidate('last'));
    const files = ['record.json', 'baseline.bin', 'complete.json']; const before = await Promise.all(files.map(file => readFile(checkpointPath(f, last.checkpointId, file))));
    const retired = await f.store.retire(f.source, f.sessionId, 3, reason); assert.equal(retired.status, 'retired', retired.code);
    assert.equal(retired.checkpointId, last.checkpointId);
    const repeated = await f.store.retire(f.source, f.sessionId, 3, reason); assert.equal(repeated.status, 'retired'); assert.equal(repeated.checkpointId, retired.checkpointId);
    const reopened = await createDraftCheckpointStore(f.privateRoot); const catalog = await reopened.catalog(f.source.current);
    assert.equal(catalog.groups[0].status, 'retired'); assert.equal(catalog.groups[0].retirement, reason); assert.equal(catalog.locked, false);
    for (const id of [first.checkpointId, last.checkpointId]) await assert.rejects(reopened.restoreCandidate(id, f.source, f.index), /DRAFT_SESSION_RETIRED/);
    assert.equal((await reopened.write(f.source, f.index, f.candidate('resurrect'), f.sessionId, 4)).code, 'DRAFT_SESSION_RETIRED');
    assert.deepEqual(await Promise.all(files.map(file => readFile(checkpointPath(f, last.checkpointId, file)))), before);
    const nextId = randomUUID(); assert.equal((await reopened.write(f.source, f.index, f.candidate(), nextId, 2)).status, 'persisted');
    assert.deepEqual(Buffer.from((await reopened.restoreLatest(nextId, f.source, f.index)).bytes), expected);
    const saves = await createSavePreparationStore(f.privateRoot); const prepared = await saves.prepare(f.source, f.candidate());
    assert.equal(prepared.status, 'prepared'); await prepared.cancel(); assert.deepEqual(await readFile(f.entry), original);
  }
});

test('retirement requires the original session binding and current revision, but can discard old drafts after an external source edit without overwriting it', async () => {
  const f = await fixture(); await f.write(3);
  assert.equal((await f.store.retire(f.source, f.sessionId, 2, 'discarded')).code, 'DRAFT_RETIREMENT_STALE');
  assert.equal((await f.store.retire(f.source, f.sessionId, 3, 'saved')).code, 'DRAFT_RETIREMENT_INVALID');
  await writeFile(f.entry, original); const differentVersion = await openSaveSource(f.entry, original);
  assert.equal((await f.store.retire(differentVersion, f.sessionId, 3, 'discarded')).code, 'DRAFT_SESSION_MISMATCH');
  assert.equal((await f.store.write(differentVersion, f.index, f.candidate(), f.sessionId, 4)).code, 'DRAFT_SESSION_MISMATCH');
  const external = Buffer.from('External replacement'); await writeFile(f.entry, external);
  assert.equal((await f.store.retire(f.source, f.sessionId, 3, 'discarded')).status, 'retired');
  assert.deepEqual(await readFile(f.entry), external);
  const empty = await f.store.retire(f.source, randomUUID(), 1, 'discarded'); assert.equal(empty.status, 'empty');
});

test('retirement is possible at the twenty-record limit and remains subject to shared writer exclusion and cleanup ownership', async () => {
  const f = await fixture(); for (let revision = 1; revision <= 20; revision++) assert.equal((await f.write(revision)).status, 'persisted');
  const names = await readdir(f.privateRoot); const saves = await createSavePreparationStore(f.privateRoot);
  let release; let reached; const ready = new Promise(done => { reached = done; }); const wait = new Promise(done => { release = done; });
  f.control.step = async step => { if (step === 'retirement-synced') { reached(); await wait; } };
  const pending = f.store.retire(f.source, f.sessionId, 20, 'discarded'); await ready;
  try {
    assert.equal((await f.write(21)).code, 'DRAFT_STORAGE_BUSY');
    const other = await createDraftCheckpointStore(f.privateRoot);
    assert.equal((await other.retire(f.source, f.sessionId, 20, 'discarded')).code, 'DRAFT_STORAGE_LOCKED');
    assert.equal((await saves.prepare(f.source, f.candidate())).code, 'SAVE_LOCKED');
  } finally { release(); }
  assert.equal((await pending).status, 'retired'); assert.deepEqual(await readdir(f.privateRoot), names);
  assert.deepEqual(await readFile(f.entry), original);
  const fresh = await fixture(); await fresh.write(2);
  fresh.control.step = async step => { if (step === 'release-lock') throw new Error('cleanup unavailable'); };
  const result = await fresh.store.retire(fresh.source, fresh.sessionId, 2, 'discarded');
  assert.equal(result.status, 'retired'); assert.equal(result.cleanupPending, true);
  assert.equal((await fresh.store.catalog()).locked, true); assert.equal((await fresh.store.catalog()).groups[0].status, 'retired');
});

test('damaged or unbound retirement records require review rather than restoring any old draft or accepting further writes', async () => {
  for (const mode of ['version', 'hash', 'session', 'revision', 'extra', 'partial']) {
    const f = await fixture(); const point = await f.write(3);
    assert.equal((await f.store.retire(f.source, f.sessionId, 3, 'discarded')).status, 'retired');
    const path = checkpointPath(f, point.checkpointId, 'retired.json'); const value = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(isDraftRetirement(value), true);
    const changed = mode === 'version' ? { ...value, version: 2 } : mode === 'hash' ? { ...value, recordHash: 'a'.repeat(64) }
      : mode === 'session' ? { ...value, sessionId: randomUUID() } : mode === 'revision' ? { ...value, draftRevision: 2 }
        : { ...value, path: 'outside.html' };
    await writeFile(path, mode === 'partial' ? '{' : JSON.stringify(changed));
    assert.equal((await f.store.catalog()).groups[0].status, 'invalid');
    await assert.rejects(f.store.restoreCandidate(point.checkpointId, f.source, f.index));
    assert.equal((await f.write(4)).status, 'failed'); assert.deepEqual(await readFile(f.entry), original);
  }
  const f = await fixture(); const first = await f.write(2); const anchor = await f.write(3);
  assert.equal((await f.store.retire(f.source, f.sessionId, 3, 'discarded')).status, 'retired');
  const header = JSON.parse(await readFile(checkpointPath(f, anchor.checkpointId, 'record.json'), 'utf8'));
  const moved = Buffer.from(JSON.stringify({ ...header, sessionId: randomUUID() }));
  await writeFile(checkpointPath(f, anchor.checkpointId, 'record.json'), moved);
  await writeFile(checkpointPath(f, anchor.checkpointId, 'complete.json'), JSON.stringify({ version: 1, checkpointId: anchor.checkpointId, recordHash: digest(moved) }));
  assert.equal((await f.store.catalog()).unclassified.length, 1);
  await assert.rejects(f.store.restoreCandidate(first.checkpointId, f.source, f.index), /DRAFT_STORAGE_REVIEW_REQUIRED/);
  await assert.rejects(f.store.restoreLatest(f.sessionId, f.source, f.index), /DRAFT_STORAGE_REVIEW_REQUIRED/);
  assert.deepEqual(await readFile(f.entry), original);
});

test('write failures during retirement retain all evidence; a complete unacknowledged marker can be confirmed without rewriting it', async () => {
  for (const stage of ['lock-created', 'retirement-created', 'retirement-written', 'retirement-synced', 'retirement-verified']) {
    const f = await fixture(); const point = await f.write(2);
    f.control.step = async step => { if (step === stage) throw Object.assign(new Error('injected retirement failure'), { code: 'ENOSPC' }); };
    const result = await f.store.retire(f.source, f.sessionId, 2, 'discarded');
    assert.equal(result.status, stage === 'lock-created' ? 'failed' : 'unknown');
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(checkpointPath(f, point.checkpointId, 'baseline.bin')), original);
    const catalog = await f.store.catalog();
    if (stage === 'retirement-created') { assert.equal(catalog.groups[0].status, 'invalid'); assert.equal(catalog.reviewRequired, true); }
    if (stage === 'retirement-synced' || stage === 'retirement-verified') {
      assert.equal(catalog.groups[0].status, 'retired'); f.control.step = async () => {};
      const before = await readFile(checkpointPath(f, point.checkpointId, 'retired.json'));
      assert.equal((await f.store.retire(f.source, f.sessionId, 2, 'discarded')).status, 'retired');
      assert.deepEqual(await readFile(checkpointPath(f, point.checkpointId, 'retired.json')), before);
    }
  }
});

test('retirement arriving while a recovery candidate is being verified prevents that candidate from escaping', async () => {
  const f = await fixture(); const point = await f.write(2); let checks = 0;
  const source = { ...f.source, verify: async () => {
    await f.source.verify(); if (++checks === 1) assert.equal((await f.store.retire(f.source, f.sessionId, 2, 'discarded')).status, 'retired');
  } };
  await assert.rejects(f.store.restoreLatest(f.sessionId, source, f.index), /DRAFT_SESSION_RETIRED/);
  assert.equal((await f.store.inspect(point.checkpointId)).phase, 'complete'); assert.deepEqual(await readFile(f.entry), original);
});

test('actual process kill during retirement leaves either explicit review or a verifiable closed session, never automatic old-draft replay', { timeout: 20000 }, async () => {
  for (const stage of ['retirement-created', 'retirement-synced']) {
    const f = await fixture(); const point = await f.write(2);
    const task = fork(resolve('tests/storage/checkpoint-child.mjs'), [f.privateRoot, f.entry, f.sessionId, stage],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let timer; let errors = ''; task.stderr.on('data', bytes => { errors += bytes; });
    try {
      const message = await Promise.race([once(task, 'message').then(([message]) => message),
        once(task, 'exit').then(([code]) => { throw new Error(`early exit ${code}: ${errors}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`retirement timeout: ${errors}`)), 5000); })]).finally(() => clearTimeout(timer));
      assert.equal(message.stage, stage); const ended = once(task, 'exit'); task.kill('SIGKILL');
      const [code, signal] = await ended; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      const store = await createDraftCheckpointStore(f.privateRoot); const catalog = await store.catalog(f.source.current);
      assert.equal(catalog.locked, true); assert.equal(catalog.groups[0].status, stage === 'retirement-synced' ? 'retired' : 'invalid');
      await assert.rejects(store.restoreCandidate(point.checkpointId, f.source, f.index));
      assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(checkpointPath(f, point.checkpointId, 'baseline.bin')), original);
    } finally { if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL'); }
  }
});
