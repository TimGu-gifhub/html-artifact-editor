import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSaveIntent } from '../../src/contracts/save-record.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { digest } from '../../src/platform/storage-files.ts';

const win = { skip: process.platform !== 'win32', timeout: 30000 };
const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>原文 &amp; 😀</h1><!-- original bytes -->\r\n<script>const n=41</script>');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>修订 &lt;&amp;&gt; 🧪</h1><!-- original bytes -->\r\n<script>const n=41</script>');
const css = Buffer.from('h1{color:#234}');
const index = createSourceIndex(original, { projectId: 'p1', documentId: 'd1', generation: 1 }, digest);
const node = index.nodes.find(value => value.decodedText === '原文 & 😀');
const candidate = createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash,
  nodeId: node.nodeId, expectedText: node.decodedText, newText: '修订 <&> 🧪' });
assert.deepEqual(Buffer.from(candidate.bytes), expected);
const helper = resolve('out/native/ReplaceHelper.exe');
async function fixture(native = false) {
  const base = resolve('test-results'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'save-recovery-')); const project = join(root, '项目 🧪'); const privateRoot = join(root, 'private');
  await mkdir(project); await mkdir(privateRoot); const entry = join(project, '报告 😀.html');
  await writeFile(entry, original); await writeFile(join(project, 'keep.css'), css);
  const replacer = native ? await createWindowsReplacer(helper) : undefined;
  const store = await createSavePreparationStore(privateRoot, undefined, replacer);
  const prior = await store.prepare(await openSaveSource(entry, original), candidate); assert.equal(prior.status, 'prepared', prior.code);
  if (native) assert.equal((await prior.commit()).status, 'committed');
  else { await prior.cancel(); await writeFile(entry, expected); } // Explicit new current version for portable preparation checks.
  const source = await openSaveSource(entry, expected); const priorFolder = join(privateRoot, prior.transactionId);
  return { root, project, privateRoot, entry, source, prior, priorFolder, replacer };
}
const recordFolder = (f, value) => join(f.privateRoot, value.transactionId);
const retained = async (f, value) => {
  assert.deepEqual(await readFile(join(recordFolder(f, value), 'backup.bin')), expected, 'restoration backs up the current file first');
  assert.deepEqual(await readFile(join(recordFolder(f, value), 'candidate.bin')), original, 'restoration uses exact verified backup bytes');
  assert.deepEqual(await readFile(join(f.priorFolder, 'backup.bin')), original, 'original evidence remains');
  assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);
};
async function unlockedFile(entry) {
  for (let i = 0; i < 100; ++i) {
    try { const handle = await open(entry, 'r+'); await handle.close(); return; }
    catch (error) { if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; await delay(20); }
  }
  assert.fail('replacement helper still holds the file');
}

test('restoration journal schema retains v1 and admits only a bounded v2 backup reference without paths or self-links', async () => {
  const f = await fixture(); const old = f.prior.intent;
  assert.ok(isSaveIntent(old));
  const value = { ...old, transactionId: randomUUID(), version: 2, restoreOf: { transactionId: old.transactionId, intentHash: 'a'.repeat(64) } };
  assert.ok(isSaveIntent(value));
  for (const invalid of [{ ...value, version: 1 }, { ...value, version: 3 }, { ...value, restoreOf: null },
    { ...value, restoreOf: { ...value.restoreOf, path: 'outside.html' } },
    { ...value, restoreOf: { ...value.restoreOf, transactionId: value.transactionId } },
    { ...value, restoreOf: { ...value.restoreOf, intentHash: 'bad' } }, { ...value, force: true }]) assert.equal(isSaveIntent(invalid), false);
});

test('prepareRestore preserves current bytes and writes a new current backup, linked intent and exact original candidate; cancellation is zero HTML writes', async () => {
  const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot);
  const value = await store.prepareRestore(f.source, f.prior.transactionId); assert.equal(value.status, 'prepared', value.code);
  assert.equal(value.intent.version, 2); assert.equal(value.intent.oldHash, digest(expected)); assert.equal(value.intent.newHash, digest(original));
  assert.deepEqual(value.intent.restoreOf, { transactionId: f.prior.transactionId, intentHash: digest(await readFile(join(f.priorFolder, 'intent.json'))) });
  assert.ok(Object.isFrozen(value.intent.restoreOf)); assert.equal(JSON.stringify(value.intent).includes(f.root), false);
  assert.deepEqual(await readFile(f.entry), expected); await retained(f, value);
  assert.equal((await store.inspect(value.transactionId, f.source.current)).state, 'baseline-matches');
  assert.equal((await value.commit()).code, 'SAVE_PLATFORM_UNSUPPORTED');
  await value.cancel(); assert.deepEqual(await readFile(f.entry), expected); assert.equal((await store.scan()).locked, false);
});

