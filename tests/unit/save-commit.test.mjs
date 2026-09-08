import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSaveCommit } from '../../src/contracts/save-record.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { digest } from '../../src/platform/storage-files.ts';

const win = { skip: process.platform !== 'win32', timeout: 30000 };
const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>原文 &amp; 😀</h1><!-- untouched -->\r\n<script>const n=41</script>');
const index = createSourceIndex(original, { projectId: 'p1', documentId: 'd1', generation: 1 }, digest);
const target = index.nodes.find(item => item.decodedText === '原文 & 😀');
const candidate = createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash, nodeId: target.nodeId,
  expectedText: target.decodedText, newText: '修订 🧪 <标签> & 结果' });
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>修订 🧪 &lt;标签&gt; &amp; 结果</h1><!-- untouched -->\r\n<script>const n=41</script>');
assert.deepEqual(Buffer.from(candidate.bytes), expected);
const helperPath = resolve('out/native/ReplaceHelper.exe'); const fixtureHelper = resolve('out/storage-test/StorageFixture.exe');
async function fixture() {
  const base = resolve('test-results'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'save-commit-')); const project = join(root, '项目 😀'); const privateRoot = join(root, 'private-store');
  await mkdir(project); await mkdir(privateRoot);
  const entry = join(project, '报告 😀.html'); await writeFile(entry, original);
  const candidatePath = join(root, 'candidate.bin'); await writeFile(candidatePath, expected);
  return { root, project, entry, privateRoot, candidatePath };
}
const native = (mode, entry) => {
  const r = spawnSync(fixtureHelper, [mode, entry], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr); assert.match(r.stdout.trim(), /^[0-9a-f]{64}$/u); return r.stdout.trim();
};
async function prepare(f, onStep = async () => {}) {
  const source = await openSaveSource(f.entry, original);
  const store = await createSavePreparationStore(f.privateRoot, onStep, await createWindowsReplacer(helperPath));
  const value = await store.prepare(source, candidate); assert.equal(value.status, 'prepared', value.code);
  return { source, store, value, folder: join(f.privateRoot, value.transactionId) };
}
const assertEvidence = async folder => {
  assert.deepEqual(await readFile(join(folder, 'backup.bin')), original);
  assert.deepEqual(await readFile(join(folder, 'candidate.bin')), expected);
};
async function released(entry) {
  for (let i = 0; i < 100; i++) {
    try { const handle = await open(entry, 'r+'); await handle.close(); return; }
    catch (error) { if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; await delay(20); }
  }
  assert.fail('Native helper still holds the source write guard');
}

