import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { prepareSaveResolution } from '../../src/main/storage/resolve-save.ts';
import { readSaveResolutions } from '../../src/main/storage/save-resolutions.ts';
import { checkedDirectory, digest } from '../../src/platform/storage-files.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { createWindowsRecoveryGuard } from '../../src/platform/windows-recovery-guard.ts';
import { isSaveResolution, saveResolutionFile } from '../../src/contracts/save-resolution.ts';

const win = { skip: process.platform !== 'win32', timeout: 60000 };
const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>原文 &amp; 😀</h1><p>保持</p><!-- literal -->');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>修订 &lt;&amp;&gt; 🧪</h1><p>保持</p><!-- literal -->');
const helper = resolve('out/native/ReplaceHelper.exe');
const noProfile = () => {}; // Actual profile ownership is separately tested in Electron.
async function childAt(script, args, stage) {
  const child = fork(resolve(script), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; let timer; child.stderr.on('data', chunk => { errors += chunk; }); const exited = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw Error(errors || 'Early child exit'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Save recovery barrier timeout: ${errors}`)), 12000); })]);
    assert.equal(message.stage, stage); return { stop };
  } catch (error) { await stop(); throw error; } finally { clearTimeout(timer); }
}
async function fixture(stage = 'prepared-synced', keepAlive = false) {
  await mkdir(resolve('test-results'), { recursive: true }); const root = await mkdtemp(resolve('test-results/save-resolution-'));
  const project = join(root, 'project'); const privateRoot = join(root, 'private'); await mkdir(project); await mkdir(privateRoot);
  const entry = join(project, 'report.html'); const candidate = join(root, 'candidate.html'); await writeFile(entry, original); await writeFile(candidate, expected);
  await writeFile(join(project, 'keep.css'), 'h1{color:#123}');
  const child = await childAt('tests/storage/commit-child.mjs', [privateRoot, entry, candidate, stage], stage);
  if (!keepAlive) await child.stop();
  const source = await openSaveSource(entry, await readFile(entry)); const guard = await createWindowsRecoveryGuard(helper);
  if (!keepAlive) {
    // A killed Main's native child may still be processing EOF. Read-only probes
    // wait for its real handles; no resolution or Save is retried automatically.
    let available = false; const end = Date.now() + 5000;
    while (Date.now() < end) {
      try { await guard(source, randomUUID(), async () => {}); available = true; break; } catch { await delay(25); }
    }
    assert.ok(available, 'native child handles must close before resolution testing');
  }
  const lock = JSON.parse(await readFile(join(privateRoot, 'active.lock'), 'utf8'));
  return { root, project, privateRoot, entry, source, guard, child, id: lock.transactionId };
}
async function snapshot(root) {
  const files = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isFile()) files[item.name] = digest(await readFile(join(root, item.name)));
    else for (const name of await readdir(join(root, item.name))) files[`${item.name}/${name}`] = digest(await readFile(join(root, item.name, name)));
  }
  return files;
}
const prepare = (f, step) => prepareSaveResolution(f.privateRoot, f.source, noProfile, f.guard, step);

test('explicit keep-current resolves real interrupted prepared, replacing and committed transactions without replay or losing their backups', win, async () => {
  for (const stage of ['prepared-synced', 'replacing-synced', 'native-replaced', 'committed-synced']) {
    const f = await fixture(stage); const before = await snapshot(f.privateRoot); const html = await readFile(f.entry);
    const plan = await prepare(f); assert.deepEqual(await snapshot(f.privateRoot), before);
    assert.equal(plan.summary.observed, stage === 'committed-synced' ? 'committed-matches' : stage === 'native-replaced' ? 'candidate-on-disk' : 'baseline-matches');
    assert.throws(() => plan.commit('force'), /SAVE_RECOVERY_DECISION_REQUIRED/);
    const committing = plan.commit('keep-current'); assert.equal(plan.commit('keep-current'), committing); assert.equal(plan.cancel(), false);
    const result = await committing; assert.equal(result.status, 'resolved', result.code); assert.equal(result.observed, plan.summary.observed);
    const after = await snapshot(f.privateRoot);
    for (const [name, hash] of Object.entries(before)) if (name !== 'active.lock') assert.equal(after[name], hash);
    assert.equal(after['active.lock'], undefined); assert.deepEqual(await readFile(f.entry), html);
    const rows = await readSaveResolutions(await checkedDirectory(f.privateRoot), await readdir(f.privateRoot));
    assert.equal(rows.length, 1); assert.ok(rows[0].seal); assert.ok(isSaveResolution(rows[0].record));
    const store = await createSavePreparationStore(f.privateRoot, undefined, await createWindowsReplacer(helper));
    assert.equal((await store.scan()).unrecognized, false); assert.equal((await store.inspect(f.id, f.source.current)).state, plan.summary.observed);
    assert.equal((await (await createDraftCheckpointStore(f.privateRoot)).catalog()).reviewRequired, false);
    if (stage === 'native-replaced' || stage === 'committed-synced') {
      const restoration = await store.prepareRestore(f.source, f.id); assert.equal(restoration.status, 'prepared', restoration.code);
      assert.deepEqual(await readFile(join(f.privateRoot, restoration.transactionId, 'backup.bin')), expected);
      assert.equal((await restoration.commit()).status, 'committed'); assert.deepEqual(await readFile(f.entry), original);
    } else {
      const next = await store.prepare(f.source, { bytes: expected, baseHash: digest(original), resultHash: digest(expected) });
      assert.equal(next.status, 'prepared', next.code); await next.cancel(); assert.deepEqual(await readFile(f.entry), original);
    }
    assert.equal(await readFile(join(f.project, 'keep.css'), 'utf8'), 'h1{color:#123}');
  }
});

test('read-only native guard refuses a live pre-replacement helper and pins the authorized file against writing and renaming', win, async () => {
  const f = await fixture('native-ready', true);
  try {
    const plan = await prepare(f); const before = await snapshot(f.privateRoot); const result = await plan.commit('keep-current');
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'SAVE_RECOVERY_FILE_BUSY_OR_CHANGED');
    assert.deepEqual(await snapshot(f.privateRoot), before); assert.deepEqual(await readFile(f.entry), original);
  } finally { await f.child.stop(); }
  const sample = await fixture();
  const names = await readdir(sample.project);
  await sample.guard(sample.source, randomUUID(), async live => {
    live(); await assert.rejects(open(sample.entry, 'r+')); await assert.rejects(rename(sample.entry, join(sample.project, 'moved.html')));
    assert.deepEqual(await readFile(sample.entry), original); assert.deepEqual(await readdir(sample.project), names);
  });
  const writable = await open(sample.entry, 'r+'); await writable.close();
});

test('cancellation writes nothing; active documents/saves and namespace maintenance exclude each other, and captured source/evidence rewrites invalidate confirmation', win, async () => {
  const f = await fixture(); const drafts = await createDraftCheckpointStore(f.privateRoot); const release = drafts.claimSession(randomUUID());
  await assert.rejects(prepare(f), /DRAFT_STORAGE_ACTIVE/); release();
  const before = await snapshot(f.privateRoot); const plan = await prepare(f);
  assert.throws(() => drafts.claimSession(randomUUID()), /DRAFT_STORAGE_MAINTENANCE/);
  const store = await createSavePreparationStore(f.privateRoot);
  assert.equal((await store.prepare(f.source, { bytes: expected, baseHash: digest(original), resultHash: digest(expected) })).code, 'STORAGE_MAINTENANCE');
  assert.equal(plan.cancel(), true); assert.equal((await plan.commit('keep-current')).status, 'failed'); assert.deepEqual(await snapshot(f.privateRoot), before);
  for (const target of ['source', 'active.lock', 'backup.bin', 'intent.json']) {
    const sample = await fixture(); const review = await prepare(sample);
    const path = target === 'source' ? sample.entry : join(sample.privateRoot, ...(target === 'active.lock' ? [] : [sample.id]), target);
    await writeFile(path, await readFile(path)); const changed = await snapshot(sample.privateRoot);
    assert.equal((await review.commit('keep-current')).status, 'failed'); assert.deepEqual(await snapshot(sample.privateRoot), changed);
  }
});

test('accepting an external current file preserves conflict/unknown status and does not manufacture commit evidence or replay old drafts', win, async () => {
  const f = await fixture('native-replaced'); const external = Buffer.from('<!doctype html><h1>External change</h1>');
  await writeFile(f.entry, external); f.source = await openSaveSource(f.entry, external);
  const plan = await prepare(f); assert.equal(plan.summary.observed, 'conflict'); assert.equal((await plan.commit('keep-current')).status, 'resolved');
  assert.deepEqual(await readFile(f.entry), external); assert.ok(!(await readdir(join(f.privateRoot, f.id))).includes('committed.json'));
  const store = await createSavePreparationStore(f.privateRoot, undefined, await createWindowsReplacer(helper));
  assert.equal((await store.inspect(f.id, f.source.current)).state, 'conflict');
  const restored = await store.prepareRestore(f.source, f.id); assert.equal(restored.status, 'prepared', restored.code);
  assert.deepEqual(await readFile(join(f.privateRoot, restored.transactionId, 'backup.bin')), external);
  await restored.cancel(); assert.deepEqual(await readFile(f.entry), external);
});

test('interrupted durable decisions require a fresh explicit review, while partial/corrupt evidence and a substituted lock remain blocked', win, async () => {
  for (const stage of ['save-recovery-record-ready', 'save-recovery-complete-ready']) {
    const f = await fixture(); const plan = await prepare(f, async step => { if (step === stage) throw Error('test recovery interrupted'); });
    assert.equal((await plan.commit('keep-current')).status, 'unknown');
    assert.equal((await (await prepare(f)).commit('keep-current')).status, 'resolved');
  }
  for (const stage of ['save-recovery-record-created', 'save-recovery-complete-created']) {
    const f = await fixture(); const plan = await prepare(f, async step => { if (step === stage) throw Error('test torn record'); });
    assert.equal((await plan.commit('keep-current')).status, 'unknown'); const before = await snapshot(f.privateRoot);
    await assert.rejects(prepare(f)); assert.deepEqual(await snapshot(f.privateRoot), before);
  }
  const changed = await fixture(); const plan = await prepare(changed, async step => {
    if (step === 'save-recovery-before-lock') await writeFile(join(changed.privateRoot, 'active.lock'), await readFile(join(changed.privateRoot, 'active.lock')));
  });
  assert.equal((await plan.commit('keep-current')).status, 'unknown'); const evidence = await snapshot(changed.privateRoot);
  await assert.rejects(prepare(changed)); assert.deepEqual(await snapshot(changed.privateRoot), evidence);
  const corrupt = await fixture(); assert.equal((await (await prepare(corrupt)).commit('keep-current')).status, 'resolved');
  const name = (await readdir(corrupt.privateRoot)).find(name => saveResolutionFile(name) && !saveResolutionFile(name).complete);
  const record = JSON.parse(await readFile(join(corrupt.privateRoot, name), 'utf8'));
  await writeFile(join(corrupt.privateRoot, name), JSON.stringify({ ...record, decision: 'force' }));
  const before = await snapshot(corrupt.privateRoot); const store = await createSavePreparationStore(corrupt.privateRoot);
  await assert.rejects(store.scan()); await assert.rejects((await createDraftCheckpointStore(corrupt.privateRoot)).catalog());
  assert.equal((await store.prepare(corrupt.source, { bytes: expected, baseHash: digest(original), resultHash: digest(expected) })).status, 'failed');
  assert.deepEqual(await snapshot(corrupt.privateRoot), before);
});

test('real process termination during decision/after lock removal keeps transaction evidence and never retries the native Save', win, async () => {
  for (const stage of ['save-recovery-record-ready', 'save-recovery-complete-ready', 'save-recovery-after-lock']) {
    const f = await fixture(); const child = await childAt('tests/storage/save-resolution-child.mjs', [f.privateRoot, f.entry, stage], stage); await child.stop();
    const before = await snapshot(f.privateRoot); const store = await createSavePreparationStore(f.privateRoot); const scan = await store.scan();
    assert.deepEqual(await snapshot(f.privateRoot), before); assert.equal(scan.locked, stage !== 'save-recovery-after-lock');
    if (scan.locked) assert.equal((await (await prepare(f)).commit('keep-current')).status, 'resolved');
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(join(f.privateRoot, f.id, 'candidate.bin')), expected);
  }
});

test('unknown lock shapes and incomplete/mixed transactions cannot authorize release; confirmed decisions keep their result after a late callback failure', win, async () => {
  for (const mode of ['checkpoint-lock', 'extra-lock-field', 'unknown-file', 'partial-backup', 'wrong-target']) {
    const f = await fixture();
    if (mode === 'checkpoint-lock') await writeFile(join(f.privateRoot, 'active.lock'), JSON.stringify({ version: 1, checkpointId: randomUUID() }));
    if (mode === 'extra-lock-field') await writeFile(join(f.privateRoot, 'active.lock'), JSON.stringify({ version: 1, transactionId: f.id, targetKey: f.source.targetKey, force: true }));
    if (mode === 'unknown-file') await writeFile(join(f.privateRoot, f.id, 'unrelated.txt'), 'preserve');
    if (mode === 'partial-backup') await writeFile(join(f.privateRoot, f.id, 'backup.bin'), 'partial');
    if (mode === 'wrong-target') {
      const other = join(f.project, 'other.html'); await writeFile(other, original); f.source = await openSaveSource(other, original);
    }
    const before = await snapshot(f.privateRoot); await assert.rejects(prepare(f));
    assert.deepEqual(await snapshot(f.privateRoot), before); assert.deepEqual(await readFile(f.entry), original);
  }
  const late = await fixture(); const plan = await prepare(late, async step => {
    if (step === 'save-recovery-after-lock') throw Error('test late callback failure');
  });
  assert.deepEqual(await plan.commit('keep-current'), { status: 'resolved', observed: 'baseline-matches', code: 'SAVE_RECOVERY_CONFIRMED_WITH_WARNING' });
  assert.equal((await (await createSavePreparationStore(late.privateRoot)).scan()).locked, false);
});
