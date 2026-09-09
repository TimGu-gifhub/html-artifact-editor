import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import type { DocumentCommand, WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';
import { registerSchemes } from '../../src/main/application.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createOriginalSaver } from '../../src/main/storage/original.ts';
import { createWorkspaceSession } from '../../src/main/workspace/session.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import type { PreviewHostStep } from '../../src/platform/preview-host.ts';
import type { LeaveDecision, LeaveReview } from '../../src/contracts/workspace.ts';
import { checkDeparture } from './departure.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', event => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'save-session-profile'));
const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制报告</title><link rel="stylesheet" href="../keep.css"></head><body><h1>A &amp; 😀</h1><p id="date">2025-01-01</p><table><tbody><tr><td>一</td><td>二</td><td>三</td></tr></tbody></table><!-- unchanged --></body></html>');
const expected = Buffer.from(original.toString().replace('A &amp; 😀', '已修订 &lt;&amp;&gt; 🧪'));
const css = Buffer.from('body{font:24px sans-serif;padding:20px;color:rgb(12,34,56)}td{padding:12px}');
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const passed: string[] = []; const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const version = (value: InputSnapshot) => ({ editToken: value.input!.editToken, inputRevision: value.input!.revision });
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
function barrier() { let release!: () => void; const wait = new Promise<void>(done => { release = done; }); return { wait, release }; }
async function fixture(persistDrafts = false) {
  const root = await mkdtemp(join(results, 'save-window-')); const project = join(root, '项目 🧪');
  await mkdir(project); await mkdir(join(project, 'pages')); const entry = join(project, 'pages', '报告 😀.html');
  await writeFile(entry, original); await writeFile(join(project, 'keep.css'), css);
  const privateRoot = join(app.getPath('userData'), randomUUID()); await mkdir(privateRoot);
  const assets = join(root, 'bundled'); await mkdir(assets);
  // Inert trusted transport fixture; no product UI/design implementation.
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Save session transport test</title>');
  const uiSession = session.fromPartition(`save-ui-${randomUUID()}`, { cache: false }); await registerBundledContent(uiSession, 'editor', 'app', assets);
  const ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: {
    ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs'),
  } }); lockContents(ui.webContents);
  const control: { step: (step: string) => Promise<void>; draftStep: (step: string) => Promise<void>; hostFault: PreviewHostStep | null;
    review: (value: LeaveReview) => Promise<LeaveDecision>; copyPath: string | undefined } = {
    step: async () => {}, draftStep: async () => {}, hostFault: null,
    review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }), copyPath: undefined };
  const store = await createSavePreparationStore(privateRoot, step => control.step(step), await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')));
  const checkpoints = await createDraftCheckpointStore(privateRoot, step => control.draftStep(step), store);
  const errors: string[] = [];
  const runtime = createWorkspaceSession(ui, outputRoot, {
    chooseOpen: async () => entry, chooseCopy: async () => control.copyPath,
    projectChoices: { chooseDirectory: async () => project, chooseEntry: async () => entry },
    review: value => control.review(value), reportError: code => errors.push(code),
    bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; },
    onHostStep: step => { if (control.hostFault === step) { control.hostFault = null; throw new Error('test attachment failure'); } },
    saveOriginal: createOriginalSaver(store),
    ...(persistDrafts ? { checkpoints } : {}),
  });
  const call = (expression: string): Promise<WorkspaceResult> => ui.webContents.executeJavaScript(expression);
  const read = async () => { const value = await call('haeWorkspace.read()'); assert.ok(value.ok); assert.ok(value.state); return value.state; };
  const current = () => runtime.workspace.current!;
  const edit = (id: string, command: DocumentCommand) => call(`haeWorkspace.edit(${JSON.stringify(id)},${JSON.stringify(command)})`);
  const save = async () => { const state = await read(); return call(`haeWorkspace.save(${JSON.stringify(state.current!.id)},${state.stateRevision})`); };
  const select = async (selector: string) => {
    const value = current(); const input = value.input.snapshot();
    if (input.input) assert.equal((await edit(value.id, { kind: 'resolve', value: { ...version(input), decision: 'discard', intentSequence: input.intent?.sequence ?? null } })).ok, true);
    const previous = value.mapping.selection;
    const point = await value.preview.contents.executeJavaScript(`(() => {const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const b=r.getBoundingClientRect();return{x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)}})()`);
    value.preview.contents.focus();
    value.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    value.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => value.mapping.selection !== null && value.mapping.selection !== previous, 'native selection');
    const state = (await read()).current!.input;
    assert.equal((await edit(value.id, { kind: 'begin', value: { selection: state.selection!.reference, draftRevision: state.draftRevision } })).ok, true);
  };
  const change = async (text: string, composing = false) => {
    const state = (await read()).current!;
    return edit(state.id, { kind: 'change', value: { ...version(state.input), inputRevision: state.input.input!.revision + 1, newText: text, composing } });
  };
  const apply = async () => { const state = (await read()).current!; const value = await edit(state.id, { kind: 'apply', value: version(state.input) }); assert.ok(value.ok, value.code ?? 'apply failed'); };
  const dirty = async () => { await select('h1'); assert.ok((await change('已修订 <&> 🧪')).ok); await apply(); assert.deepEqual(await readFile(entry), original); };
  const close = async () => { await runtime.dispose(); if (!ui.isDestroyed()) ui.destroy(); };
  try {
    await ui.loadURL(EDITOR_URL); const start = await read();
    assert.equal((await call(`haeWorkspace.openDirectory(${start.stateRevision})`)).outcome, 'opened'); ui.showInactive();
    return { root, project, entry, privateRoot, store, checkpoints, ui, control, runtime, errors, call, read, current, edit, save, select, change, apply, dirty, close };
  } catch (error) { await close(); throw error; }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