test('explicit commit replaces verified bytes once, preserves ACL/creation/ADS, and leaves a verified committed journal', win, async () => {
  for (const acl of ['legacy', 'protected']) {
    const f = await fixture(); if (acl === 'protected') native('protect', f.entry);
    await writeFile(`${f.entry}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    await writeFile(`${f.entry}:附注`, Buffer.from('原有数据流 🧪'));
    const metadata = native('snapshot', f.entry); const before = await lstat(f.entry, { bigint: true });
    const { source, store, value, folder } = await prepare(f);
    const one = value.commit(); assert.equal(one, value.commit(), 'duplicate calls share one operation');
    const result = await one; assert.equal(result.status, 'committed', JSON.stringify(result)); assert.equal(result.cleanupPending, false);
    assert.deepEqual(await readFile(f.entry), expected); assert.notEqual((await lstat(f.entry, { bigint: true })).ino, before.ino);
    assert.equal(native('snapshot', f.entry), metadata, acl);
    assert.equal((await readFile(`${f.entry}:Zone.Identifier`)).toString(), '[ZoneTransfer]\r\nZoneId=3\r\n');
    assert.equal((await readFile(`${f.entry}:附注`)).toString(), '原有数据流 🧪');
    assert.deepEqual(await readdir(f.project), ['报告 😀.html']); await assertEvidence(folder);
    assert.equal((await store.inspect(value.transactionId, source.current)).state, 'committed-matches');
    const journal = JSON.parse(await readFile(join(folder, 'committed.json'), 'utf8')); assert.ok(isSaveCommit(journal));
    assert.equal(JSON.stringify(journal).includes(f.root), false); assert.equal((await store.scan()).locked, false);
    await assert.rejects(value.cancel(), /SAVE_REVIEW_REQUIRED/);
    const restarted = await createSavePreparationStore(f.privateRoot);
    assert.equal((await restarted.inspect(value.transactionId, source.current)).phase, 'committed');
    const nextSource = await openSaveSource(f.entry, expected);
    const nextStore = await createSavePreparationStore(f.privateRoot, async () => {}, await createWindowsReplacer(helperPath));
    const next = await nextStore.prepare(nextSource, { bytes: original, baseHash: digest(expected), resultHash: digest(original) });
    assert.equal(next.status, 'prepared', 'a fresh explicit transaction after a successful commit can acquire the lock');
    assert.equal((await next.commit()).status, 'committed'); assert.deepEqual(await readFile(f.entry), original);
    await writeFile(f.entry, expected); // Same bytes written externally still change the recorded version.
    assert.equal((await restarted.inspect(value.transactionId, source.current)).state, 'conflict');
  }
});

test('cancel and an absent platform adapter never create project sidecars or replace HTML', async () => {
  const f = await fixture(); const source = await openSaveSource(f.entry, original); const store = await createSavePreparationStore(f.privateRoot);
  const value = await store.prepare(source, candidate); assert.equal(value.status, 'prepared');
  assert.equal((await value.commit()).code, 'SAVE_PLATFORM_UNSUPPORTED'); await value.cancel();
  assert.equal((await value.commit()).code, 'SAVE_CANCELLED');
  assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readdir(f.project), ['报告 😀.html']);
});

test('external content/identity/parent changes and corrupted private evidence refuse commit without overwriting', win, async () => {
  for (const mode of ['content', 'identity', 'parent', 'backup', 'candidate', 'lock', 'temp-collision', 'backup-collision']) {
    const f = await fixture(); const { source, store, value, folder } = await prepare(f);
    let sourceBytes = original;
    if (mode === 'content') { sourceBytes = Buffer.from('external'); await writeFile(f.entry, sourceBytes); }
    if (mode === 'identity') { await rename(f.entry, join(f.project, 'prior.html')); await writeFile(f.entry, original); }
    if (mode === 'parent') { await rename(f.project, join(f.root, 'prior')); await mkdir(f.project); await writeFile(f.entry, original); }
    if (['backup', 'candidate'].includes(mode)) await writeFile(join(folder, `${mode}.bin`), 'corrupt');
    if (mode === 'lock') await writeFile(join(f.privateRoot, 'active.lock'), 'foreign lock');
    if (mode === 'temp-collision' || mode === 'backup-collision') await writeFile(join(f.project, `.hae-${value.transactionId}.${mode === 'temp-collision' ? 'tmp' : 'backup'}`), 'occupied');
    const result = await value.commit(); assert.equal(result.status, 'failed', `${mode}: ${JSON.stringify(result)}`);
    assert.deepEqual(await readFile(f.entry), sourceBytes, mode); assert.equal((await store.scan()).locked, true);
    await assert.rejects(value.cancel(), /SAVE_REVIEW_REQUIRED/);
    if (mode === 'temp-collision' || mode === 'backup-collision') assert.equal((await readFile(join(f.project, `.hae-${value.transactionId}.${mode === 'temp-collision' ? 'tmp' : 'backup'}`))).toString(), 'occupied');
    assert.notEqual((await store.inspect(value.transactionId, source.current)).phase, 'committed');
  }
});

test('actual Windows readonly, denied write ACL and another process holding a non-delete-sharing handle reject replacement', win, async () => {
  for (const mode of ['readonly', 'denied', 'locked']) {
    const f = await fixture(); let lock;
    if (mode === 'readonly') await chmod(f.entry, 0o444);
    if (mode === 'denied') native('deny-write', f.entry);
    if (mode === 'locked') {
      lock = spawn(fixtureHelper, ['lock', f.entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const [chunk] = await once(lock.stdout, 'data'); assert.equal(chunk.toString().trim(), 'ready');
    }
    try {
      const { value, folder } = await prepare(f); const result = await value.commit();
      assert.equal(result.status, 'failed', `${mode}: ${JSON.stringify(result)}`); assert.deepEqual(await readFile(f.entry), original); await assertEvidence(folder);
    } finally {
      if (lock) { lock.stdin.end('\n'); await once(lock, 'close'); }
      if (mode === 'readonly') await chmod(f.entry, 0o600);
      if (mode === 'denied') native('reset', f.entry);
    }
  }
});

test('pre-replace write/sync faults leave source bytes intact and retain private backup/candidate evidence', win, async () => {
  for (const stage of ['temp-created', 'temp-written', 'temp-synced', 'temp-verified', 'native-ready', 'replacing-created', 'replacing-synced']) {
    const f = await fixture(); const { value, folder } = await prepare(f, async step => {
      if (step === stage) throw Object.assign(new Error('DISK_FULL_TEST'), { code: 'ENOSPC' });
    });
    const result = await value.commit(); assert.equal(result.status, 'failed', `${stage}: ${JSON.stringify(result)}`);
    assert.deepEqual(await readFile(f.entry), original); await assertEvidence(folder); await released(f.entry);
  }
});

test('post-replace acknowledgement and commit journal faults return unknown, retain displaced original and block blind retry', win, async () => {
  for (const stage of ['native-replaced', 'committed-created', 'committed-written', 'committed-synced', 'committed-verified']) {
    const f = await fixture(); const { source, store, value, folder } = await prepare(f, async step => {
      if (step === stage) throw new Error('COMMIT_IO_TEST');
    });
    const result = await value.commit(); assert.equal(result.status, 'unknown', `${stage}: ${JSON.stringify(result)}`);
    assert.equal(await value.commit(), result); await assert.rejects(value.cancel(), /SAVE_REVIEW_REQUIRED/);
    assert.deepEqual(await readFile(f.entry), expected); await assertEvidence(folder);
    assert.deepEqual(await readFile(join(f.project, `.hae-${value.transactionId}.backup`)), original);
    assert.equal((await store.scan()).locked, true); await released(f.entry);
    const state = (await store.inspect(value.transactionId, source.current)).state;
    assert.ok(['candidate-on-disk', 'invalid', 'committed-matches'].includes(state), state);
  }
});

test('native handle guards block external writes and ancestor renames until Main has verified the commit', win, async () => {
  const f = await fixture(); let checked = 0;
  const { value } = await prepare(f, async stage => {
    if (stage !== 'native-ready' && stage !== 'native-replaced') return;
    await assert.rejects(writeFile(f.entry, 'outside overwrite'), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
    await assert.rejects(rename(f.project, join(f.root, 'outside rename')), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code)); checked++;
  });
  assert.equal((await value.commit()).status, 'committed'); assert.equal(checked, 2); assert.deepEqual(await readFile(f.entry), expected);
});

test('native final checks reject late temp/backup substitution and added candidate streams without overwriting another file', win, async () => {
  for (const mode of ['temp', 'backup', 'stream']) {
    const f = await fixture(); let id;
    const prepared = await prepare(f, async stage => {
      if (stage !== 'replacing-synced') return;
      const path = join(f.project, `.hae-${id}.${mode === 'backup' ? 'backup' : 'tmp'}`);
      if (mode === 'stream') await writeFile(`${path}:injected`, 'external stream');
      else { await rename(path, `${path}.previous`); await writeFile(path, 'foreign bytes', { flag: 'wx' }); }
    });
    id = prepared.value.transactionId;
    const result = await prepared.value.commit(); assert.equal(result.status, 'failed', `${mode}: ${JSON.stringify(result)}`);
    assert.deepEqual(await readFile(f.entry), original); await assertEvidence(prepared.folder); await released(f.entry);
    if (mode !== 'stream') assert.equal((await readFile(join(f.project, `.hae-${id}.${mode === 'backup' ? 'backup' : 'tmp'}`))).toString(), 'foreign bytes');
  }
});

test('completed commit with failed private lock cleanup remains committed and reports cleanup pending', win, async () => {
  const f = await fixture(); const { value, store, source } = await prepare(f, async stage => { if (stage === 'release-lock') throw new Error('LOCK_IO_TEST'); });
  const result = await value.commit(); assert.equal(result.status, 'committed'); assert.equal(result.cleanupPending, true); assert.equal(result.code, 'SAVE_CLEANUP_PENDING');
  assert.equal((await store.inspect(value.transactionId, source.current)).state, 'committed-matches'); assert.equal((await store.scan()).locked, true);
  assert.deepEqual(await readFile(f.entry), expected); assert.equal((await store.prepare(source, candidate)).code, 'SAVE_BUSY');
});

test('actual Main process SIGKILL before/after ReplaceFileW retains enough evidence for read-only restart classification', win, async () => {
  for (const stage of ['native-ready', 'replacing-synced', 'native-replaced', 'committed-synced']) {
    const f = await fixture(); const task = fork(resolve('tests/storage/commit-child.mjs'), [f.privateRoot, f.entry, f.candidatePath, stage],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; task.stderr.on('data', b => { stderr += b; }); let timer;
    try {
      const message = await Promise.race([once(task, 'message').then(([m]) => m), once(task, 'exit').then(([code]) => { throw new Error(`Child exit ${code}: ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child did not reach crash boundary')), 6000); })]);
      assert.deepEqual(message, { kind: 'paused', stage });
      const exit = once(task, 'exit'); task.kill('SIGKILL'); const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      await released(f.entry);
      const store = await createSavePreparationStore(f.privateRoot); const scan = await store.scan(); assert.equal(scan.locked, true); assert.equal(scan.records.length, 1);
      const source = await openSaveSource(f.entry, await readFile(f.entry)); const record = scan.records[0];
      const inspected = await store.inspect(record.transactionId, source.current); await assertEvidence(join(f.privateRoot, record.transactionId));
      const replaced = ['native-replaced', 'committed-synced'].includes(stage);
      assert.deepEqual(await readFile(f.entry), replaced ? expected : original);
      assert.equal(inspected.state, stage === 'committed-synced' ? 'committed-matches' : replaced ? 'candidate-on-disk' : 'baseline-matches');
      if (replaced) assert.deepEqual(await readFile(join(f.project, `.hae-${record.transactionId}.backup`)), original);
    } finally { clearTimeout(timer); if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL'); }
  }
});

test('restart inspection rejects forged/malformed committed seals and cancelled-plus-replacing histories', win, async () => {
  for (const mode of ['hash', 'identity', 'extra-field', 'cancelled']) {
    const f = await fixture(); const { source, store, value, folder } = await prepare(f); assert.equal((await value.commit()).status, 'committed');
    const path = join(folder, 'committed.json'); const commit = JSON.parse(await readFile(path, 'utf8'));
    if (mode === 'hash') commit.resultHash = 'b'.repeat(64);
    if (mode === 'identity') commit.identity.ino = '0';
    if (mode === 'extra-field') commit.path = f.entry;
    if (mode === 'cancelled') await writeFile(join(folder, 'cancelled.json'), JSON.stringify({ version: 1, transactionId: value.transactionId, intentHash: commit.intentHash, phase: 'cancelled' }));
    else await writeFile(path, JSON.stringify(commit));
    assert.equal((await store.inspect(value.transactionId, source.current)).state, 'invalid'); assert.deepEqual(await readFile(f.entry), expected);
  }
});
