import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareRecordCleanup } from '../../src/main/storage/record-cleanup.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { checkedDirectory, digest } from '../../src/platform/storage-files.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { draftOwnership } from '../../src/main/storage/draft-ownership.ts';
import { isCleanupManifest, CLEANUP_JOURNAL } from '../../src/contracts/record-cleanup.ts';
import { prepareSaveResolution } from '../../src/main/storage/resolve-save.ts';
import { createWindowsRecoveryGuard } from '../../src/platform/windows-recovery-guard.ts';
import { prepareCompactionResolution } from '../../src/main/storage/resolve-compaction.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><p>原段</p><!-- untouched --><script>const n=41</script>');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>B &lt;&amp;&gt; 🧪</h1><p>原段</p><!-- untouched --><script>const n=41</script>');
const noProfile = () => {}; // Product tests exercise real Electron profile ownership.
const options = { timeout: 120000 };
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results/record-cleanup-')); const privateRoot = join(root, 'private'); await mkdir(privateRoot);
  const entry = join(root, '报告 😀.html'); await writeFile(entry, original); await writeFile(join(root, 'keep.css'), 'h1{color:#123}');
  const source = await openSaveSource(entry, original); const sessionId = randomUUID();
  const h = createTextHistory(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const store = await createDraftCheckpointStore(privateRoot);
  const edit = value => {
    const node = h.source.nodes.find(node => node.parentTag === 'h1');
    h.commit(h.prepareEdit({ identity: h.source.identity, baseHash: h.source.baseHash, nodeId: node.nodeId,
      expectedText: h.textFor(node.nodeId), newText: value }));
  };
  const next = async value => { edit(value); return store.write(source, h.source, h.candidate, sessionId, h.revision, h.capture()); };
  return { root, privateRoot, entry, source, sessionId, h, store, edit, next };
}
async function snapshot(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) result[entry.name] = digest(await readFile(join(path, entry.name)));
    else for (const name of await readdir(join(path, entry.name))) result[entry.name + '/' + name] = digest(await readFile(join(path, entry.name, name)));
  }
  return result;
}
const prepare = (f, step) => prepareRecordCleanup(f.privateRoot, noProfile, step);
async function childAt(script, args, stage) {
  const child = fork(resolve(script), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; let timer; child.stderr.on('data', data => { errors += data; }); const exited = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw Error(errors || 'Early child exit'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Cleanup barrier timeout: ' + errors)), 15000); })]);
    assert.equal(message.stage, stage); return { stop };
  } catch (error) { await stop(); throw error; } finally { clearTimeout(timer); }
}

test('reviewed cleanup clears multiple full histories and backups, keeps retirement anchors last and leaves all project bytes unchanged', options, async () => {
  const f = await fixture(); const first = await f.next('first'); const second = await f.next('second');
  assert.equal((await f.store.retire(f.source, f.sessionId, f.h.revision, 'discarded')).status, 'retired');
  const other = randomUUID();
  assert.equal((await f.store.write(f.source, f.h.source, f.h.candidate, other, f.h.revision, f.h.capture())).status, 'persisted');
  const saves = await createSavePreparationStore(f.privateRoot);
  const save = await saves.prepare(f.source, f.h.candidate); assert.equal(save.status, 'prepared'); await save.cancel();
  const before = await snapshot(f.privateRoot); const cancelled = await prepare(f);
  assert.equal(cancelled.summary.records, 4); assert.equal(cancelled.summary.sessions, 2); assert.equal(cancelled.summary.unsavedDrafts, 1);
  assert.equal(cancelled.summary.backups, 1); assert.ok(cancelled.summary.bytes > 0); assert.equal(cancelled.summary.resuming, false);
  assert.equal(cancelled.cancel(), true); assert.deepEqual(await snapshot(f.privateRoot), before);
  let removals = 0;
  const plan = await prepare(f, async step => {
    if (step !== 'cleanup-after-remove') return;
    removals++;
    const names = await readdir(f.privateRoot);
    if (!names.includes(second.checkpointId)) assert.equal(names.includes(first.checkpointId), false, 'retirement anchor must outlive older points');
    assert.deepEqual(await readFile(f.entry), original);
  });
  const one = plan.commit(); assert.equal(plan.cancel(), false); assert.equal(plan.commit(), one);
  assert.deepEqual(await one, { status: 'cleared', code: null }); assert.ok(removals > 10);
  assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), original);
  assert.equal(await readFile(join(f.root, 'keep.css'), 'utf8'), 'h1{color:#123}');
  assert.deepEqual((await f.store.catalog()).groups, []); assert.deepEqual((await saves.scan()).records, []);
  const empty = await prepare(f); assert.equal(empty.summary.records, 0); assert.equal((await empty.commit()).status, 'cleared');
  assert.deepEqual(await readdir(f.privateRoot), []);
});