async function use(run: (f: Fixture) => Promise<void>, persistDrafts = false): Promise<void> { const f = await fixture(persistDrafts); try { await run(f); } finally { await f.close(); } }

async function run(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('SAVE_SESSION_PLATFORM_UNSUPPORTED');
  await mkdir(results, { recursive: true }); await mkdir(app.getPath('userData'), { recursive: true }); await app.whenReady();
  await checkDeparture({ use, until, barrier, pass, original, expected, css });
  await use(async f => {
    const hold = barrier(); let writing = false;
    f.control.draftStep = async step => { if (step === 'baseline-synced' && !writing) { writing = true; await hold.wait; } };
    try {
      await f.dirty(); await until(() => writing, 'checkpoint writer barrier');
      const doc = f.current(); const queue = doc.persistence!;
      await f.change('第二稿'); await f.apply(); await f.change('第三稿 <&> 🧪'); await f.apply();
      const before = (await f.read()).current!;
      assert.equal(before.persistence!.writingRevision, 2); assert.equal(before.persistence!.queuedRevision, 4);
      assert.equal(before.persistence!.persisted, null); assert.equal(before.input.canApply, true);
      hold.release(); const finished = await queue.settle(); const after = (await f.read()).current!;
      assert.equal(finished.persisted!.draftRevision, 4); assert.equal(after.persistence!.status, 'persisted');
      assert.equal(after.input.stateRevision, before.input.stateRevision, 'storage updates must not invalidate an edit proof');
      assert.equal(after.input.input!.text, '第三稿 <&> 🧪');
      const records = (await f.checkpoints.scan()).records.map(record => record.summary!).sort((a, b) => a.draftRevision - b.draftRevision);
      assert.deepEqual(records.map(record => record.draftRevision), [2, 4]);
      const reopened = await createDraftCheckpointStore(f.privateRoot);
      const recovered = await reopened.restoreCandidate(records[1]!.checkpointId, doc.saveSource, doc.mapping.source);
      assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(original.toString().replace('A &amp; 😀', '第三稿 &lt;&amp;&gt; 🧪')));
      assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);
    } finally { hold.release(); }
    pass('real IPC Apply persists asynchronously, coalesces slow writes to the latest revision, publishes accurate durable status and preserves input proof plus original HTML/resources');
  }, true);
  await use(async f => {
    const hold = barrier(); let writing = false;
    f.control.draftStep = async step => { if (step === 'baseline-synced' && !writing) { writing = true; await hold.wait; } };
    let pendingSave: Promise<WorkspaceResult> | undefined;
    try {
      await f.dirty(); await until(() => writing, 'checkpoint before Save'); const old = f.current();
      pendingSave = f.save(); await until(() => old.input.snapshot().phase === 'saving', 'Save waiting for checkpoint');
      assert.equal((await f.store.scan()).records.length, 0); assert.deepEqual(await readFile(f.entry), original);
      assert.equal((await f.change('late text')).ok, false);
      assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(old.id)},2)`)).code, 'WORKSPACE_BUSY');
      f.ui.close(); await delay(20); assert.equal(f.ui.isDestroyed(), false);
      hold.release(); const saved = await pendingSave; assert.ok(saved.ok, saved.code ?? 'Save failed'); assert.equal(saved.outcome, 'saved');
      assert.deepEqual(await readFile(f.entry), expected); assert.notEqual(f.current().id, old.id);
      assert.equal(f.current().persistence!.snapshot().status, 'idle');
      const checkpoint = (await f.checkpoints.scan()).records[0]!;
      assert.equal((await f.checkpoints.inspect(checkpoint.checkpointId, f.current().saveSource.current)).state, 'committed-matches');
      await f.select('#date'); await f.change('2026-09-09'); await f.apply(); await f.current().persistence!.settle();
      const next = (await f.checkpoints.scan()).records.find(record => record.summary?.sessionId === f.current().id)!;
      assert.equal(next.summary!.baseHash, hash(expected)); assert.equal(next.summary!.draftRevision, 2);
      assert.deepEqual(await readFile(f.entry), expected, 'post-save Apply only writes private evidence');
    } finally { hold.release(); await pendingSave; }
    pass('Save waits for the checkpoint writer before taking its shared lock, freezes edits/close, deduplicates the saved checkpoint and persists subsequent edits against the new baseline');
  }, true);
  await use(async f => {
    f.control.draftStep = async step => { if (step === 'baseline-created') throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }); };
    await f.dirty(); await f.current().persistence!.settle();
    let state = (await f.read()).current!; assert.equal(state.persistence!.status, 'failed'); assert.equal(state.persistence!.code, 'DRAFT_STORAGE_FULL');
    assert.equal(state.persistence!.persisted, null); assert.equal(state.input.input!.appliedText, '已修订 <&> 🧪');
    assert.equal(await f.current().preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '已修订 <&> 🧪');
    await f.change('重试时的最新稿'); await f.apply(); state = (await f.read()).current!;
    assert.equal(state.persistence!.draftRevision, 3); assert.equal((await f.checkpoints.scan()).records.length, 1);
    assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(state.id)},2)`)).code, 'STALE_DRAFT_REQUEST');
    assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(randomUUID())},3)`)).code, 'STALE_DOCUMENT');
    f.control.draftStep = async () => {};
    assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(state.id)},3)`)).ok, true);
    await f.current().persistence!.settle(); state = (await f.read()).current!;
    assert.equal(state.persistence!.status, 'persisted'); assert.equal(state.persistence!.persisted!.draftRevision, 3);
    assert.equal(state.input.input!.text, '重试时的最新稿'); assert.deepEqual(await readFile(f.entry), original);
    pass('private storage failure retains applied text and the exact durable status; later Apply does not auto-retry, and trusted retry rejects stale/wrong documents then persists only the newest candidate');
  }, true);
  await use(async f => {
    const hold = barrier(); let writing = false;
    f.control.draftStep = async step => { if (step === 'baseline-synced') { writing = true; await hold.wait; } };
    try {
      await f.dirty(); await until(() => writing, 'checkpoint during renderer crash'); const doc = f.current();
      f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'renderer authority revoked');
      hold.release(); await doc.persistence!.settle(); await f.runtime.reloadUI();
      const state = (await f.read()).current!; assert.equal(state.id, doc.id); assert.equal(state.persistence!.persisted!.draftRevision, 2);
      assert.equal(state.input.input!.appliedText, '已修订 <&> 🧪'); assert.deepEqual(await readFile(f.entry), original);
    } finally { hold.release(); }
    pass('actual UI renderer crash does not cancel Main checkpoint persistence; reloaded production transport reads the same applied draft and confirmed durable revision');
  }, true);
  await use(async f => {
    const hold = barrier(); let writing = false;
    f.control.draftStep = async step => { if (step === 'baseline-synced' && !writing) { writing = true; await hold.wait; } };
    try {
      await f.dirty(); await until(() => writing, 'checkpoint before close');
      await f.change('A & 😀'); await f.apply(); const doc = f.current(); assert.equal(doc.draft.candidate.patches.length, 0);
      f.ui.close(); await until(() => f.runtime.closing, 'native close waits'); assert.equal(f.ui.isDestroyed(), false);
      hold.release(); await until(() => f.ui.isDestroyed(), 'native close after checkpoint drain');
      const records = (await f.checkpoints.scan()).records.map(record => record.summary!).sort((a, b) => b.draftRevision - a.draftRevision);
      assert.equal(records[0]!.draftRevision, 3); assert.equal(records[0]!.changeCount, 0); assert.equal(records[0]!.resultHash, hash(original));
      assert.deepEqual(await readFile(f.entry), original);
    } finally { hold.release(); }
    pass('native close of a clean document drains the last queued return-to-baseline checkpoint before destroying the window');
  }, true);
  await use(async f => {
    f.control.draftStep = async step => { if (step === 'baseline-created') throw Object.assign(new Error('injected checkpoint failure'), { code: 'ENOSPC' }); };
    await f.dirty(); await f.current().persistence!.settle();
    assert.equal(f.current().persistence!.snapshot().status, 'failed');
    await f.change('仍可显式保存 <&>'); await f.apply();
    const saved = await f.save(); assert.equal(saved.outcome, 'saved'); assert.equal(saved.ok, true);
    assert.deepEqual(await readFile(f.entry), Buffer.from(original.toString().replace('A &amp; 😀', '仍可显式保存 &lt;&amp;&gt;')));
    assert.equal((await f.store.scan()).records[0]!.phase, 'committed');
    const evidence = await f.checkpoints.scan(); assert.equal(evidence.records.length, 1); assert.notEqual(evidence.records[0]!.phase, 'complete');
    pass('failed checkpoint persistence does not disable an explicit verified Save; the latest applied bytes are saved while incomplete private evidence remains intact');
  }, true);
  await use(async f => {
    assert.equal((await f.read()).canSave, false); assert.equal((await f.save()).outcome, 'unchanged'); assert.deepEqual(await readdir(f.privateRoot), []);
    assert.deepEqual(await f.ui.webContents.executeJavaScript('[typeof require,typeof process,typeof ipcRenderer]'), ['undefined', 'undefined', 'undefined']);
    await f.dirty(); const old = f.current(); const oldInput = old.input.snapshot(); assert.equal((await f.read()).canSave, true);
    const reports: string[] = [];
    const stopReports = f.runtime.workspace.onState(() => { const value = f.runtime.workspace.snapshot().lastSave; if (value) reports.push(value.status); });
    const saved = await f.save(); stopReports(); assert.ok(saved.ok, saved.code ?? 'save failed'); assert.equal(saved.outcome, 'saved');
    assert.equal(reports.includes('rebase-required'), false, 'normal rebuilding must not publish a transient recovery error');
    assert.equal(saved.documentId, old.id); assert.equal(saved.state!.phase, 'idle'); assert.notEqual(f.current().id, old.id);
    assert.equal(saved.state!.lastSave!.status, 'saved'); assert.equal(saved.state!.canSave, false);
    assert.equal(f.current().draft.candidate.patches.length, 0); assert.equal(f.current().draft.candidate.baseHash, hash(expected));
    assert.equal(f.current().preview.grant.root, old.preview.grant.root); assert.equal(f.runtime.host.current, f.current().preview.view);
    assert.deepEqual(await readFile(f.entry), expected); assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);
    assert.equal(await f.current().preview.contents.executeJavaScript('getComputedStyle(document.body).color'), 'rgb(12, 34, 56)');
    assert.equal((await f.edit(old.id, { kind: 'apply', value: version(oldInput) })).code, 'STALE_DOCUMENT');
    assert.equal((await f.call(`haeWorkspace.save(${JSON.stringify(old.id)},${(await f.read()).stateRevision})`)).code, 'STALE_DOCUMENT');
    const stale = await f.edit(f.current().id, { kind: 'begin', value: { selection: oldInput.selection!.reference, draftRevision: 1 } }); assert.equal(stale.ok, false);
    await f.select('#date'); assert.ok((await f.change('2026-09-09')).ok); await f.apply(); assert.equal((await f.save()).outcome, 'saved');
    const twice = Buffer.from(expected.toString().replace('2025-01-01', '2026-09-09')); assert.deepEqual(await readFile(f.entry), twice);
    await f.select('td'); assert.ok((await f.change('')).ok); await f.apply(); assert.equal((await f.save()).outcome, 'saved');
    assert.deepEqual(await readFile(f.entry), Buffer.from(twice.toString().replace('<td>一</td>', '<td></td>')));
    assert.equal(f.current().mapping.source.nodes.some(n => n.decodedText === '一'), false);
    assert.equal((await f.store.scan()).records.length, 3); assert.equal((await f.store.scan()).locked, false);
    pass('explicit IPC saves reparse/rebind each new baseline, retain the authorized project root/resources, reject old document/Text identities and correctly save again including an emptied Text');
  });
  await use(async f => {
    await f.select('h1'); assert.ok((await f.change('未完成拼音', true)).ok); assert.equal((await f.save()).code, 'INPUT_COMPOSING');
    assert.ok((await f.change('未应用输入', false)).ok); assert.equal((await f.save()).code, 'UNAPPLIED_INPUT');
    assert.equal((await f.read()).canSave, false); assert.deepEqual(await readdir(f.privateRoot), []); assert.deepEqual(await readFile(f.entry), original);
    const input = f.current().input.snapshot(); assert.ok((await f.edit(f.current().id, { kind: 'resolve', value: { ...version(input), decision: 'discard', intentSequence: null } })).ok);
    assert.equal((await f.save()).outcome, 'unchanged');
    pass('composing and unapplied input reject Save without creating evidence or touching HTML; explicit cancellation leaves the original unchanged (interface flags, not real IME acceptance)');
  });
  await use(async f => {
    await f.dirty(); const before = f.current(); const stop = barrier(); let waiting = false;
    f.control.step = async stage => { if (stage === 'backup-synced') { waiting = true; await stop.wait; } };
    const pending = f.save(); await until(() => waiting, 'save barrier');
    try {
      assert.equal((await f.change('late text')).code, 'INPUT_BUSY'); assert.equal((await f.save()).code, 'WORKSPACE_BUSY');
      assert.equal((await f.call(`haeWorkspace.open(${(await f.read()).stateRevision})`)).code, 'WORKSPACE_BUSY');
      f.ui.close(); await until(() => !f.runtime.closing && f.errors.at(-1) === 'WORKSPACE_BUSY', 'native close blocked');
      assert.equal(f.ui.isDestroyed(), false); assert.deepEqual(await readFile(f.entry), original);
    } finally { stop.release(); }
    assert.equal((await pending).outcome, 'saved'); assert.notEqual(f.current().id, before.id); assert.deepEqual(await readFile(f.entry), expected);
    pass('in-flight Save blocks late input, duplicate saves, Open and native window close, then reports the settled new document');
  });
  await use(async f => {
    await f.dirty(); const before = f.current(); await writeFile(f.entry, original);
    const result = await f.save(); assert.equal(result.ok, false); assert.equal(result.code, 'FILE_CHANGED'); assert.equal(f.current(), before);
    assert.equal(before.draft.phase, 'idle'); assert.deepEqual(Buffer.from(before.draft.candidate.bytes), expected);
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readdir(f.privateRoot), []);
    pass('the version captured at document open rejects an external same-byte rewrite before Save while retaining an editable applied draft');
  });
  for (const stage of ['prepared-synced', 'native-replaced']) await use(async f => {
    await f.dirty(); const before = f.current(); const stop = barrier(); let waiting = false;
    f.control.step = async step => { if (step === stage) { waiting = true; await stop.wait; } };
    // A destroyed renderer may never settle executeJavaScript's remote Promise.
    // Observe the surviving Main operation, not that vanished renderer's promise.
    void f.save().catch(() => null); await until(() => waiting, stage);
    f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'renderer revoked'); stop.release();
    await until(() => f.runtime.workspace.snapshot().phase === 'idle', 'Main save reconciliation');
    assert.equal(f.runtime.workspace.snapshot().lastSave!.status, stage === 'prepared-synced' ? 'cancelled' : 'saved');
    assert.deepEqual(await readFile(f.entry), stage === 'prepared-synced' ? original : expected);
    assert.equal((await f.store.scan()).locked, false); await f.runtime.reloadUI();
    if (stage === 'prepared-synced') { assert.equal(f.current(), before); assert.equal((await f.read()).current!.input.changes.length, 1); }
    else { assert.notEqual(f.current().id, before.id); assert.equal((await f.read()).current!.input.changes.length, 0); }
    pass(`${stage}: real UI renderer crash cancels an unstarted replacement or reconciles an already started commit; reconnect reads retained Main state`);
  });
  await use(async f => {
    await f.dirty(); const before = f.current(); f.control.step = async stage => { if (stage === 'native-replaced') throw new Error('SAVE_TEST_FAILURE'); };
    const result = await f.save(); assert.equal(result.ok, false); assert.equal(result.state!.lastSave!.status, 'unknown');
    assert.equal(f.current(), before); assert.equal(before.draft.phase, 'uncertain'); assert.deepEqual(Buffer.from(before.draft.candidate.bytes), expected);
    assert.deepEqual(await readFile(f.entry), expected); assert.equal((await f.store.scan()).locked, true);
    assert.equal((await f.save()).code, 'DOCUMENT_RECOVERY_REQUIRED'); assert.equal((await f.read()).canSave, false);
    pass('unknown native outcome keeps the original draft/source session and private evidence, and blocks a second overwrite');
  });
  await use(async f => {
    await f.dirty(); const before = f.current(); f.control.hostFault = 'detached';
    const result = await f.save(); assert.equal(result.ok, false); assert.equal(result.outcome, 'rebase-required'); assert.equal(result.code, 'SAVE_REBASE_REQUIRED');
    assert.equal(f.current(), before); assert.equal(f.runtime.host.current, before.preview.view); assert.equal(before.draft.phase, 'uncertain');
    assert.deepEqual(await readFile(f.entry), expected); assert.equal(f.runtime.workspace.retainedSave!.status, 'committed');
    assert.equal((await f.store.scan()).records[0]!.phase, 'committed'); assert.equal((await f.save()).code, 'DOCUMENT_RECOVERY_REQUIRED');
    pass('a post-write native attachment failure rolls the view back, retains the old draft and explicitly distinguishes committed file bytes from an unrebuilt editing session');
  });
  await use(async f => {
    await f.dirty(); const before = f.current(); const outside = Buffer.from(original.toString().replace('A &amp; 😀', '外部应用的新结果'));
    f.control.step = async stage => { if (stage === 'release-lock') await writeFile(f.entry, outside); };
    const result = await f.save(); assert.equal(result.outcome, 'rebase-required'); assert.equal(f.current(), before);
    assert.deepEqual(await readFile(f.entry), outside); assert.deepEqual(Buffer.from(before.draft.candidate.bytes), expected);
    assert.equal((await f.read()).lastSave!.requiresReview, true);
    pass('external changes between commit and rebind cannot be adopted as the saved baseline or silently overwrite external bytes');
  });
  await use(async f => {
    await f.dirty(); const before = f.current();
    f.control.step = async stage => { if (stage === 'release-lock') throw new Error('SAVE_LOCK_CLEANUP_TEST'); };
    const result = await f.save(); assert.equal(result.ok, true); assert.equal(result.outcome, 'saved'); assert.equal(result.code, null);
    assert.notEqual(f.current().id, before.id); assert.equal(result.state!.lastSave!.cleanupPending, true);
    assert.equal(result.state!.lastSave!.code, 'SAVE_CLEANUP_PENDING'); assert.equal(result.state!.canSave, false);
    assert.equal((await f.save()).code, 'DOCUMENT_RECOVERY_REQUIRED'); assert.deepEqual(await readFile(f.entry), expected);
    assert.equal((await f.store.scan()).locked, true);
    pass('verified file and baseline with failed lock cleanup still report successful Save plus a cleanup warning, while a new overwrite waits for recovery');
  });
  await writeFile(join(results, 'save-session.json'), JSON.stringify({ status: 'passed',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions, passed,
    fileHashes: { original: hash(original), candidate: hash(expected), css: hash(css) } }, null, 2));
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'save-session.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