test('backup restoration after an actual Windows save survives reopening the store and itself creates a restorable current-file backup', win, async () => {
  const f = await fixture(true); await writeFile(`${f.entry}:附注`, 'current metadata stream');
  f.source = await openSaveSource(f.entry, expected);
  const store = await createSavePreparationStore(f.privateRoot, undefined, f.replacer);
  const value = await store.prepareRestore(f.source, f.prior.transactionId); assert.equal(value.status, 'prepared', value.code);
  const promise = value.commit(); assert.equal(value.commit(), promise); assert.equal((await promise).status, 'committed');
  assert.deepEqual(await readFile(f.entry), original); assert.equal((await readFile(`${f.entry}:附注`)).toString(), 'current metadata stream');
  await retained(f, value); assert.equal((await store.scan()).locked, false);
  const restored = await openSaveSource(f.entry, original);
  assert.equal((await store.inspect(value.transactionId, restored.current)).state, 'committed-matches');
  const count = (await store.scan()).records.length;
  assert.equal((await store.prepareRestore(restored, f.prior.transactionId)).code, 'SAVE_NO_CHANGES');
  assert.equal((await store.scan()).records.length, count);
  const reverse = await store.prepareRestore(restored, value.transactionId); assert.equal(reverse.status, 'prepared');
  assert.equal((await reverse.commit()).status, 'committed'); assert.deepEqual(await readFile(f.entry), expected);
  assert.deepEqual(await readdir(f.project), ['keep.css', '报告 😀.html']);
});

test('wrong targets, missing/incomplete evidence and changed backup/candidate/seals reject restoration without source or new record writes', async () => {
  for (const mode of ['wrong-target', 'missing', 'backup', 'candidate', 'prepared', 'incomplete']) {
    const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot); let source = f.source; let id = f.prior.transactionId;
    if (mode === 'wrong-target') { const other = join(f.project, '另一文件.html'); await writeFile(other, expected); source = await openSaveSource(other, expected); }
    else if (mode === 'missing') id = randomUUID();
    else if (mode === 'incomplete') { id = randomUUID(); await mkdir(join(f.privateRoot, id)); }
    else await writeFile(join(f.priorFolder, `${mode === 'backup' || mode === 'candidate' ? `${mode}.bin` : 'prepared.json'}`), 'damaged');
    const before = await readdir(f.privateRoot); const result = await store.prepareRestore(source, id);
    assert.equal(result.status, 'failed', mode); assert.equal(result.code, mode === 'wrong-target' ? 'BACKUP_WRONG_TARGET' : 'BACKUP_RECORD_INVALID', mode);
    assert.deepEqual(await readFile(f.entry), expected); assert.deepEqual(await readdir(f.privateRoot), before);
  }
});

test('restoration binds backup bytes, record identity and directory before preparation and rechecks them before native replacement', win, async () => {
  for (const mode of ['backup-rewrite', 'intent-rewrite', 'directory-swap', 'late-backup']) {
    const f = await fixture(true); let onceChanged = false;
    const store = await createSavePreparationStore(f.privateRoot, async step => {
      if (mode === 'late-backup' && step === 'native-ready' && !onceChanged) { onceChanged = true; await writeFile(join(f.priorFolder, 'backup.bin'), original); }
    }, f.replacer);
    const value = await store.prepareRestore(f.source, f.prior.transactionId); assert.equal(value.status, 'prepared');
    if (mode === 'backup-rewrite') await writeFile(join(f.priorFolder, 'backup.bin'), original);
    if (mode === 'intent-rewrite') { const path = join(f.priorFolder, 'intent.json'); await writeFile(path, await readFile(path)); }
    if (mode === 'directory-swap') { await rename(f.priorFolder, join(f.root, 'old-evidence')); await mkdir(f.priorFolder); }
    const result = await value.commit(); assert.notEqual(result.status, 'committed', mode);
    assert.deepEqual(await readFile(f.entry), expected, mode); assert.equal((await store.scan()).locked, true);
    assert.equal(value.commit(), value.commit(), 'no repeat replacement'); await assert.rejects(value.cancel(), /SAVE_REVIEW_REQUIRED/);
  }
});

