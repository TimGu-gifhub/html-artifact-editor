import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSaveIntent, isSaveSeal } from '../../src/contracts/save-record.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>原文 &amp; 😀</h1><!-- untouched -->\r\n<script>const n=41</script>');
const sourceIndex = createSourceIndex(original, { projectId: 'p1', documentId: 'd1', generation: 1 }, digest);
const engine = createPatchEngine(sourceIndex, digest);
const node = sourceIndex.nodes.find(item => item.decodedText === '原文 & 😀');
const candidate = engine.apply({ identity: sourceIndex.identity, baseHash: sourceIndex.baseHash, nodeId: node.nodeId,
  expectedText: node.decodedText, newText: '修改 🧪 <标签> & 结果' });
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>修改 🧪 &lt;标签&gt; &amp; 结果</h1><!-- untouched -->\r\n<script>const n=41</script>');
assert.deepEqual(Buffer.from(candidate.bytes), expected);
async function fixture() {
  const base = resolve('test-results'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'save-preparation-')); const project = join(root, '项目 😀'); const privateRoot = join(root, 'private-store');
  await mkdir(project); await mkdir(privateRoot);
  const entry = join(project, '报告 😀.html'); await writeFile(entry, original);
  const candidatePath = join(root, 'new.bin'); await writeFile(candidatePath, expected);
  const source = await openSaveSource(entry, original);
  return { root, project, entry, privateRoot, candidatePath, source };
}
const records = async (root) => (await readdir(root)).filter(name => /^[a-f0-9-]{36}$/u.test(name));
async function child(f, stage) {
  const task = fork(resolve('tests/storage/preparation-child.mjs'), [f.privateRoot, f.entry, f.candidatePath, stage],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let error = ''; task.stderr.on('data', chunk => { error += chunk; });
  let timeout;
  const message = await Promise.race([
    once(task, 'message').then(([value]) => value),
    once(task, 'exit').then(([code]) => { throw new Error(`Early child exit ${code}: ${error}`); }),
    new Promise((_, reject) => { timeout = setTimeout(() => { task.kill('SIGKILL'); reject(new Error(`Child timed out: ${error}`)); }, 6000); }),
  ]).finally(() => clearTimeout(timeout));
  return { task, message };
}

test('preparation stores verified original/candidate bytes and seals; cancellation preserves evidence and writes no HTML', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  const mutable = { bytes: candidate.bytes, baseHash: candidate.baseHash, resultHash: candidate.resultHash };
  const pending = store.prepare(f.source, mutable); mutable.bytes.fill(0);
  const value = await pending; assert.equal(value.status, 'prepared', value.code);
  const folder = join(f.privateRoot, value.transactionId);
  assert.deepEqual(await readFile(join(folder, 'backup.bin')), original);
  assert.deepEqual(await readFile(join(folder, 'candidate.bin')), expected);
  assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readdir(f.project), ['报告 😀.html']);
  assert.equal((await store.inspect(value.transactionId, f.source.current)).state, 'baseline-matches');
  assert.equal((await store.inspect(value.transactionId)).state, 'unavailable');
  assert.ok(Object.isFrozen(value.intent)); assert.equal(JSON.stringify(value.intent).includes(f.root), false);
  assert.equal((await store.prepare(f.source, candidate)).code, 'SAVE_BUSY');
  await Promise.all([value.cancel(), value.cancel()]);
  assert.equal((await store.inspect(value.transactionId, f.source.current)).phase, 'cancelled');
  assert.ok(!(await readdir(f.privateRoot)).includes('active.lock')); assert.deepEqual(await readFile(f.entry), original);
});

