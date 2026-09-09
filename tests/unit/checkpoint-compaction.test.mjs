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
import { openSaveSource } from '../../src/platform/save-source.ts';
import { checkedDirectory, digest } from '../../src/platform/storage-files.ts';
import { checkpointRemoval } from '../../src/platform/checkpoint-removal.ts';
import { isCheckpointCompaction } from '../../src/contracts/checkpoint-compaction.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"></head><body><h1>A &#38; 😀</h1><p>保留</p><!-- literal --></body></html>');
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results/checkpoint-compaction-')); const privateRoot = join(root, 'private'); await mkdir(privateRoot);
  const entry = join(root, 'report.html'); await writeFile(entry, original);
  const source = await openSaveSource(entry, original); const sessionId = randomUUID();
  const h = createTextHistory(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const control = { step: async () => {} }; const store = await createDraftCheckpointStore(privateRoot, step => control.step(step));
  const next = async text => {
    const node = h.source.nodes.find(node => node.parentTag === 'h1');
    h.commit(h.prepareEdit({ identity: h.source.identity, baseHash: h.source.baseHash, nodeId: node.nodeId,
      expectedText: h.textFor(node.nodeId), newText: text }));
    return store.write(source, h.source, h.candidate, sessionId, h.revision, h.capture());
  };
  return { root, privateRoot, entry, source, sessionId, h, control, store, next };
}
const snapshot = async path => Object.fromEntries(await Promise.all((await readdir(path)).map(async name => [name, digest(await readFile(join(path, name)))])));

// Forty-eight complete, synced writes run alongside the other filesystem suites.
// Keep a bounded stress-test budget without changing production I/O/IPC limits.
test('an owned v2 session exceeds the old twenty-record ceiling while retaining the latest two complete revisions and all logical history', { timeout: 120000 }, async () => {
  const f = await fixture(); const release = f.store.claimSession(f.sessionId); const ids = [];
  try {
    for (let index = 0; index < 48; index++) {
      const result = await f.next(`第 ${index} 次 <&> 🧪`); assert.equal(result.status, 'persisted', result.code); assert.equal(result.cleanupPending, false);
      ids.push(result.checkpointId); assert.equal((await readdir(f.privateRoot)).length, Math.min(2, index + 1));
    }
    const names = await readdir(f.privateRoot); assert.deepEqual(names.sort(), ids.slice(-2).sort());
    const restored = await f.store.restoreLatest(f.sessionId, f.source, f.h.source);
    assert.deepEqual(restored.bytes, f.h.candidate.bytes); assert.equal(f.h.summary().undoCount, 48);
    const checkpoint = await f.store.readLatestHistory(f.sessionId, f.source);
    const history = createTextHistory(original, { projectId: 'fresh', documentId: randomUUID(), generation: 2 }, digest, checkpoint);
    for (let index = 0; index < 48; index++) history.commit(history.prepareMove('undo'));
    assert.deepEqual(Buffer.from(history.candidate.bytes), original); assert.equal(history.summary().redoCount, 48);
    for (let index = 0; index < 48; index++) history.commit(history.prepareMove('redo'));
    assert.deepEqual(history.candidate.bytes, restored.bytes); assert.equal(history.summary().undoCount, 48);
    assert.deepEqual(await readFile(f.entry), original); assert.equal((await f.store.catalog()).reviewRequired, false);
  } finally { release(); }
});

test('compaction never removes another session, a retirement anchor, save backup or incomplete attempt', async () => {
  const f = await fixture(); const first = await f.next('B'); const second = await f.next('C');
  const terminalId = randomUUID(); const terminal = await f.store.write(f.source, f.h.source, f.h.candidate, terminalId, f.h.revision, f.h.capture());
  assert.equal((await f.store.retire(f.source, terminalId, f.h.revision, 'discarded')).status, 'retired');
  const terminalBytes = await snapshot(join(f.privateRoot, terminal.checkpointId));
  const saves = await createSavePreparationStore(f.privateRoot); const prepared = await saves.prepare(f.source, f.h.candidate);
  assert.equal(prepared.status, 'prepared'); await prepared.cancel(); const saveBytes = await snapshot(join(f.privateRoot, prepared.transactionId));
  f.control.step = async step => { if (step === 'baseline-written') throw Error('test interrupted checkpoint'); };
  const failed = await f.next('D'); assert.equal(failed.status, 'failed'); const failureBytes = await snapshot(join(f.privateRoot, failed.checkpointId));
  f.control.step = async () => {}; const release = f.store.claimSession(f.sessionId);
  try {
    assert.equal((await f.next('E')).status, 'persisted'); assert.equal((await f.next('F')).status, 'persisted');
    assert.equal((await f.store.inspect(first.checkpointId)).phase, 'incomplete');
    assert.equal((await f.store.inspect(second.checkpointId)).phase, 'incomplete');
    assert.deepEqual(await snapshot(join(f.privateRoot, terminal.checkpointId)), terminalBytes);
    assert.deepEqual(await snapshot(join(f.privateRoot, prepared.transactionId)), saveBytes);
    assert.deepEqual(await snapshot(join(f.privateRoot, failed.checkpointId)), failureBytes);
    assert.equal((await f.store.catalog()).groups.find(row => row.sessionId === terminalId).status, 'retired');
    assert.deepEqual(await readFile(f.entry), original);
  } finally { release(); }
});