test('full per-target backup quota is actually reclaimed, allowing a new native Windows Save after explicit cleanup', { ...options, skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); f.edit('B <&> 🧪');
  const saves = await createSavePreparationStore(f.privateRoot, undefined, await createWindowsReplacer(resolve('out/native/ReplaceHelper.exe')));
  for (let i = 0; i < 20; i++) { const value = await saves.prepare(f.source, f.h.candidate); assert.equal(value.status, 'prepared', value.code); await value.cancel(); }
  assert.equal((await saves.prepare(f.source, f.h.candidate)).code, 'BACKUP_LIMIT');
  const plan = await prepare(f); assert.equal(plan.summary.backups, 20); assert.equal(plan.summary.records, 20);
  assert.equal((await plan.commit()).status, 'cleared'); assert.deepEqual(await readFile(f.entry), original);
  const value = await saves.prepare(f.source, f.h.candidate); assert.equal(value.status, 'prepared', value.code);
  assert.equal((await value.commit()).status, 'committed'); assert.deepEqual(await readFile(f.entry), expected);
});

test('active ownership and changed approved bytes refuse cleanup before writes; the durable journal blocks ordinary persistence and Save', options, async () => {
  const f = await fixture(); const point = await f.next('B');
  const release = f.store.claimSession(f.sessionId);
  await assert.rejects(prepare(f), /DRAFT_STORAGE_ACTIVE/); release();
  await assert.rejects(prepareRecordCleanup(f.privateRoot, noProfile, undefined, []), /RECORD_CLEANUP_ROOT_MISMATCH/);
  const root = await checkedDirectory(f.privateRoot); const owned = draftOwnership(root.identityChain.map(row => row.dev + ':' + row.ino).join('/'));
  const finish = owned.claimOperation(); await assert.rejects(prepare(f), /DRAFT_STORAGE_ACTIVE/); finish();
  await assert.rejects(prepareRecordCleanup(f.privateRoot, () => { throw Error('DRAFT_PROFILE_IN_USE'); }), /DRAFT_PROFILE_IN_USE/);
  const plan = await prepare(f); const path = join(f.privateRoot, point.checkpointId, 'baseline.bin');
  await writeFile(path, original); const before = await snapshot(f.privateRoot);
  assert.equal((await plan.commit()).status, 'failed'); assert.deepEqual(await snapshot(f.privateRoot), before);
  const held = await prepare(f, async step => {
    if (step !== 'cleanup-journal-ready') return;
    await assert.rejects(f.store.catalog());
    const saves = await createSavePreparationStore(f.privateRoot);
    assert.equal((await saves.prepare(f.source, f.h.candidate)).status, 'failed');
    assert.equal((await f.store.write(f.source, f.h.source, f.h.candidate, randomUUID(), f.h.revision, f.h.capture())).status, 'failed');
    assert.throws(() => f.store.claimSession(randomUUID()), /MAINTENANCE/);
  });
  assert.equal((await held.commit()).status, 'cleared'); assert.deepEqual(await readFile(f.entry), original);
});