test('file content, identity, hardlink, deletion and parent replacement conflicts reject before creating backup records', async () => {
  for (const mode of ['content', 'identity', 'hardlink', 'delete', 'parent']) {
    const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
    if (mode === 'content') await writeFile(f.entry, Buffer.from('external'));
    if (mode === 'identity') { await rename(f.entry, join(f.project, 'old.html')); await writeFile(f.entry, original); }
    if (mode === 'hardlink') await link(f.entry, join(f.project, 'linked.html'));
    if (mode === 'delete') await unlink(f.entry);
    if (mode === 'parent') { await rename(f.project, join(f.root, 'prior')); await mkdir(f.project); await writeFile(f.entry, original); }
    const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'failed'); assert.equal(value.code, 'FILE_CHANGED', mode);
    assert.deepEqual(await readdir(f.privateRoot), []);
  }
  const f = await fixture();
  await assert.rejects(openSaveSource(f.entry, Buffer.from('wrong baseline')), /FILE_CHANGED/);
  const bytes = f.source.bytes; bytes.fill(0); assert.deepEqual(Buffer.from(f.source.bytes), original);
  if (process.platform === 'win32') {
    const alias = await openSaveSource(f.entry.replace('.html', '.HTML'), original);
    assert.equal(alias.targetKey, f.source.targetKey, 'native case aliases use the canonical path key');
  }
});

test('candidate baseline, digest and size are validated before lock or storage writes; no-op does not create a transaction', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  for (const value of [{ ...candidate, resultHash: 'a'.repeat(64) }, { ...candidate, baseHash: 'b'.repeat(64) },
    { ...candidate, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }]) assert.equal((await store.prepare(f.source, value)).code, 'SAVE_INVALID_CANDIDATE');
  assert.equal((await store.prepare(f.source, { bytes: original, baseHash: digest(original), resultHash: digest(original) })).code, 'SAVE_NO_CHANGES');
  assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), original);
});

test('a second OS process sharing private storage cannot prepare concurrently; verified cancellation allows its next attempt', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'prepared');
  const first = await child(f, 'attempt'); assert.equal(first.message.kind, 'result'); assert.equal(first.message.code, 'SAVE_LOCKED');
  await value.cancel();
  const next = await child(f, 'attempt'); assert.equal(next.message.kind, 'result'); assert.equal(next.message.status, 'prepared');
  if (next.task.exitCode === null) await once(next.task, 'exit');
  assert.deepEqual(await readFile(f.entry), original);
});

test('injected write/flush failures retain partial evidence at every preparation boundary and never touch HTML', async () => {
  for (const stage of ['intent-written', 'backup-created', 'backup-written', 'backup-synced', 'candidate-created', 'candidate-synced', 'prepared-written']) {
    const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot, async (step) => {
      if (step === stage) throw Object.assign(new Error('injected space failure'), { code: 'ENOSPC' });
    });
    const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'failed', stage); assert.equal(value.code, 'BACKUP_DISK_FULL');
    assert.ok(value.transactionId); assert.deepEqual(await readFile(f.entry), original);
    const files = await readdir(join(f.privateRoot, value.transactionId)); assert.ok(files.includes('intent.json'));
    if (!stage.startsWith('intent-')) assert.ok(files.includes('backup.bin'));
  }
});

test('backup corruption, late external edits and private directory aliases never yield a prepared permission', async () => {
  for (const stage of ['backup-synced', 'candidate-synced', 'prepared-verified']) {
    const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot, async (step) => {
      if (step !== stage) return;
      if (step === 'prepared-verified') { await writeFile(f.entry, 'external'); return; }
      const [id] = await records(f.privateRoot);
      await writeFile(join(f.privateRoot, id, step.startsWith('backup') ? 'backup.bin' : 'candidate.bin'), 'corrupt');
    });
    const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'failed', stage);
    if (stage === 'prepared-verified') assert.equal(value.code, 'FILE_CHANGED');
    assert.deepEqual(await readFile(f.entry), stage === 'prepared-verified' ? Buffer.from('external') : original);
  }
  const f = await fixture(); const alias = join(f.root, 'alias'); await symlink(f.privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSavePreparationStore(alias), /STORAGE_LOCATION_CHANGED/);
  const store = await createSavePreparationStore(f.privateRoot);
  await rename(f.privateRoot, join(f.root, 'prior-store')); await mkdir(f.privateRoot);
  assert.equal((await store.prepare(f.source, candidate)).status, 'failed'); assert.deepEqual(await readdir(f.privateRoot), []);
});