test('taking ownership of an existing full sequence can safely reclaim obsolete complete points before a new write needs capacity', async () => {
  const f = await fixture();
  for (let index = 0; index < 20; index++) assert.equal((await f.next(`旧 ${index}`)).status, 'persisted');
  assert.equal((await readdir(f.privateRoot)).length, 20); const release = f.store.claimSession(f.sessionId);
  try {
    const result = await f.next('接着编辑'); assert.equal(result.status, 'persisted', result.code); assert.equal(result.cleanupPending, false);
    assert.equal((await readdir(f.privateRoot)).length, 2); assert.deepEqual(await readFile(f.entry), original);
  } finally { release(); }
});

test('conflicting complete records at an older revision remain as ambiguity evidence even after newer unambiguous points exist', async () => {
  const f = await fixture(); const first = await f.next('B');
  const other = createTextHistory(original, { projectId: randomUUID(), documentId: randomUUID(), generation: 1 }, digest);
  const node = other.source.nodes.find(node => node.parentTag === 'h1');
  other.commit(other.prepareEdit({ identity: other.source.identity, baseHash: other.source.baseHash,
    nodeId: node.nodeId, expectedText: node.decodedText, newText: '另一分支' }));
  const different = await f.store.write(f.source, other.source, other.candidate, randomUUID(), other.revision, other.capture());
  const folder = join(f.privateRoot, different.checkpointId); const record = JSON.parse(await readFile(join(folder, 'record.json'), 'utf8'));
  const bytes = Buffer.from(`${JSON.stringify({ ...record, sessionId: f.sessionId })}\n`);
  await writeFile(join(folder, 'record.json'), bytes);
  await writeFile(join(folder, 'complete.json'), JSON.stringify({ version: 1, checkpointId: different.checkpointId, recordHash: digest(bytes) }));
  const evidence = await snapshot(folder); await f.next('C'); const release = f.store.claimSession(f.sessionId);
  try {
    assert.equal((await f.next('D')).status, 'persisted'); assert.equal((await f.next('E')).status, 'persisted');
    assert.equal((await f.store.inspect(first.checkpointId)).phase, 'complete');
    assert.deepEqual(await snapshot(folder), evidence); assert.equal((await readdir(f.privateRoot)).length, 4);
    assert.deepEqual(await readFile(f.entry), original);
  } finally { release(); }
});

test('compaction failures preserve the latest confirmed durability result, both retained checkpoints, the journal and the lock', { timeout: 60000 }, async () => {
  for (const stage of ['compaction-created', 'compaction-verified', 'compaction-ready', 'compaction-before-origin.bin',
    'compaction-after-origin.bin', 'compaction-after-record.json', 'compaction-after-directory', 'compaction-before-journal']) {
    const f = await fixture(); await f.next('B'); const previous = await f.next('C'); const kept = await snapshot(join(f.privateRoot, previous.checkpointId));
    const release = f.store.claimSession(f.sessionId);
    try {
      f.control.step = async step => { if (step === stage) throw Error('test compaction interruption'); };
      const latest = await f.next('D'); assert.equal(latest.status, 'persisted', stage); assert.equal(latest.cleanupPending, true, stage);
      assert.equal(latest.code, 'DRAFT_COMPACTION_UNKNOWN');
      assert.deepEqual(await snapshot(join(f.privateRoot, previous.checkpointId)), kept);
      assert.equal((await f.store.inspect(latest.checkpointId)).phase, 'complete');
      const names = await readdir(f.privateRoot); assert.ok(names.includes('active.lock')); assert.ok(names.includes('compaction.json'));
      const state = await f.store.catalog(); assert.equal(state.locked, true); assert.equal(state.reviewRequired, true);
      await assert.rejects(f.store.restoreLatest(f.sessionId, f.source, f.h.source), /DRAFT_STORAGE_LOCKED/);
      const again = await f.store.write(f.source, f.h.source, f.h.candidate, f.sessionId, f.h.revision, f.h.capture());
      assert.equal(again.status, 'failed'); assert.equal(again.code, 'DRAFT_STORAGE_LOCKED');
      assert.deepEqual(await readFile(f.entry), original);
    } finally { release(); }
  }
});