test('real process termination leaves an exact deletion suffix; restart prepare/cancel are read-only and fresh confirmation resumes it', options, async () => {
  for (const stage of ['cleanup-journal-ready', 'cleanup-after-remove', 'cleanup-before-finish']) {
    const f = await fixture(); await f.next('B'); await f.next('C');
    const child = await childAt('tests/storage/record-cleanup-child.mjs', [f.privateRoot, stage], stage); await child.stop();
    const before = await snapshot(f.privateRoot); assert.ok(before[CLEANUP_JOURNAL]);
    const manifest = JSON.parse(await readFile(join(f.privateRoot, CLEANUP_JOURNAL), 'utf8')); assert.equal(isCleanupManifest(manifest), true);
    assert.equal(isCleanupManifest({ ...manifest, folders: [{ ...manifest.folders[0], id: '../project' }, ...manifest.folders.slice(1)] }), false);
    const cancel = await prepare(f); assert.equal(cancel.summary.resuming, true); assert.equal(cancel.cancel(), true);
    assert.deepEqual(await snapshot(f.privateRoot), before);
    assert.equal((await (await prepare(f)).commit()).status, 'cleared'); assert.deepEqual(await readdir(f.privateRoot), []);
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('partial manifests, deletion gaps, rewritten evidence, swapped directories, unrelated files and foreign locks remain intact and blocked', options, async () => {
  for (const mode of ['torn', 'gap', 'rewrite', 'directory', 'foreign-file', 'foreign-lock']) {
    const f = await fixture(); await f.next('B'); await f.next('C');
    const stage = mode === 'torn' ? 'cleanup-journal-created' : 'cleanup-journal-ready';
    const plan = await prepare(f, async step => { if (step === stage) throw Error('injected stop'); });
    assert.equal((await plan.commit()).status, 'unknown');
    if (mode !== 'torn') {
      const manifest = JSON.parse(await readFile(join(f.privateRoot, CLEANUP_JOURNAL), 'utf8')); const row = manifest.folders[0];
      if (mode === 'gap') await unlink(join(f.privateRoot, row.id, row.files[1].name));
      if (mode === 'rewrite') { const path = join(f.privateRoot, row.id, row.files[0].name); await writeFile(path, await readFile(path)); }
      if (mode === 'directory') { const path = join(f.privateRoot, row.id); const held = join(f.root, 'held'); await rename(path, held); await mkdir(path); }
      if (mode === 'foreign-file') await writeFile(join(f.privateRoot, 'keep.txt'), 'not a cleanup target');
      if (mode === 'foreign-lock') await writeFile(join(f.privateRoot, 'active.lock'), '{}');
    }
    const before = await snapshot(f.privateRoot); await assert.rejects(prepare(f)); assert.deepEqual(await snapshot(f.privateRoot), before);
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('incomplete points, corrupt superseded histories and older conflicting revisions cannot be silently deleted to regain capacity', options, async () => {
  for (const mode of ['incomplete', 'corrupt-old', 'ambiguous-old']) {
    const f = await fixture(); const first = await f.next('B'); await f.next('C');
    if (mode === 'incomplete') await mkdir(join(f.privateRoot, randomUUID()));
    if (mode === 'corrupt-old') await writeFile(join(f.privateRoot, first.checkpointId, 'origin.bin'), 'corrupt');
    if (mode === 'ambiguous-old') {
      const h = createTextHistory(original, { projectId: 'other', documentId: randomUUID(), generation: 1 }, digest); const node = h.source.nodes.find(row => row.parentTag === 'h1');
      h.commit(h.prepareEdit({ identity: h.source.identity, baseHash: h.source.baseHash, nodeId: node.nodeId, expectedText: node.decodedText, newText: 'conflict' }));
      const point = await f.store.write(f.source, h.source, h.candidate, randomUUID(), h.revision, h.capture());
      assert.equal(point.status, 'persisted');
      const path = join(f.privateRoot, point.checkpointId); const record = JSON.parse(await readFile(join(path, 'record.json'), 'utf8'));
      const bytes = Buffer.from(JSON.stringify({ ...record, sessionId: f.sessionId }) + '\n');
      await writeFile(join(path, 'record.json'), bytes);
      await writeFile(join(path, 'complete.json'), JSON.stringify({ version: 1, checkpointId: point.checkpointId, recordHash: digest(bytes) }) + '\n');
    }
    const before = await snapshot(f.privateRoot); await assert.rejects(prepare(f)); assert.deepEqual(await snapshot(f.privateRoot), before);
  }
});

test('completed explicit Save resolution anchors are removed only after their original transactions, including abandoned preparations', { ...options, skip: process.platform !== 'win32' }, async () => {
  for (const stage of ['backup-created', 'prepared-synced']) {
    const f = await fixture(); f.edit('B <&> 🧪'); const candidate = join(f.root, 'candidate.html'); await writeFile(candidate, expected);
    const child = await childAt('tests/storage/commit-child.mjs', [f.privateRoot, f.entry, candidate, stage], stage); await child.stop();
    const guard = await createWindowsRecoveryGuard(resolve('out/native/ReplaceHelper.exe'));
    const resolution = await prepareSaveResolution(f.privateRoot, f.source, noProfile, guard);
    assert.equal((await resolution.commit('keep-current')).status, 'resolved');
    const manifestSnapshots = [];
    const plan = await prepare(f, async step => {
      if (step === 'cleanup-after-remove') {
        const names = await readdir(f.privateRoot);
        if (names.some(name => /^[a-f0-9]{8}-/.test(name))) assert.ok(names.some(name => /^save-resolution-.*\.complete\.json$/.test(name)));
        manifestSnapshots.push(names);
      }
    });
    assert.equal((await plan.commit()).status, 'cleared'); assert.ok(manifestSnapshots.length);
    assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), original);
  }
});

test('completed compaction resolution anchors survive every original record until full cleanup is verified', options, async () => {
  const f = await fixture(); await f.next('B'); await f.next('C');
  const release = f.store.claimSession(f.sessionId);
  const interrupted = await createDraftCheckpointStore(f.privateRoot, async step => {
    if (step === 'compaction-after-origin.bin') throw Error('injected compaction interruption');
  });
  f.edit('D');
  const latest = await interrupted.write(f.source, f.h.source, f.h.candidate, f.sessionId, f.h.revision, f.h.capture());
  assert.equal(latest.status, 'persisted'); assert.equal(latest.cleanupPending, true); release();
  const resolution = await prepareCompactionResolution(f.privateRoot, f.source, noProfile);
  assert.equal((await resolution.commit()).status, 'resolved');
  const before = await snapshot(f.privateRoot);
  const receipts = Object.keys(before).filter(name => /^compaction-[a-f0-9-]+(?:\.complete)?\.json$/u.test(name)); assert.equal(receipts.length, 2);
  const plan = await prepare(f, async step => {
    if (step !== 'cleanup-after-remove') return;
    const names = await readdir(f.privateRoot);
    if (names.some(name => /^[a-f0-9]{8}-/.test(name))) for (const receipt of receipts) assert.ok(names.includes(receipt));
  });
  assert.equal(plan.summary.records, 2); assert.equal((await plan.commit()).status, 'cleared');
  assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), original);
});

test('a late completion warning does not undo verified removal, and cleanup never rewrites an externally changed source', options, async () => {
  const f = await fixture(); await f.next('B'); const external = Buffer.from('external changed source');
  const plan = await prepare(f, async step => { if (step === 'cleanup-finished') throw Error('late callback'); });
  await writeFile(f.entry, external);
  assert.deepEqual(await plan.commit(), { status: 'cleared', code: 'RECORD_CLEANUP_CONFIRMED_WITH_WARNING' });
  assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), external);
});
