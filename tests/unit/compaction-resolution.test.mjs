import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { prepareCompactionResolution } from '../../src/main/storage/resolve-compaction.ts';
import { readCompactionResolutions } from '../../src/main/storage/compaction-resolutions.ts';
import { draftOwnership } from '../../src/main/storage/draft-ownership.ts';
import { checkedDirectory, digest } from '../../src/platform/storage-files.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { isCompactionResolution, resolutionFile } from '../../src/contracts/compaction-resolution.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<html><body><h1>A &#38; 😀</h1><p>原样</p><!-- literal --></body></html>');
const noProfile = () => {}; // Lower-level storage tests; actual Electron guard is tested separately.
async function fixture(stage = 'compaction-after-origin.bin') {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results/compaction-resolution-')); const privateRoot = join(root, 'private'); await mkdir(privateRoot);
  const entry = join(root, 'report.html'); await writeFile(entry, original); const source = await openSaveSource(entry, original);
  const store = await createDraftCheckpointStore(privateRoot, async step => { if (stage && step === stage) throw Error('test compaction interrupted'); });
  const sessionId = randomUUID(); const history = createTextHistory(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const next = async text => {
    const node = history.source.nodes.find(node => node.parentTag === 'h1');
    history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash, nodeId: node.nodeId,
      expectedText: history.textFor(node.nodeId), newText: text }));
    return store.write(source, history.source, history.candidate, sessionId, history.revision, history.capture());
  };
  await next('B'); await next('C');
  if (stage) {
    const release = store.claimSession(sessionId);
    try { const result = await next('D <&> 🧪'); assert.equal(result.status, 'persisted'); assert.equal(result.cleanupPending, true); }
    finally { release(); }
    stage = null;
  }
  return { root, privateRoot, entry, source, store, sessionId, history, next };
}
async function snapshot(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) result[entry.name] = digest(await readFile(join(root, entry.name)));
    else for (const file of await readdir(join(root, entry.name))) result[`${entry.name}/${file}`] = digest(await readFile(join(root, entry.name, file)));
  }
  return result;
}

test('explicit compaction resolution preserves the retained bytes and history, seals its receipt, releases the matching lock and permits subsequent draft/save work', { timeout: 60000 }, async () => {
  for (const stage of ['compaction-ready', 'compaction-after-origin.bin', 'compaction-after-directory']) {
    const f = await fixture(stage); const before = await snapshot(f.privateRoot);
    const journal = JSON.parse(await readFile(join(f.privateRoot, 'compaction.json'), 'utf8'));
    const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile);
    assert.deepEqual(await snapshot(f.privateRoot), before); assert.equal(plan.summary.draftRevision, f.history.revision);
    const committing = plan.commit(); assert.equal(plan.commit(), committing); assert.equal(plan.cancel(), false);
    assert.deepEqual(await committing, { status: 'resolved', code: null });
    const after = await snapshot(f.privateRoot);
    for (const [name, hash] of Object.entries(before)) if (journal.retained.some(point => name.startsWith(`${point.checkpointId}/`))) assert.equal(after[name], hash);
    const names = await readdir(f.privateRoot); assert.ok(!names.includes('active.lock')); assert.ok(!names.includes('compaction.json'));
    const rows = await readCompactionResolutions(await checkedDirectory(f.privateRoot), names);
    assert.equal(rows.length, 1); assert.ok(rows[0].seal); assert.ok(isCompactionResolution(rows[0].record));
    assert.equal((await f.store.catalog()).reviewRequired, false);
    assert.deepEqual((await f.store.restoreLatest(f.sessionId, f.source, f.history.source)).bytes, f.history.candidate.bytes);
    assert.deepEqual(await readFile(f.entry), original);
    // A successful resolution is not a second compaction trigger or a save.
    const resumed = await createDraftCheckpointStore(f.privateRoot); const release = resumed.claimSession(f.sessionId);
    try { const result = await f.next('E'); assert.equal(result.status, 'persisted'); assert.equal(result.cleanupPending, false); }
    finally { release(); }
    const saves = await createSavePreparationStore(f.privateRoot);
    assert.equal((await saves.scan()).unrecognized, false);
    const prepared = await saves.prepare(f.source, f.history.candidate); assert.equal(prepared.status, 'prepared', prepared.code); await prepared.cancel();
    assert.deepEqual(await readFile(f.entry), original);
  }
});