test('replacement of an obsolete file or directory is detected before removal and never changes unrelated files', async () => {
  for (const mode of ['file', 'directory']) {
    const f = await fixture(); const first = await f.next('B'); await f.next('C');
    const victim = join(f.privateRoot, first.checkpointId); const release = f.store.claimSession(f.sessionId);
    let changed = false;
    try {
      f.control.step = async step => {
        if (step !== 'compaction-before-origin.bin' || changed) return; changed = true;
        if (mode === 'file') await writeFile(join(victim, 'origin.bin'), await readFile(join(victim, 'origin.bin')));
        else {
          await rename(victim, join(f.root, 'retained-obsolete'));
          await mkdir(victim); await writeFile(join(victim, 'unrelated.txt'), 'preserve');
        }
      };
      const result = await f.next('D'); assert.equal(changed, true); assert.equal(result.status, 'persisted'); assert.equal(result.cleanupPending, true);
      assert.equal((await f.store.inspect(result.checkpointId)).phase, 'complete');
      if (mode === 'file') assert.equal((await readdir(victim)).length, 4);
      else assert.equal(await readFile(join(victim, 'unrelated.txt'), 'utf8'), 'preserve');
      assert.deepEqual(await readFile(f.entry), original);
    } finally { release(); }
  }
});

test('journal schema and platform deletion reject forged paths, changed bindings, wrong directories and any HTML filename', async () => {
  const f = await fixture(); const first = await f.next('B'); await f.next('C'); const release = f.store.claimSession(f.sessionId);
  try {
    f.control.step = async step => { if (step === 'compaction-ready') throw Error('hold journal'); };
    await f.next('D'); const journal = JSON.parse(await readFile(join(f.privateRoot, 'compaction.json'), 'utf8'));
    assert.ok(isCheckpointCompaction(journal));
    for (const forged of [{ ...journal, extra: true }, { ...journal, obsolete: [{ ...journal.obsolete[0], checkpointId: '../report.html' }] },
      { ...journal, retained: [journal.retained[0], journal.retained[0]] },
      { ...journal, obsolete: [{ ...journal.obsolete[0], recordHash: '0'.repeat(64) }] }]) assert.equal(isCheckpointCompaction(forged), false);
    const root = await checkedDirectory(f.privateRoot); const removal = checkpointRemoval(root); const item = journal.obsolete[0];
    await assert.rejects(removal.file(first.checkpointId, item.directory, { ...item.files[0], name: 'report.html' }, async () => {}), /DRAFT_COMPACTION_INVALID/);
    await assert.rejects(removal.file(first.checkpointId, { ...item.directory, ino: '1' }, item.files[0], async () => {}), /DRAFT_COMPACTION_CHANGED/);
    assert.deepEqual(await readFile(f.entry), original);
  } finally { release(); }
});

test('a process killed during compaction leaves a verified retained pair and bounded intent, and restart never automatically resumes deletion or unlocks', { timeout: 30000 }, async () => {
  for (const stage of ['compaction-ready', 'compaction-after-origin.bin', 'compaction-after-directory']) {
    const f = await fixture(); const child = fork(resolve('tests/storage/compaction-child.mjs'), [f.privateRoot, f.entry, stage],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr.on('data', value => { diagnostics += String(value); });
    const exited = once(child, 'exit'); let timer;
    try {
      const message = await Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => { throw Error(diagnostics || 'Early child exit'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Compaction child timeout')), 8000); })]);
      assert.equal(message.stage, stage); child.kill('SIGKILL'); await exited;
      const journal = JSON.parse(await readFile(join(f.privateRoot, 'compaction.json'), 'utf8')); assert.ok(isCheckpointCompaction(journal));
      const reopened = await createDraftCheckpointStore(f.privateRoot);
      for (const point of journal.retained) {
        const value = await reopened.inspect(point.checkpointId); assert.equal(value.phase, 'complete'); assert.equal(value.recordHash, point.recordHash);
        assert.deepEqual(await readFile(join(f.privateRoot, point.checkpointId, 'origin.bin')), original);
      }
      const before = await readdir(f.privateRoot); const catalog = await reopened.catalog();
      assert.equal(catalog.locked, true); assert.equal(catalog.reviewRequired, true);
      await assert.rejects(reopened.restoreLatest(message.sessionId, f.source, f.h.source), /DRAFT_STORAGE_LOCKED/);
      const saves = await createSavePreparationStore(f.privateRoot); assert.equal((await saves.scan()).locked, true);
      assert.deepEqual(await readdir(f.privateRoot), before); assert.deepEqual(await readFile(f.entry), original);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
  }
});
