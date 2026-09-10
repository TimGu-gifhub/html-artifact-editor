import { proofreadSnapshot } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RestoreReference } from '../../src/contracts/save-record.ts';
import type { WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import type { Fixture } from './main.ts';

type Checks = Readonly<{
  use: (run: (f: Fixture) => Promise<void>, persistDrafts?: boolean) => Promise<void>;
  until: (check: () => boolean, label: string) => Promise<void>;
  barrier: () => { wait: Promise<void>; release: () => void };
  pass: (label: string) => void; original: Buffer; expected: Buffer; css: Buffer;
}>;
export async function checkBackupRestore({ use, until, barrier, pass, original, expected, css }: Checks): Promise<void> {
  const list = (f: Fixture) => f.call(`haeWorkspace.listBackups(${JSON.stringify(f.current().id)})`);
  const restore = async (f: Fixture, reference: RestoreReference) => {
    const state = await f.read();
    return f.call(`haeWorkspace.restoreBackup(${JSON.stringify(state.current!.id)},${state.stateRevision},${JSON.stringify(reference)})`);
  };
  const seed = async (f: Fixture): Promise<RestoreReference> => {
    assert.deepEqual((await list(f)).backups!.entries, []);
    await f.dirty(); assert.equal((await f.save()).outcome, 'saved'); await f.current().persistence?.settle();
    const catalog = await list(f); assert.ok(catalog.ok, catalog.code ?? 'catalog failed');
    assert.equal(catalog.backups!.entries.length, 1); return catalog.backups!.entries[0]!.reference;
  };
  const approve = (f: Fixture) => { f.control.reviewBackup = async value => ({ reviewId: value.reviewId, decision: 'restore' }); };
  const resources = async (f: Fixture) => assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const files = await readdir(f.privateRoot);
    const catalog = (await list(f)).backups!;
    assert.equal(catalog.documentId, before.id); assert.equal(catalog.locked, false); assert.equal(catalog.reviewRequired, false);
    assert.deepEqual(Object.keys(catalog).sort(), ['documentId', 'entries', 'locked', 'reviewRequired']);
    assert.deepEqual(Object.keys(catalog.entries[0]!).sort(), ['createdAt', 'hash', 'reference', 'size']);
    assert.equal(catalog.entries[0]!.size, original.length); assert.deepEqual(await readdir(f.privateRoot), files);
    let reviews = 0;
    f.control.reviewBackup = async value => {
      reviews++; assert.equal(value.documentId, before.id); assert.equal(value.currentHash, before.saveSource.baseHash);
      assert.deepEqual(value.backup.reference, reference); assert.deepEqual(await readdir(f.privateRoot), files);
      assert.deepEqual(await readFile(f.entry), expected); return { reviewId: value.reviewId, decision: 'restore' };
    };
    const result = await restore(f, reference);
    assert.ok(result.ok, result.code ?? 'restore failed'); assert.equal(result.outcome, 'backup-restored'); assert.equal(result.documentId, before.id);
    assert.notEqual(f.current().id, before.id); assert.equal(f.runtime.host.current, f.current().preview.view);
    assert.equal(proofreadSnapshot(result.state!).lastSave!.operation, 'backup-restore'); assert.equal(proofreadSnapshot(result.state!).lastSave!.requiresReview, false);
    assert.equal(proofreadSnapshot(result.state!).backupReview, null); assert.equal(proofreadSnapshot(result.state!).current!.input.changes.length, 0);
    assert.equal(proofreadSnapshot(result.state!).current!.input.history!.undoCount, 0); assert.equal(proofreadSnapshot(result.state!).current!.input.history!.redoCount, 0);
    assert.deepEqual(Buffer.from(f.current().saveSource.bytes), original); assert.deepEqual(await readFile(f.entry), original); await resources(f);
    assert.equal(await f.current().preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'A & 😀');
    const records = (await f.store.scan()).records; assert.equal(records.length, 2);
    const restored = records.find(row => row.intent!.version === 2)!; assert.equal(restored.phase, 'committed');
    assert.equal(restored.intent!.version, 2); if (restored.intent!.version !== 2) throw new Error('restore intent missing');
    assert.deepEqual(restored.intent!.restoreOf, reference);
    assert.deepEqual(await readFile(join(f.privateRoot, restored.transactionId, 'backup.bin')), expected);
    assert.deepEqual(await readFile(join(f.privateRoot, restored.transactionId, 'candidate.bin')), original);
    const unchangedId = f.current().id; const unchangedFiles = await readdir(f.privateRoot);
    assert.equal((await restore(f, reference)).outcome, 'unchanged'); assert.equal(f.current().id, unchangedId); assert.equal(reviews, 1);
    assert.deepEqual(await readdir(f.privateRoot), unchangedFiles);
    assert.equal((await f.call(`haeWorkspace.listBackups(${JSON.stringify(before.id)})`)).code, 'STALE_DOCUMENT');
    await f.dirty(); assert.equal((await f.save()).outcome, 'saved'); assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    pass('backup IPC exposes current-file metadata only; an explicit reviewed Windows restore preserves exact BOM/CRLF/entities/resources, records a reverse backup, installs fresh clean history and permits later Save');
  }, true);

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const files = await readdir(f.privateRoot); let reviews = 0;
    f.control.reviewBackup = async value => { reviews++; return { reviewId: value.reviewId, decision: 'restore' }; };
    const state = await f.read();
    for (const invalid of [{ ...reference, path: 'backup.bin' }, { ...reference, bytes: [] }, { ...reference, force: true }, { ...reference, intentHash: 'bad' }]) {
      assert.equal((await f.call(`haeWorkspace.restoreBackup(${JSON.stringify(before.id)},${state.stateRevision},${JSON.stringify(invalid)})`)).code, 'INVALID_WORKSPACE_REQUEST');
    }
    assert.equal((await f.call(`haeWorkspace.restoreBackup(${JSON.stringify(randomUUID())},${state.stateRevision},${JSON.stringify(reference)})`)).code, 'STALE_DOCUMENT');
    assert.equal((await f.call(`haeWorkspace.restoreBackup(${JSON.stringify(before.id)},1,${JSON.stringify(reference)})`)).code, 'STALE_WORKSPACE');
    await f.select('h1'); assert.ok((await f.change('组合输入', true)).ok);
    assert.equal((await restore(f, reference)).code, 'INPUT_COMPOSING');
    assert.ok((await f.change('未应用输入')).ok); assert.equal((await restore(f, reference)).code, 'UNAPPLIED_INPUT');
    await f.apply(); assert.equal((await restore(f, reference)).code, 'UNSAVED_CHANGES');
    assert.equal(reviews, 0); assert.equal(f.current(), before); assert.deepEqual(await readdir(f.privateRoot), files);
    assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    assert.deepEqual(await before.preview.contents.executeJavaScript('[typeof haeWorkspace, typeof require]'), ['undefined', 'undefined']);
    pass('real backup transport rejects path/byte/force payloads, stale document/revision, composing, unapplied input and dirty drafts before review or disk preparation; Preview has no restore API');
  });

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const files = await readdir(f.privateRoot);
    assert.equal((await restore(f, reference)).outcome, 'cancelled');
    f.control.reviewBackup = async () => ({ reviewId: randomUUID(), decision: 'restore' });
    assert.equal((await restore(f, reference)).code, 'STALE_DOCUMENT_REVIEW');
    await f.select('h1');
    f.control.reviewBackup = async value => {
      assert.ok((await f.change('确认期间的新文字')).ok); return { reviewId: value.reviewId, decision: 'restore' };
    };
    assert.equal((await restore(f, reference)).code, 'STALE_DOCUMENT_REVIEW');
    assert.equal(f.current(), before); assert.equal(before.input.snapshot().input!.text, '确认期间的新文字');
    assert.equal(before.input.snapshot().phase, 'idle'); assert.deepEqual(await readdir(f.privateRoot), files);
    assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    pass('cancelled, wrong-ID and late-input backup confirmations leave the original session, pending text and all file/evidence bytes intact');
  });

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const files = await readdir(f.privateRoot);
    f.control.reviewBackup = async value => {
      const path = join(f.privateRoot, reference.transactionId, 'backup.bin'); await writeFile(path, await readFile(path));
      return { reviewId: value.reviewId, decision: 'restore' };
    };
    const result = await restore(f, reference); assert.equal(result.code, 'BACKUP_RECORD_CHANGED');
    assert.equal(f.current(), before); assert.equal(before.input.snapshot().phase, 'idle'); assert.deepEqual(await readdir(f.privateRoot), files);
    assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    pass('a same-byte backup rewrite while confirmation is open invalidates its captured version before any restore transaction');
  });

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const files = await readdir(f.privateRoot);
    const outside = Buffer.from(expected.toString().replace('2025-01-01', '外部应用的修改'));
    f.control.reviewBackup = async value => {
      await writeFile(f.entry, outside); return { reviewId: value.reviewId, decision: 'restore' };
    };
    assert.equal((await restore(f, reference)).code, 'FILE_CHANGED'); assert.equal(f.current(), before);
    assert.equal(before.input.snapshot().phase, 'idle'); assert.deepEqual(await readdir(f.privateRoot), files);
    assert.deepEqual(await readFile(f.entry), outside); await resources(f);
    pass('current-file changes during backup review reject restoration and preserve the external version without generating new private transactions');
  });

  await use(async f => {
    const reference = await seed(f); const before = f.current(); const stop = barrier(); let waiting = false;
    f.control.reviewBackup = async value => { waiting = true; await stop.wait; return { reviewId: value.reviewId, decision: 'restore' }; };
    void restore(f, reference).catch(() => null); await until(() => waiting, 'backup confirmation');
    f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'backup review renderer lost');
    await until(() => proofreadSnapshot(f.runtime.workspace.snapshot()).phase === 'idle', 'revoked backup review settled');
    stop.release(); await f.runtime.reloadUI(); assert.equal(f.current(), before);
    assert.equal(before.input.snapshot().phase, 'idle'); assert.equal((await f.store.scan()).records.length, 1);
    assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    pass('renderer loss cancels a still-open backup confirmation without waiting for its dialog; a late approval cannot restore the file');
  });

  await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current(); const hold = barrier(); let writing = false;
    f.control.draftStep = async step => { if (step === 'baseline-synced' && !writing) { writing = true; await hold.wait; } };
    let pending: Promise<WorkspaceResult> | undefined;
    try {
      await f.select('h1'); assert.ok((await f.change('临时修改')).ok); await f.apply(); await until(() => writing, 'dirty point writing');
      assert.ok((await f.change('已修订 <&> 🧪')).ok); await f.apply(); assert.equal(before.input.snapshot().changes.length, 0);
      pending = restore(f, reference); await until(() => before.input.snapshot().phase === 'leaving', 'backup freeze before drain');
      assert.equal((await f.change('late')).code, 'INPUT_BUSY'); assert.equal((await f.save()).code, 'WORKSPACE_BUSY');
      f.ui.close(); await until(() => !f.runtime.closing && f.errors.at(-1) === 'WORKSPACE_BUSY', 'backup blocks native close');
      assert.equal(f.ui.isDestroyed(), false); assert.deepEqual(await readFile(f.entry), expected);
      assert.equal((await f.store.scan()).records.length, 1);
      hold.release(); assert.equal((await pending).outcome, 'backup-restored');
      assert.deepEqual(await readFile(f.entry), original); await resources(f);
    } finally { hold.release(); }
    pass('backup restoration freezes input and native close while draining the exact latest clean history checkpoint before acquiring the shared save lock');
  }, true);

  await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current();
    f.control.draftStep = async step => { if (step === 'baseline-synced') throw new Error('CHECKPOINT_TEST_FAILURE'); };
    await f.select('h1'); assert.ok((await f.change('临时修改')).ok); await f.apply(); await before.persistence!.settle();
    assert.ok((await f.change('已修订 <&> 🧪')).ok); await f.apply();
    assert.equal(before.input.snapshot().changes.length, 0);
    const result = await restore(f, reference); assert.equal(result.code, 'DRAFT_PERSISTENCE_REQUIRED');
    assert.equal(f.current(), before); assert.equal(before.input.snapshot().phase, 'idle'); assert.equal((await f.store.scan()).records.length, 1);
    assert.deepEqual(await readFile(f.entry), expected); await resources(f);
    pass('a failed latest return-to-baseline checkpoint blocks backup replacement and releases input without discarding history or recovery evidence');
  }, true);

  for (const stage of ['prepared-synced', 'native-replaced']) await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current(); const stop = barrier(); let waiting = false;
    f.control.step = async step => { if (step === stage) { waiting = true; await stop.wait; } };
    try {
      void restore(f, reference).catch(() => null); await until(() => waiting, `backup ${stage}`);
      f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'backup renderer revoked'); stop.release();
      await until(() => proofreadSnapshot(f.runtime.workspace.snapshot()).phase === 'idle', 'backup Main reconciliation');
      assert.equal(proofreadSnapshot(f.runtime.workspace.snapshot()).lastSave!.status, stage === 'prepared-synced' ? 'cancelled' : 'backup-restored');
      assert.deepEqual(await readFile(f.entry), stage === 'prepared-synced' ? expected : original);
      assert.equal((await f.store.scan()).locked, false); await f.runtime.reloadUI();
      if (stage === 'prepared-synced') { assert.equal(f.current(), before); assert.equal(before.input.snapshot().phase, 'idle'); }
      else assert.notEqual(f.current().id, before.id);
      await resources(f);
    } finally { stop.release(); }
    pass(`backup ${stage}: actual renderer crash cancels unstarted replacement or finishes the committed restoration and new baseline, without replay on reconnect`);
  });

  await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current();
    f.control.step = async step => { if (step === 'native-replaced') throw new Error('BACKUP_TEST_UNKNOWN'); };
    const result = await restore(f, reference); assert.equal(proofreadSnapshot(result.state!).lastSave!.status, 'unknown'); assert.equal(result.ok, false);
    assert.equal(f.current(), before); assert.equal(f.runtime.host.current, before.preview.view); assert.equal(before.input.snapshot().phase, 'leaving');
    assert.equal(proofreadSnapshot(result.state!).lastSave!.requiresReview, true); assert.equal((await f.store.scan()).locked, true);
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(Buffer.from(before.saveSource.bytes), expected);
    assert.equal((await restore(f, reference)).code, 'DOCUMENT_RECOVERY_REQUIRED'); assert.equal((await f.save()).code, 'DOCUMENT_RECOVERY_REQUIRED');
    await resources(f);
    pass('unknown backup replacement keeps the frozen old source/view plus native/private evidence and blocks a second restore or Save');
  });

  for (const failure of ['attachment', 'external-change']) await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current();
    const outside = Buffer.from(original.toString().replace('2025-01-01', '恢复后的外部改写'));
    if (failure === 'attachment') f.control.hostFault = 'detached';
    else f.control.step = async step => { if (step === 'release-lock') await writeFile(f.entry, outside); };
    const result = await restore(f, reference); assert.equal(result.outcome, 'rebase-required'); assert.equal(result.code, 'SAVE_REBASE_REQUIRED');
    assert.equal(f.current(), before); assert.equal(f.runtime.host.current, before.preview.view);
    assert.equal(before.input.snapshot().phase, 'leaving'); assert.equal(f.runtime.workspace.retainedSave!.status, 'committed');
    assert.equal((await restore(f, reference)).code, 'DOCUMENT_RECOVERY_REQUIRED');
    assert.deepEqual(await readFile(f.entry), failure === 'attachment' ? original : outside); await resources(f);
    pass(`backup ${failure}: committed file bytes are distinguished from an unrebuilt session, with old view/source retained and blind retry blocked`);
  });

  await use(async f => {
    const reference = await seed(f); approve(f); const before = f.current();
    f.control.step = async step => { if (step === 'release-lock') throw new Error('BACKUP_CLEANUP_TEST'); };
    const result = await restore(f, reference); assert.equal(result.ok, true); assert.equal(result.outcome, 'backup-restored');
    assert.notEqual(f.current().id, before.id); assert.equal(proofreadSnapshot(result.state!).lastSave!.cleanupPending, true);
    assert.equal(proofreadSnapshot(result.state!).lastSave!.code, 'SAVE_CLEANUP_PENDING'); assert.equal(proofreadSnapshot(result.state!).lastSave!.requiresReview, true);
    assert.equal((await restore(f, reference)).code, 'DOCUMENT_RECOVERY_REQUIRED'); assert.equal((await f.store.scan()).locked, true);
    assert.deepEqual(await readFile(f.entry), original); await resources(f);
    pass('a verified backup restore with failed private-lock cleanup reports success with a separate cleanup warning and blocks another replacement');
  });
}