test('a prepared review freezes namespace allocation, cancellation writes nothing, and source/journal/lock changes invalidate confirmation', async () => {
  const f = await fixture(); const before = await snapshot(f.privateRoot);
  const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile);
  assert.throws(() => f.store.claimSession(randomUUID()), /DRAFT_STORAGE_MAINTENANCE/);
  assert.equal((await f.store.write(f.source, f.history.source, f.history.candidate, f.sessionId, f.history.revision, f.history.capture())).code, 'DRAFT_STORAGE_MAINTENANCE');
  const saves = await createSavePreparationStore(f.privateRoot);
  assert.equal((await saves.prepare(f.source, f.history.candidate)).code, 'STORAGE_MAINTENANCE');
  assert.equal(plan.cancel(), true); assert.equal((await plan.commit()).status, 'failed');
  assert.deepEqual(await snapshot(f.privateRoot), before);
  for (const target of ['source', 'journal', 'lock']) {
    const sample = await fixture(); const review = await prepareCompactionResolution(sample.privateRoot, sample.source, noProfile);
    const path = target === 'source' ? sample.entry : join(sample.privateRoot, target === 'lock' ? 'active.lock' : 'compaction.json');
    await writeFile(path, await readFile(path)); // Same-byte rewrite must still invalidate its captured version.
    const changed = await snapshot(sample.privateRoot); assert.equal((await review.commit()).status, 'failed');
    assert.deepEqual(await snapshot(sample.privateRoot), changed); assert.deepEqual(await readFile(sample.entry), original);
  }
});

test('actual active document, checkpoint I/O and prepared save ownership prevent a maintenance claim until their work has ended', async () => {
  const f = await fixture(); const release = f.store.claimSession(f.sessionId);
  await assert.rejects(prepareCompactionResolution(f.privateRoot, f.source, noProfile), /DRAFT_STORAGE_ACTIVE/); release();
  const clean = await fixture(null); let enter; let finish;
  const entered = new Promise(resolve => { enter = resolve; }); const held = new Promise(resolve => { finish = resolve; });
  const writer = await createDraftCheckpointStore(clean.privateRoot, async step => { if (step === 'lock-created') { enter(); await held; } });
  const writing = writer.write(clean.source, clean.history.source, clean.history.candidate, randomUUID(), clean.history.revision, clean.history.capture());
  await entered;
  await assert.rejects(prepareCompactionResolution(clean.privateRoot, clean.source, noProfile), /DRAFT_STORAGE_ACTIVE/);
  finish(); assert.equal((await writing).status, 'persisted');
  const saves = await createSavePreparationStore(clean.privateRoot); const prepared = await saves.prepare(clean.source, clean.history.candidate);
  assert.equal(prepared.status, 'prepared');
  await assert.rejects(prepareCompactionResolution(clean.privateRoot, clean.source, noProfile), /DRAFT_STORAGE_ACTIVE/);
  await prepared.cancel();
  let retiredEnter; let retireFinish;
  const retireEntered = new Promise(resolve => { retiredEnter = resolve; }); const retireHeld = new Promise(resolve => { retireFinish = resolve; });
  const retirer = await createDraftCheckpointStore(clean.privateRoot, async step => { if (step === 'lock-created') { retiredEnter(); await retireHeld; } });
  const retiring = retirer.retire(clean.source, clean.sessionId, clean.history.revision, 'discarded'); await retireEntered;
  await assert.rejects(prepareCompactionResolution(clean.privateRoot, clean.source, noProfile), /DRAFT_STORAGE_ACTIVE/);
  retireFinish(); assert.equal((await retiring).status, 'retired');
  const root = await checkedDirectory(clean.privateRoot);
  draftOwnership(root.identityChain.map(value => `${value.dev}:${value.ino}`).join('/')).claimMaintenance()();
});

test('a failed resolution can be explicitly prepared again from its durable receipt, including after the original journal was removed', { timeout: 60000 }, async () => {
  for (const stage of ['recovery-record-ready', 'recovery-before-baseline.bin', 'recovery-after-baseline.bin',
    'recovery-after-directory', 'recovery-complete-ready', 'recovery-after-journal']) {
    const f = await fixture();
    const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile, async step => { if (step === stage) throw Error('test resolution interrupted'); });
    assert.equal((await plan.commit()).status, 'unknown', stage); assert.ok((await readdir(f.privateRoot)).includes('active.lock'));
    assert.deepEqual(await readFile(f.entry), original);
    const resumed = await prepareCompactionResolution(f.privateRoot, f.source, noProfile);
    assert.equal((await resumed.commit()).status, 'resolved', stage);
    assert.equal((await f.store.catalog()).locked, false); assert.equal((await f.store.catalog()).reviewRequired, false);
    assert.deepEqual((await f.store.restoreLatest(f.sessionId, f.source, f.history.source)).bytes, f.history.candidate.bytes);
  }
  const finished = await fixture();
  const late = await prepareCompactionResolution(finished.privateRoot, finished.source, noProfile,
    async step => { if (step === 'recovery-after-lock') throw Error('test late acknowledgement failure'); });
  assert.deepEqual(await late.commit(), { status: 'resolved', code: 'DRAFT_COMPACTION_RECOVERY_CONFIRMED_WITH_WARNING' });
  assert.equal((await finished.store.catalog()).locked, false);
});