test('external current-file changes during restoration preparation retain the external bytes and reject the obsolete reviewed version', async () => {
  for (const bytes of [expected, Buffer.from('external current file')]) {
    const f = await fixture(); const store = await createSavePreparationStore(f.privateRoot, async step => {
      if (step === 'backup-synced') await writeFile(f.entry, bytes);
    });
    const result = await store.prepareRestore(f.source, f.prior.transactionId); assert.equal(result.code, 'FILE_CHANGED');
    assert.deepEqual(await readFile(f.entry), bytes); assert.deepEqual(await readFile(join(f.priorFolder, 'backup.bin')), original);
  }
});

test('pending restoration uses the existing global exclusion; a second store or ordinary Save cannot bypass it', async () => {
  const f = await fixture(); const first = await createSavePreparationStore(f.privateRoot);
  const value = await first.prepareRestore(f.source, f.prior.transactionId); assert.equal(value.status, 'prepared');
  assert.equal((await first.prepareRestore(f.source, f.prior.transactionId)).code, 'SAVE_BUSY');
  const second = await createSavePreparationStore(f.privateRoot);
  assert.equal((await second.prepareRestore(f.source, f.prior.transactionId)).code, 'SAVE_LOCKED');
  assert.equal((await second.prepare(f.source, { bytes: original, baseHash: digest(expected), resultHash: digest(original) })).code, 'SAVE_LOCKED');
  await value.cancel(); assert.deepEqual(await readFile(f.entry), expected);
});

test('restoration backup and native failures keep the current backup and never label uncertain restored bytes committed', win, async () => {
  for (const point of ['backup-created', 'backup-synced', 'candidate-synced', 'native-ready', 'native-replaced']) {
    const f = await fixture(true); const store = await createSavePreparationStore(f.privateRoot, async step => {
      if (step === point) throw Object.assign(new Error('injected recovery fault'), { code: 'ENOSPC' });
    }, f.replacer);
    const value = await store.prepareRestore(f.source, f.prior.transactionId);
    if (point.startsWith('native-')) {
      assert.equal(value.status, 'prepared'); const result = await value.commit();
      assert.equal(result.status, point === 'native-replaced' ? 'unknown' : 'failed'); await retained(f, value);
      assert.equal((await store.scan()).locked, true);
    } else assert.equal(value.status, 'failed');
    assert.deepEqual(await readFile(f.entry), point === 'native-replaced' ? original : expected);
    assert.deepEqual(await readFile(join(f.priorFolder, 'backup.bin')), original);
  }
});

test('actual Main SIGKILL during restoration leaves recoverable old/new bytes, linked records and retained locks without auto-replay', win, async () => {
  for (const stage of ['prepared-synced', 'native-replaced', 'committed-synced']) {
    const f = await fixture(true);
    const task = fork(resolve('tests/storage/recovery-child.mjs'), [f.privateRoot, f.entry, f.prior.transactionId, stage],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let errors = ''; let timer; task.stderr.on('data', chunk => { errors += chunk; });
    try {
      const message = await Promise.race([once(task, 'message').then(([value]) => value),
        once(task, 'exit').then(([code]) => { throw new Error(`early recovery exit ${code}: ${errors}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`recovery barrier timeout: ${errors}`)), 7000); })]).finally(() => clearTimeout(timer));
      assert.equal(message.stage, stage); const ended = once(task, 'exit'); task.kill('SIGKILL');
      const [code, signal] = await ended; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      await unlockedFile(f.entry);
      const current = stage === 'prepared-synced' ? expected : original; assert.deepEqual(await readFile(f.entry), current);
      const store = await createSavePreparationStore(f.privateRoot); const scan = await store.scan(); assert.equal(scan.locked, true);
      const record = scan.records.find(value => value.transactionId !== f.prior.transactionId); assert.ok(record);
      assert.equal(record.intent.version, 2); assert.equal(record.intent.restoreOf.transactionId, f.prior.transactionId);
      const source = await openSaveSource(f.entry, current); const checked = await store.inspect(record.transactionId, source.current);
      assert.equal(checked.state, stage === 'prepared-synced' ? 'baseline-matches' : stage === 'native-replaced' ? 'candidate-on-disk' : 'committed-matches');
      assert.equal((await store.prepareRestore(source, stage === 'prepared-synced' ? f.prior.transactionId : record.transactionId)).code, 'SAVE_LOCKED');
      await retained(f, record);
    } finally { if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL'); }
  }
});
