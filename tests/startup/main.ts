import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createPersistentWorkspaceSession, WORKSPACE_STORAGE_NAME } from '../../src/main/workspace/persistent-session.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { fixture, project, editorWindow, ports, original, corrected, css, until, barrier } from './fixture.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', event => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
const profile = join(results, `startup-profile-${randomUUID()}`); app.setPath('userData', profile);
const passed: string[] = []; const pass = (text: string) => { passed.push(text); console.log(`PASS: ${text}`); };

function child(mode: string, childProfile: string, root: string, entry: string, recoveryId?: string) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const processChild = spawn(process.execPath, [join(outputRoot, 'startup-child/index.cjs'), mode, childProfile, root, entry,
    ...(recoveryId ? [recoveryId] : [])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const messages: { state: string; sessionId?: string }[] = []; let stdout = ''; let stderr = '';
  processChild.stdout.on('data', value => { stdout += String(value); if (stdout.length > 64 * 1024) processChild.kill();
    let at: number; while ((at = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, at); stdout = stdout.slice(at + 1);
      try { const value = JSON.parse(line); if (value?.state) messages.push(value); } catch { /* Electron diagnostics are not protocol. */ }
    }
  });
  processChild.stderr.on('data', value => { stderr += String(value); if (stderr.length > 64 * 1024) processChild.kill(); });
  const timeout = setTimeout(() => processChild.kill('SIGKILL'), 25_000);
  const ended = once(processChild, 'exit').then(([code, signal]) => { clearTimeout(timeout); return { code, signal, stderr }; });
  return { process: processChild, messages, ended };
}

async function run() {
  if (process.platform !== 'win32') throw Error('STARTUP_PLATFORM_UNSUPPORTED');
  await mkdir(results, { recursive: true }); await mkdir(profile, { recursive: true }); await app.whenReady();
  const firstProject = await project(results); const window = await editorWindow(outputRoot, firstProject.root);
  const fixed = join(profile, WORKSPACE_STORAGE_NAME);
  try {
    await writeFile(fixed, 'self-made startup obstruction', { flag: 'wx' });
    await assert.rejects(createPersistentWorkspaceSession(window, outputRoot, ports(window, firstProject.root, firstProject.entry)), /STORAGE_LOCATION_CHANGED/);
    assert.equal(await readFile(fixed, 'utf8'), 'self-made startup obstruction');
    assert.equal((await readdir(profile)).filter(name => name.startsWith(WORKSPACE_STORAGE_NAME)).length, 1);
    // Preserve this test-created file at another known direct child; no removal,
    // recursive move or production fallback/migration is involved.
    await rename(fixed, join(profile, 'preserved-startup-obstruction.txt'));
    pass('startup rejects a file at the fixed private directory and preserves it without inventing another storage location');

    const starting = createPersistentWorkspaceSession(window, outputRoot, ports(window, firstProject.root, firstProject.entry));
    await assert.rejects(createPersistentWorkspaceSession(window, outputRoot, ports(window, firstProject.root, firstProject.entry)), /EDITOR_RUNTIME_ACTIVE/);
    const active = await starting; assert.equal(active.storage.directory, fixed); assert.equal(app.hasSingleInstanceLock(), true);
    const another = await editorWindow(outputRoot, firstProject.root);
    try { await assert.rejects(createPersistentWorkspaceSession(another, outputRoot, ports(another, firstProject.root, firstProject.entry)), /EDITOR_RUNTIME_ACTIVE/); }
    finally { another.destroy(); }
    await active.dispose();
    pass('one application runtime claims the profile and fixed store before async startup, excludes duplicate starts/windows, and releases the in-process claim only after disposal');
  } finally { if (!window.isDestroyed()) window.destroy(); }

  const p = await project(results); let f = await fixture(outputRoot, p.root, p.entry);
  let savedSessionId = '';
  try {
    assert.deepEqual((await f.call('haeWorkspace.listRecovery()')).recovery!.entries, []);
    await f.open();
    assert.deepEqual(await f.window.webContents.executeJavaScript('[typeof require, typeof process, typeof ipcRenderer]'), ['undefined', 'undefined', 'undefined']);
    assert.deepEqual(await f.current().preview.contents.executeJavaScript('[typeof haeWorkspace, typeof require]'), ['undefined', 'undefined']);
    for (const [selector, text] of [['h1', '2026 年度报告 🧪'], ['#date', '2026-09-10'], ['#one', '一 <&>'], ['#two', '二 😀'], ['#three', '三 已核对']] as const) {
      await f.select(selector); assert.ok((await f.change(text)).ok); await f.apply(); await f.unchanged();
    }
    const before = f.current().input.snapshot(); const id = f.current().id;
    const diff = await f.call(`haeWorkspace.readDiff(${JSON.stringify(id)},${before.draftRevision},${JSON.stringify(before.candidateHash)})`);
    assert.ok(diff.ok, diff.code ?? 'diff failed'); assert.equal(diff.diff!.changes.length, 5);
    const parts: Buffer[] = []; let end = 0;
    for (const item of diff.diff!.changes) { parts.push(original.subarray(end, item.before.startByte), Buffer.from(item.after.text)); end = item.before.endByte; }
    parts.push(original.subarray(end)); assert.deepEqual(Buffer.concat(parts), corrected);
    const state = await f.read(); const saved = await f.call(`haeWorkspace.save(${JSON.stringify(id)},${state.stateRevision},${JSON.stringify({ draftRevision: before.draftRevision, candidateHash: before.candidateHash })})`);
    assert.equal(saved.outcome, 'saved', saved.code ?? 'save failed'); assert.deepEqual(await readFile(p.entry), corrected);
    assert.deepEqual(await readFile(join(p.root, 'keep.css')), css);
    const current = f.current(); assert.equal((await current.persistence!.settle()).status, 'persisted'); savedSessionId = current.checkpointSessionId;
    assert.equal((await f.read()).current!.input.history!.undoCount, 5);
    assert.equal((await f.runtime.storage.saves.scan()).records.length, 1);
    pass('the composed production services execute five report corrections through real native selection/IPC, reconstruct exact source Diff, perform reviewed Windows Save and persist clean Undo history with unchanged CSS');
  } finally { await f.close(); }

  f = await fixture(outputRoot, p.root, p.entry);
  try {
    assert.equal(f.runtime.storage.directory, fixed);
    const catalog = (await f.call('haeWorkspace.listRecovery()')).recovery!;
    assert.ok(catalog.entries.some(row => row.sessionId === savedSessionId && row.status === 'clean' && !row.active));
    await f.restore(savedSessionId); const input = f.current().input.snapshot();
    assert.equal(input.history!.undoCount, 5); assert.equal(input.changes.length, 0);
    assert.ok((await f.edit({ kind: 'history', value: { stateRevision: input.stateRevision, draftRevision: input.draftRevision, direction: 'undo' } })).ok);
    assert.deepEqual(await readFile(p.entry), corrected); assert.equal((await f.save()).outcome, 'saved');
    assert.deepEqual(await readFile(p.entry), Buffer.from(corrected.toString().replace('id="three">三 已核对', 'id="three">三')));
    await f.current().persistence!.settle();
    const id = f.current().id; const list = await f.call(`haeWorkspace.listBackups(${JSON.stringify(id)})`);
    const backup = list.backups!.entries.find(value => value.hash === digest(original))!; assert.ok(backup);
    assert.equal((await f.call(`haeWorkspace.restoreBackup(${JSON.stringify(id)},${(await f.read()).stateRevision},${JSON.stringify(backup.reference)})`)).outcome, 'backup-restored');
    await f.unchanged(); assert.equal(f.current().input.snapshot().history!.undoCount, 0);
    pass('a new window reuses the fixed store, recovers clean history, performs Undo plus explicit Save, and restores a selected backup through the same production runtime');
  } finally { await f.close(); }

  const drainProject = await project(results); const hold = barrier(); let writing = false;
  f = await fixture(outputRoot, drainProject.root, drainProject.entry, { onStorageStep: async (kind, step) => {
    if (kind === 'checkpoint' && step === 'baseline-synced' && !writing) { writing = true; await hold.wait; }
  } });
  const probe = await editorWindow(outputRoot, drainProject.root);
  try {
    await f.open(); await f.select('h1'); assert.ok((await f.change('已确认但尚在写入')).ok); await f.apply(); await until(() => writing, 'checkpoint before destroyed window');
    const sessionId = f.current().checkpointSessionId; f.window.destroy();
    const first = f.runtime.dispose(); const second = f.runtime.dispose(); assert.equal(first, second);
    let completed = false; void first.then(() => { completed = true; });
    await assert.rejects(createPersistentWorkspaceSession(probe, outputRoot, ports(probe, drainProject.root, drainProject.entry)), /EDITOR_RUNTIME_ACTIVE/);
    assert.equal(completed, false); await f.unchanged(); hold.release(); await first; await second;
    const restarted = await createPersistentWorkspaceSession(probe, outputRoot, ports(probe, drainProject.root, drainProject.entry));
    try { assert.ok((await restarted.storage.checkpoints.catalog()).groups.some(row => row.sessionId === sessionId && row.status === 'dirty')); }
    finally { await restarted.dispose(); }
    pass('native window destruction and repeated dispose calls share real pending teardown; a second runtime stays excluded until the active checkpoint is sealed and document cleanup has finished');
  } finally { hold.release(); await f.close(); if (!probe.isDestroyed()) probe.destroy(); }

  const saveProject = await project(results); const prepared = barrier(); let preparing = false;
  f = await fixture(outputRoot, saveProject.root, saveProject.entry, { onStorageStep: async (kind, step) => {
    if (kind === 'save' && step === 'prepared-synced') { preparing = true; await prepared.wait; }
  } });
  const excluded = await editorWindow(outputRoot, saveProject.root);
  try {
    await f.open(); await f.select('h1'); assert.ok((await f.change('关闭时仍在准备保存')).ok); await f.apply();
    await f.current().persistence!.settle();
    const saving = f.runtime.workspace.save((await f.read()).stateRevision, f.current().id);
    await until(() => preparing, 'original Save preparation'); f.window.destroy();
    let complete = false; const disposal = f.runtime.dispose().then(() => { complete = true; });
    await assert.rejects(createPersistentWorkspaceSession(excluded, outputRoot, ports(excluded, saveProject.root, saveProject.entry)), /EDITOR_RUNTIME_ACTIVE/);
    assert.equal(complete, false); await f.unchanged(); prepared.release();
    assert.equal((await saving).status, 'cancelled'); await disposal; await f.unchanged();
    const restarted = await createPersistentWorkspaceSession(excluded, outputRoot, ports(excluded, saveProject.root, saveProject.entry));
    try { assert.ok((await restarted.storage.saves.scan()).records.some(row => row.phase === 'cancelled')); }
    finally { await restarted.dispose(); }
    pass('closing during real Save preparation waits for its private cancellation and lock release before another runtime can start; original HTML and the durable draft remain intact');
  } finally { prepared.release(); await f.close(); if (!excluded.isDestroyed()) excluded.destroy(); }

  const wrongProfile = await project(results); const wrongWindow = await editorWindow(outputRoot, wrongProfile.root);
  try {
    app.setPath('userData', wrongProfile.root);
    await assert.rejects(createPersistentWorkspaceSession(wrongWindow, outputRoot, ports(wrongWindow, wrongProfile.root, wrongProfile.entry)), /DRAFT_PROFILE_IN_USE/);
    assert.equal((await readdir(wrongProfile.root)).includes(WORKSPACE_STORAGE_NAME), false);
  } finally { app.setPath('userData', profile); wrongWindow.destroy(); }
  pass('changing userData cannot reuse the previously acquired profile lock or create a store in the newly named directory');

  const crashed = await project(results); const childProfile = await mkdtemp(join(results, 'startup-child-profile-'));
  const seeded = child('seed', childProfile, crashed.root, crashed.entry);
  try {
    await until(() => seeded.messages.some(value => value.state === 'seeded'), 'child persistent startup');
    const sessionId = seeded.messages.find(value => value.state === 'seeded')!.sessionId!;
    const competing = child('compete', childProfile, crashed.root, crashed.entry); const competed = await competing.ended;
    assert.equal(competed.code, 0, competed.stderr); assert.equal(competing.messages.at(-1)!.state, 'blocked');
    seeded.process.kill('SIGKILL'); const stopped = await seeded.ended; assert.equal(stopped.signal, 'SIGKILL');
    const resumed = child('restore', childProfile, crashed.root, crashed.entry, sessionId); const recovered = await resumed.ended;
    assert.equal(recovered.code, 0, recovered.stderr); assert.equal(resumed.messages.at(-1)!.state, 'restored');
    assert.deepEqual(await readFile(crashed.entry), original); assert.deepEqual(await readFile(join(crashed.root, 'keep.css')), css);
    pass('an actual competing Electron process is rejected; after forced process termination a fresh startup discovers its fixed-store draft, restores it, explicitly saves and restores the original backup');
  } finally { if (seeded.process.exitCode === null && seeded.process.signalCode === null) seeded.process.kill('SIGKILL'); await seeded.ended; }

  const committedProject = await project(results); const committedProfile = await mkdtemp(join(results, 'startup-commit-profile-'));
  const closingCommit = child('close-commit', committedProfile, committedProject.root, committedProject.entry);
  const closedCommit = await closingCommit.ended; assert.equal(closedCommit.code, 0, closedCommit.stderr);
  assert.equal(closingCommit.messages.at(-1)!.state, 'commit-retained');
  pass('native window destruction after real Windows replacement waits for committed journal reconciliation, retains rebase-required evidence, and refuses to release runtime ownership');

  const preserved = join(fixed, 'unclassified-evidence.txt'); await writeFile(preserved, 'keep this self-made evidence', { flag: 'wx' });
  const lastProject = await project(results); f = await fixture(outputRoot, lastProject.root, lastProject.entry);
  try {
    const blockedRecovery = await f.call('haeWorkspace.listRecovery()');
    assert.equal(blockedRecovery.ok, false); assert.equal(blockedRecovery.code, 'DRAFT_STORAGE_REVIEW_REQUIRED');
    assert.equal(blockedRecovery.recovery, null); assert.equal(f.runtime.storage.directory, fixed);
    assert.equal(await readFile(preserved, 'utf8'), 'keep this self-made evidence');
    assert.equal((await readdir(profile)).filter(name => name.startsWith(WORKSPACE_STORAGE_NAME)).length, 1);
    pass('unclassified existing evidence remains in the same private store and is reported for review on startup instead of being cleared or bypassed with a new namespace');
    await f.open(); f.runtime.workspace.invalidateActivation();
    await assert.rejects(f.runtime.dispose(), /EDITOR_RUNTIME_CLEANUP_REQUIRED/);
    const blocked = await editorWindow(outputRoot, lastProject.root);
    try { await assert.rejects(createPersistentWorkspaceSession(blocked, outputRoot, ports(blocked, lastProject.root, lastProject.entry)), /EDITOR_RUNTIME_ACTIVE/); }
    finally { blocked.destroy(); }
    assert.equal(await readFile(preserved, 'utf8'), 'keep this self-made evidence'); await f.unchanged();
    pass('uncertain native activation/cleanup retains application ownership and evidence even after disposal, preventing a duplicate runtime from claiming a successful release');
  } finally { if (!f.window.isDestroyed()) f.window.destroy(); }

  await writeFile(join(results, 'startup.json'), JSON.stringify({ status: 'passed', passed,
    scope: 'Main persistent Workspace composition and real Windows/process transport; inert test UI, no product or real IME acceptance',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions,
    hashes: { original: digest(original), corrected: digest(corrected), css: digest(css) } }, null, 2));
}
void run().then(() => app.exit(0)).catch(async error => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'startup.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