test('corrupt completed receipts block further writes and a checkpoint lock without matching compaction evidence is never a generic unlock request', async () => {
  const f = await fixture(); const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile);
  assert.equal((await plan.commit()).status, 'resolved');
  const name = (await readdir(f.privateRoot)).find(name => resolutionFile(name) && !resolutionFile(name).complete);
  const receipt = JSON.parse(await readFile(join(f.privateRoot, name), 'utf8'));
  await writeFile(join(f.privateRoot, name), JSON.stringify({ ...receipt, force: true }));
  const before = await snapshot(f.privateRoot);
  await assert.rejects(f.store.catalog()); assert.equal((await f.next('E')).status, 'failed');
  const saves = await createSavePreparationStore(f.privateRoot); assert.equal((await saves.prepare(f.source, f.history.candidate)).status, 'failed');
  assert.deepEqual(await snapshot(f.privateRoot), before); assert.deepEqual(await readFile(f.entry), original);
  const missing = await fixture(null);
  await writeFile(join(missing.privateRoot, 'active.lock'), JSON.stringify({ version: 1, checkpointId: randomUUID() }));
  const evidence = await snapshot(missing.privateRoot);
  await assert.rejects(prepareCompactionResolution(missing.privateRoot, missing.source, noProfile), /DRAFT_COMPACTION_RECOVERY_UNAVAILABLE/);
  assert.deepEqual(await snapshot(missing.privateRoot), evidence);
});

test('torn resolution records or seals and substituted obsolete directories retain all remaining evidence and cannot be overwritten on retry', async () => {
  for (const stage of ['recovery-record-created', 'recovery-complete-created']) {
    const f = await fixture(); const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile,
      async step => { if (step === stage) throw Error('test torn resolution'); });
    assert.equal((await plan.commit()).status, 'unknown'); const before = await snapshot(f.privateRoot);
    await assert.rejects(prepareCompactionResolution(f.privateRoot, f.source, noProfile));
    assert.deepEqual(await snapshot(f.privateRoot), before); assert.deepEqual(await readFile(f.entry), original);
  }
  const f = await fixture(); const journal = JSON.parse(await readFile(join(f.privateRoot, 'compaction.json'), 'utf8'));
  const victim = join(f.privateRoot, journal.obsolete[0].checkpointId); let moved = false;
  const plan = await prepareCompactionResolution(f.privateRoot, f.source, noProfile, async step => {
    if (step === 'recovery-before-baseline.bin' && !moved) {
      moved = true; await rename(victim, join(f.root, 'preserved-old-point')); await mkdir(victim);
      await writeFile(join(victim, 'unrelated.txt'), 'preserve');
    }
  });
  assert.equal((await plan.commit()).status, 'unknown'); assert.equal(await readFile(join(victim, 'unrelated.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readFile(f.entry), original);
});

test('process interruption before/after journal removal resumes only after an explicit decision; after lock removal normal history recovery works', { timeout: 60000 }, async () => {
  for (const stage of ['recovery-record-ready', 'recovery-after-journal', 'recovery-after-lock']) {
    const f = await fixture(); const child = fork(resolve('tests/storage/resolution-child.mjs'), [f.privateRoot, f.entry, stage],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr.on('data', value => { diagnostics += String(value); }); const exited = once(child, 'exit'); let timer;
    try {
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw Error(diagnostics || 'Early child exit'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Resolution child timeout')), 12000); })]);
      assert.equal(message.stage, stage); child.kill('SIGKILL'); await exited;
      const before = await snapshot(f.privateRoot); const reopened = await createDraftCheckpointStore(f.privateRoot);
      const catalog = await reopened.catalog(); assert.deepEqual(await snapshot(f.privateRoot), before);
      assert.equal(catalog.locked, stage !== 'recovery-after-lock');
      if (catalog.locked) {
        await assert.rejects(reopened.restoreLatest(f.sessionId, f.source, f.history.source), /DRAFT_STORAGE_LOCKED/);
        assert.equal((await (await prepareCompactionResolution(f.privateRoot, f.source, noProfile)).commit()).status, 'resolved');
      }
      assert.deepEqual((await reopened.restoreLatest(f.sessionId, f.source, f.history.source)).bytes, f.history.candidate.bytes);
      assert.equal((await readdir(f.privateRoot)).filter(name => resolutionFile(name)).length, 2);
      assert.deepEqual(await readFile(f.entry), original);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
  }
});
