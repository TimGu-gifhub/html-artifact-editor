import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { createPersistentWorkspaceSession } from '../../src/main/workspace/persistent-session.ts';
import { fixture, editorWindow, ports, original, css, barrier, until } from './fixture.ts';

const [mode, profile, root, entry, recoveryId] = process.argv.slice(2);
if (!profile || !root || !entry || !['seed', 'compete', 'restore', 'close-commit'].includes(mode ?? '')) throw Error('Invalid startup test arguments');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile); app.on('before-quit', event => event.preventDefault());
void app.whenReady().then(async () => {
  const outputRoot = resolve(__dirname, '..');
  const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (mode === 'compete') {
    const window = await editorWindow(outputRoot, root);
    try { await assert.rejects(createPersistentWorkspaceSession(window, outputRoot, ports(window, root, entry)), /DRAFT_PROFILE_IN_USE/); }
    finally { window.destroy(); }
    report({ state: 'blocked' }); app.exit(0); return;
  }
  if (mode === 'close-commit') {
    const hold = barrier(); let committed = false;
    const f = await fixture(outputRoot, root, entry, { onStorageStep: async (kind, step) => {
      if (kind === 'save' && step === 'committed-synced') { committed = true; await hold.wait; }
    } });
    const blocked = await editorWindow(outputRoot, root);
    try {
      await f.open(); await f.select('h1'); assert.ok((await f.change('替换已完成，窗口已销毁')).ok); await f.apply();
      await f.current().persistence!.settle();
      const expected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '替换已完成，窗口已销毁'));
      const saving = f.runtime.workspace.save((await f.read()).stateRevision, f.current().id);
      await until(() => committed, 'committed journal before window destruction'); f.window.destroy();
      let complete = false; const disposal = f.runtime.dispose();
      const rejected = assert.rejects(disposal, /EDITOR_RUNTIME_CLEANUP_REQUIRED/).then(() => { complete = true; });
      await assert.rejects(createPersistentWorkspaceSession(blocked, outputRoot, ports(blocked, root, entry)), /EDITOR_RUNTIME_ACTIVE/);
      assert.equal(complete, false); assert.deepEqual(await readFile(entry), expected); hold.release();
      assert.equal((await saving).status, 'rebase-required'); await rejected;
      assert.equal(f.runtime.workspace.snapshot().lastSave!.requiresReview, true);
      assert.ok((await f.runtime.storage.saves.scan()).records.some(row => row.phase === 'committed'));
      await assert.rejects(createPersistentWorkspaceSession(blocked, outputRoot, ports(blocked, root, entry)), /EDITOR_RUNTIME_ACTIVE/);
      assert.deepEqual(await readFile(entry), expected); assert.deepEqual(await readFile(join(root, 'keep.css')), css);
    } finally { hold.release(); if (!f.window.isDestroyed()) f.window.destroy(); blocked.destroy(); }
    report({ state: 'commit-retained' }); app.exit(0); return;
  }
  const f = await fixture(outputRoot, root, entry);
  if (mode === 'seed') {
    await f.open(); await f.select('h1'); assert.ok((await f.change('崩溃前的持久化草稿 🧪')).ok); await f.apply();
    assert.equal((await f.current().persistence!.settle()).status, 'persisted'); await f.unchanged();
    report({ state: 'seeded', sessionId: f.current().checkpointSessionId }); setInterval(() => {}, 1000); return;
  }
  try {
    const catalog = (await f.call('haeWorkspace.listRecovery()')).recovery!;
    assert.ok(catalog.entries.some(row => row.sessionId === recoveryId && row.status === 'dirty' && !row.active));
    await f.restore(recoveryId!);
    assert.equal(await f.current().preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '崩溃前的持久化草稿 🧪');
    await f.unchanged(); assert.equal((await f.save()).outcome, 'saved'); await f.current().persistence!.settle();
    assert.deepEqual(await readFile(entry), Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '崩溃前的持久化草稿 🧪')));
    const id = f.current().id; const list = await f.call(`haeWorkspace.listBackups(${JSON.stringify(id)})`);
    const backup = list.backups!.entries.find(value => value.hash === digest(original))!;
    assert.equal((await f.call(`haeWorkspace.restoreBackup(${JSON.stringify(id)},${(await f.read()).stateRevision},${JSON.stringify(backup.reference)})`)).outcome, 'backup-restored');
    await f.unchanged(); assert.deepEqual(await readFile(join(root, 'keep.css')), css);
  } finally { await f.close(); }
  report({ state: 'restored' }); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