test('restart inspection validates seals, schema, byte hashes and reselected target identity without writing or auto-replaying', async () => {
  const f = await fixture(); const initial = await createSavePreparationStore(f.privateRoot);
  const value = await initial.prepare(f.source, candidate); assert.equal(value.status, 'prepared');
  const restarted = await createSavePreparationStore(f.privateRoot);
  const discovered = await restarted.scan(); assert.equal(discovered.locked, true); assert.equal(discovered.unrecognized, false);
  assert.equal(discovered.records.length, 1); assert.equal(discovered.records[0].transactionId, value.transactionId);
  assert.equal(discovered.records[0].state, 'unavailable', 'discovery never follows an untrusted stored path to HTML');
  assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'baseline-matches');
  const wrong = await fixture(); assert.equal((await restarted.inspect(value.transactionId, wrong.source.current)).state, 'wrong-target');
  await writeFile(f.entry, expected); assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'candidate-on-disk');
  await delay(5); await writeFile(f.entry, original);
  assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'conflict', 'restored bytes do not restore the captured file version');
  await writeFile(f.entry, 'external'); assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'conflict');
  await unlink(f.entry); assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'unavailable');
  await writeFile(f.entry, original); // New inode with identical bytes is still a conflict.
  assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'conflict');
  const folder = join(f.privateRoot, value.transactionId);
  const header = await readFile(join(folder, 'intent.json')); const json = JSON.parse(header);
  for (const changed of [{ ...json, version: 9 }, { ...json, extraPath: '../outside' }, { ...json, identity: { dev: '0', ino: '0' } },
    { ...json, name: '../report.html' }, { ...json, oldSize: 5 * 1024 * 1024 + 1 }]) assert.equal(isSaveIntent(changed), false);
  assert.equal(isSaveSeal({ version: 1, transactionId: value.transactionId, intentHash: 'x', phase: 'prepared' }), false);
  await writeFile(join(folder, 'intent.json'), JSON.stringify({ ...json, createdAt: json.createdAt + 1 }));
  assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'invalid');
  await writeFile(join(folder, 'intent.json'), header);
  await writeFile(join(folder, 'candidate.bin'), 'damaged');
  assert.equal((await restarted.inspect(value.transactionId, f.source.current)).state, 'invalid');
  assert.equal((await restarted.inspect('../outside')).state, 'invalid'); assert.deepEqual(await readFile(f.entry), original);
});

test('real forced child termination preserves source and a lock at preparation boundaries; restart never blindly retries', async () => {
  for (const stage of ['lock-created', 'intent-synced', 'backup-created', 'backup-synced', 'candidate-synced', 'prepared-synced']) {
    const f = await fixture(); const { task, message } = await child(f, stage);
    assert.deepEqual(message, { kind: 'stage', step: stage }); const exited = once(task, 'exit');
    assert.equal(task.kill('SIGKILL'), true); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    assert.deepEqual(await readFile(f.entry), original); assert.ok((await readdir(f.privateRoot)).includes('active.lock'));
    const restarted = await createSavePreparationStore(f.privateRoot);
    const recovered = await restarted.scan(); assert.equal(recovered.locked, true);
    assert.equal((await restarted.prepare(f.source, candidate)).code, 'SAVE_LOCKED');
    for (const record of recovered.records) {
      const value = await restarted.inspect(record.transactionId, f.source.current);
      assert.equal(value.state, stage === 'prepared-synced' ? 'baseline-matches' : stage === 'backup-created' ? 'invalid' : 'incomplete', stage);
    }
  }
});

test('changed lock ownership is preserved on cancel and cannot unlock another owner', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'prepared');
  await writeFile(join(f.privateRoot, 'active.lock'), 'other owner');
  await assert.rejects(value.cancel(), /STORAGE_LOCK_CHANGED/);
  assert.equal(await readFile(join(f.privateRoot, 'active.lock'), 'utf8'), 'other owner');
  assert.deepEqual(await readFile(f.entry), original);
});

test('the per-target retention limit preserves all records and refuses another preparation without pruning', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  for (let i = 0; i < 20; i++) { const value = await store.prepare(f.source, candidate); assert.equal(value.status, 'prepared'); await value.cancel(); }
  const value = await store.prepare(f.source, candidate); assert.equal(value.code, 'BACKUP_LIMIT');
  assert.equal((await records(f.privateRoot)).length, 20); assert.deepEqual(await readFile(f.entry), original);
});
