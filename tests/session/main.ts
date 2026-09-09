import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session, webContents } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';
import type { LeaveReview, WorkspaceSnapshot } from '../../src/contracts/workspace.ts';
import type { DocumentCommand, WorkspaceConnection, WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import { WORKSPACE_STATE } from '../../src/contracts/workspace-editor.ts';
import { registerSchemes } from '../../src/main/application.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createWorkspaceSession } from '../../src/main/workspace/session.ts';
import type { PreviewHostStep } from '../../src/platform/preview-host.ts';

registerSchemes(); app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'session-profile'));
const passed: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let ui: BrowserWindow;
let runtime: ReturnType<typeof createWorkspaceSession>;
const activeDocument = () => runtime.workspace.current!;
function deferred<T>() {
  let resolveValue!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolveValue = yes; reject = no; });
  return { promise, resolve: resolveValue, reject };
}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
async function read(): Promise<WorkspaceSnapshot> {
  const result: WorkspaceResult = await ui.webContents.executeJavaScript('haeWorkspace.read()');
  assert.equal(result.ok, true); assert.ok(result.state); return result.state;
}
async function edit(documentId: string, value: DocumentCommand): Promise<WorkspaceResult> {
  return ui.webContents.executeJavaScript(`haeWorkspace.edit(${JSON.stringify(documentId)},${JSON.stringify(value)})`);
}
const version = (state: InputSnapshot) => ({ editToken: state.input!.editToken, inputRevision: state.input!.revision });
async function select(selector: string): Promise<void> {
  const current = activeDocument();
  assert.equal(runtime.host.current, current.preview.view);
  const input = current.input.snapshot();
  if (input.input) {
    assert.equal((await edit(current.id, { kind: 'resolve', value: { ...version(input),
      decision: 'discard', intentSequence: input.intent?.sequence ?? null } })).ok, true);
  }
  const previousSelection = current.mapping.selection;
  const point = await current.preview.contents.executeJavaScript(`(() => {
    const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const b=r.getBoundingClientRect();
    return {x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)};
  })()`);
  current.preview.contents.focus();
  current.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  current.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until(() => current.mapping.selection !== null && current.mapping.selection !== previousSelection, 'native Text selection');
  const state = (await read()).current!.input;
  const begun = await edit(current.id, { kind: 'begin', value: { selection: state.selection!.reference,
    draftRevision: state.draftRevision } });
  assert.equal(begun.ok, true, begun.code ?? undefined);
}
async function change(newText: string, composing = false): Promise<void> {
  const current = (await read()).current!;
  assert.equal((await edit(current.id, { kind: 'change', value: { ...version(current.input),
    inputRevision: current.input.input!.revision + 1, newText, composing } })).ok, true);
}
async function apply(): Promise<void> {
  const current = (await read()).current!;
  assert.equal((await edit(current.id, { kind: 'apply', value: version(current.input) })).ok, true);
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const directory = await mkdtemp(join(results, 'session-case-'));
  const assets = join(directory, 'bundled'); await mkdir(assets);
  // Inert transport fixture, no product controls or visual implementation.
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Session transport test</title>');
  const entry = join(directory, '第一份 报告 🧪.html');
  const secondPath = join(directory, 'second.html');
  const copyPath = join(directory, '另存结果.html');
  const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制</title><link rel="stylesheet" href="keep.css"></head><body><h1>A &amp; 😀</h1><table><tr><td>相同</td><td>相同</td></tr></table><!-- keep --></body></html>');
  const secondBytes = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Second</title></head><body><h1>第二份</h1></body></html>');
  const css = Buffer.from('body{font:24px sans-serif;padding:20px}td{padding:12px}');
  await writeFile(entry, original); await writeFile(secondPath, secondBytes); await writeFile(join(directory, 'keep.css'), css);
  let chooseCalls = 0; let copyCalls = 0; let reviewCalls = 0;
  let choose: () => Promise<string | undefined> = async () => undefined;
  let chooseCopy: () => Promise<string | undefined> = async () => undefined;
  let review: (value: LeaveReview) => Promise<unknown> = async (value) => ({ reviewId: value.reviewId, decision: 'cancel' });
  let fault: PreviewHostStep | null = null;
  const errors: string[] = [];
  const uiSession = session.fromPartition(`session-test-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', assets);
  const preferences = { ...securePreferences, session: uiSession, preload: join(outputRoot, 'session/probe/index.cjs') };
  ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: preferences });
  lockContents(ui.webContents);
  runtime = createWorkspaceSession(ui, outputRoot, {
    chooseOpen: () => { chooseCalls++; return choose(); }, chooseCopy: () => { copyCalls++; return chooseCopy(); },
    review: (value) => { reviewCalls++; return review(value); }, reportError: (code) => errors.push(code),
    bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; },
    onHostStep: (step) => { if (fault === step) { fault = null; throw new Error('injected native attachment failure'); } },
  });
  const open = async (): Promise<WorkspaceResult> => {
    const state = await read();
    return ui.webContents.executeJavaScript(`haeWorkspace.open(${state.stateRevision})`);
  };
  try {
    await ui.loadURL(EDITOR_URL);
    assert.equal((await read()).current, null); assert.equal(runtime.connected, true);
    assert.deepEqual(await ui.webContents.executeJavaScript('Object.keys(haeWorkspace).sort()'), ['edit', 'listRecovery', 'onState', 'open', 'openDirectory', 'read', 'restore', 'retryPersistence', 'save', 'switchEntry']);
    assert.deepEqual(await ui.webContents.executeJavaScript('[typeof require,typeof process,typeof ipcRenderer,typeof Buffer]'), Array(4).fill('undefined'));
    assert.equal((await open()).outcome, 'cancelled'); assert.equal(runtime.workspace.current, null);
    assert.equal(await ui.webContents.executeJavaScript('haeWorkspace.open(NaN).then(r=>r.code)'), 'INVALID_WORKSPACE_REQUEST');
    assert.equal(chooseCalls, 1);
    const peer = new BrowserWindow({ show: false, webPreferences: preferences }); lockContents(peer.webContents);
    await peer.loadURL(EDITOR_URL);
    assert.equal(await peer.webContents.executeJavaScript('haeWorkspace.read().then(r=>r.code)'), 'EDITOR_DISCONNECTED');
    peer.destroy();
    pass('one selected trusted window exposes six bounded workspace methods; empty/cancelled open has no document and same-session peer cannot call the scoped handler');

    choose = async () => entry;
    assert.equal((await open()).outcome, 'opened');
    const first = activeDocument();
    assert.equal(runtime.host.current, first.preview.view); assert.ok(ui.contentView.children.includes(first.preview.view));
    assert.equal(first.mapping.status, 'ready');
    assert.deepEqual(await first.preview.contents.executeJavaScript('[typeof haeWorkspace,typeof haeEditor,typeof workspaceProbe,typeof require]'), Array(4).fill('undefined'));
    ui.showInactive(); await select('h1'); await change('修改标题 <&> 😀'); await apply();
    await select('td:nth-child(2)'); await change('仅第二格'); await apply();
    const expected = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制</title><link rel="stylesheet" href="keep.css"></head><body><h1>修改标题 &lt;&amp;&gt; 😀</h1><table><tr><td>相同</td><td>仅第二格</td></tr></table><!-- keep --></body></html>');
    const input = (await read()).current!.input;
    assert.equal(input.changes.length, 2); assert.deepEqual(Buffer.from(first.draft.candidate.bytes), expected);
    assert.deepEqual(await readFile(entry), original); assert.equal(copyCalls, 0);
    chooseCopy = async () => copyPath;
    const saved = await edit(first.id, { kind: 'save-copy', stateRevision: input.stateRevision });
    assert.equal(saved.ok, true); assert.equal(saved.copy?.status, 'created'); assert.equal(saved.documentId, first.id);
    assert.deepEqual(await readFile(copyPath), expected); assert.equal(first.input.snapshot().changes.length, 2);
    pass('native title and repeated-cell clicks drive the real workspace preload/IPC, exact Text patches and exclusive copy; BOM/CRLF/entities and all unrelated bytes match an independent complete expectation');

    await change('挂载失败也要保留');
    const before = first.input.snapshot(); const contentCount = webContents.getAllWebContents().length;
    choose = async () => secondPath; review = async (value) => ({ reviewId: value.reviewId, decision: 'discard' });
    for (const step of ['attached', 'sized', 'detached'] as const) {
      fault = step;
      assert.equal((await open()).code, 'DOCUMENT_ACTIVATION_FAILED');
      assert.equal(runtime.workspace.current, first); assert.equal(runtime.host.current, first.preview.view);
      assert.ok(ui.contentView.children.includes(first.preview.view)); assert.equal(first.preview.isActive(), true);
      assert.deepEqual(first.input.snapshot(), before); assert.equal(webContents.getAllWebContents().length, contentCount);
      assert.deepEqual(await readFile(entry), original);
    }
    pass('real native attach, bounds and detach failures each restore the old Preview and input after discard approval; candidates are destroyed without publishing a new document or leaking WebContents');

    const reviewAnswer = deferred<unknown>(); const reviewStarted = deferred<LeaveReview>();
    review = async (value) => { reviewStarted.resolve(value); return reviewAnswer.promise; };
    const switching = open(); const pendingReview = await reviewStarted.promise;
    await change('确认期间迟到的新文字');
    const busy = (await read()).current!;
    assert.equal((await edit(first.id, { kind: 'apply', value: version(busy.input) })).code, 'WORKSPACE_BUSY');
    reviewAnswer.resolve({ reviewId: pendingReview.reviewId, decision: 'discard' });
    assert.equal((await switching).code, 'STALE_DOCUMENT_REVIEW');
    assert.equal(first.input.snapshot().input!.text, '确认期间迟到的新文字');
    assert.equal(runtime.workspace.current, first); assert.equal(runtime.host.current, first.preview.view);
    pass('pending input arriving through real IPC invalidates an older leave decision while Apply is blocked; the current document and newer text survive');

    review = async (value) => ({ reviewId: value.reviewId, decision: 'discard' });
    const oldInput = first.input.snapshot();
    assert.equal((await open()).outcome, 'opened');
    const second = activeDocument();
    assert.notEqual(second.id, first.id); assert.equal(runtime.host.current, second.preview.view);
    assert.equal(first.preview.contents.isDestroyed(), true); assert.ok(!ui.contentView.children.includes(first.preview.view));
    const copyCount = copyCalls;
    assert.equal((await edit(first.id, { kind: 'save-copy', stateRevision: second.input.snapshot().stateRevision })).code, 'STALE_DOCUMENT');
    assert.equal((await edit(first.id, { kind: 'change', value: { ...version(oldInput),
      inputRevision: oldInput.input!.revision + 1, newText: '旧请求', composing: false } })).code, 'STALE_DOCUMENT');
    assert.equal(copyCalls, copyCount); assert.equal(second.input.snapshot().changes.length, 0);
    choose = async () => copyPath; assert.equal((await open()).outcome, 'opened');
    const reopened = activeDocument();
    assert.deepEqual(await reopened.preview.contents.executeJavaScript('[document.querySelector("h1").textContent,...Array.from(document.querySelectorAll("td"),e=>e.textContent)]'), ['修改标题 <&> 😀', '相同', '仅第二格']);
    assert.equal(reopened.input.snapshot().changes.length, 0);
    pass('successful replacement shares one current ID across Main, Preview and preload; late old-document edit/save requests cannot hit equal revisions on the new file, and a saved copy reopens in a fresh verified mapping');

    await select('h1'); await change('崩溃时保留的未应用文字');
    const savedState = reopened.input.snapshot(); const candidateHash = reopened.draft.candidate.resultHash;
    const priorConnection: WorkspaceConnection = await ui.webContents.executeJavaScript('workspaceProbe.connect()');
    const crashReview = deferred<unknown>(); const crashStarted = deferred<LeaveReview>();
    review = async (value) => { crashStarted.resolve(value); return crashReview.promise; };
    choose = async () => entry;
    void open().catch(() => {}); const crashRequest = await crashStarted.promise;
    ui.webContents.forcefullyCrashRenderer();
    await until(() => !runtime.connected && runtime.workspace.snapshot().phase === 'idle', 'crashed renderer cancels review');
    assert.equal(runtime.workspace.current, reopened); assert.equal(runtime.host.current, reopened.preview.view);
    assert.deepEqual(reopened.input.snapshot(), savedState); assert.equal(reopened.draft.candidate.resultHash, candidateHash);
    assert.equal(reopened.preview.isActive(), true);
    crashReview.resolve({ reviewId: crashRequest.reviewId, decision: 'discard' }); await delay(20);
    assert.equal(runtime.workspace.current, reopened);
    await runtime.reloadUI(); const restored = await read();
    assert.equal(restored.current!.id, reopened.id); assert.equal(restored.current!.input.input!.text, savedState.input!.text);
    assert.equal(await ui.webContents.executeJavaScript(`workspaceProbe.request(${JSON.stringify({ sessionId: priorConnection.sessionId, sequence: 99999, command: { kind: 'read' } })})`), null);
    pass('actual UI renderer crash cancels a never-returning leave review, retires its candidate and retains Main pending text/candidate/Preview; Main reload reconnects the same document with a new token and rejects late old approval/token');

    await apply();
    const chooserAnswer = deferred<string | undefined>(); const chooserStarted = deferred<void>();
    chooseCopy = async () => { chooserStarted.resolve(); return chooserAnswer.promise; };
    const savingInput = (await read()).current!.input;
    void edit(reopened.id, { kind: 'save-copy', stateRevision: savingInput.stateRevision }).catch(() => {});
    await chooserStarted.promise;
    assert.equal(reopened.input.snapshot().phase, 'saving');
    await ui.loadURL(EDITOR_URL); // Main navigation revokes the old page; no automatic rebind.
    await until(() => !runtime.connected && reopened.input.snapshot().phase === 'idle', 'revoked chooser releases input');
    const ignoredCopy = join(directory, 'late-never-write.html');
    chooserAnswer.resolve(ignoredCopy); await delay(20);
    await assert.rejects(stat(ignoredCopy), { code: 'ENOENT' });
    assert.equal(reopened.input.snapshot().changes.length, 1); assert.equal(runtime.workspace.current, reopened);
    await runtime.reloadUI(); await read();
    pass('navigation revokes the scoped API and settles an outstanding save chooser without waiting for it to return; later selected paths do not create files and the explicitly applied draft remains available after Main reload');

    const connection: WorkspaceConnection = await ui.webContents.executeJavaScript('workspaceProbe.connect()');
    const baseline = await read();
    await ui.webContents.executeJavaScript('window.observed=[];haeWorkspace.onState(s=>observed.push(s.stateRevision));haeWorkspace.onState(()=>{throw Error("callback")});void 0');
    ui.webContents.send(WORKSPACE_STATE, { sessionId: connection.sessionId, state: { ...baseline, stateRevision: 1, current: null } });
    ui.webContents.send(WORKSPACE_STATE, { sessionId: randomUUID(), state: { ...baseline, stateRevision: baseline.stateRevision + 100, current: null } });
    await delay(10); assert.equal((await read()).current!.id, reopened.id);
    for (const command of [{ kind: 'open', stateRevision: baseline.stateRevision, path: entry },
      { kind: 'edit', documentId: reopened.id, value: { kind: 'save-copy', stateRevision: 1, overwrite: true } }, { kind: 'dispose' }]) {
      assert.equal(await ui.webContents.executeJavaScript(`workspaceProbe.request(${JSON.stringify({ sessionId: connection.sessionId, sequence: 99999, command })})`), null);
    }
    const replay = { sessionId: connection.sessionId, sequence: 99999, command: { kind: 'read' } };
    assert.ok(await ui.webContents.executeJavaScript(`workspaceProbe.request(${JSON.stringify(replay)})`));
    assert.equal(await ui.webContents.executeJavaScript(`workspaceProbe.request(${JSON.stringify(replay)})`), null);
    pass('workspace state notifications reject old versions and foreign connection IDs; raw test IPC rejects paths, overwrite/force operations and replay while callback exceptions cannot corrupt state');

    const closeAnswer = deferred<unknown>(); const closeStarted = deferred<LeaveReview>();
    review = async (value) => { closeStarted.resolve(value); return closeAnswer.promise; };
    const beforeReviews = reviewCalls;
    ui.close(); ui.close(); const closing = await closeStarted.promise;
    assert.equal(reviewCalls, beforeReviews + 1); assert.equal(ui.isDestroyed(), false);
    assert.equal(closing.currentName, reopened.name);
    closeAnswer.resolve({ reviewId: closing.reviewId, decision: 'cancel' });
    await until(() => !runtime.closing, 'cancel native close'); assert.equal(ui.isDestroyed(), false);
    assert.equal(runtime.workspace.current, reopened); assert.equal(runtime.host.current, reopened.preview.view);
    review = async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' });
    const closeCopy = join(directory, '保存后关闭.html'); chooseCopy = async () => closeCopy;
    const closeExpected = Buffer.from(reopened.draft.candidate.bytes);
    ui.close(); await until(() => ui.isDestroyed(), 'verified copy then native close');
    assert.deepEqual(await readFile(closeCopy), closeExpected); assert.equal(reopened.preview.contents.isDestroyed(), true);
    assert.equal(runtime.workspace.current, null);
    assert.deepEqual(await readFile(entry), original); assert.deepEqual(await readFile(secondPath), secondBytes);
    assert.deepEqual(await readFile(join(directory, 'keep.css')), css); assert.deepEqual(await readFile(copyPath), expected);
    assert.equal(errors.length, 0);
    pass('the same session intercepts repeated native window.close calls, keeps current view on cancel, and closes only after a verified explicit new-file save; all original HTML/CSS/copy source bytes remain unchanged');

    // A native resize failure makes view state uncertain. Preserve late input,
    // but disallow another draft mutation, save, document open or native close.
    await runtime.dispose();
    let failBounds = false;
    ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: preferences });
    lockContents(ui.webContents);
    runtime = createWorkspaceSession(ui, outputRoot, {
      chooseOpen: async () => entry, chooseCopy: async () => undefined,
      review: async (value) => ({ reviewId: value.reviewId, decision: 'discard' }), reportError: (code) => errors.push(code),
      bounds: () => {
        if (failBounds) throw new Error('native bounds unavailable');
        const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height };
      },
    });
    await ui.loadURL(EDITOR_URL); assert.equal((await open()).outcome, 'opened'); ui.showInactive();
    await select('h1'); await change('视图失败前输入');
    const damaged = activeDocument();
    failBounds = true; ui.setSize(980, 660);
    await until(() => runtime.workspace.snapshot().cleanupPending, 'native resize invalidates activation');
    assert.equal(runtime.host.available, false); assert.equal(runtime.workspace.current, damaged);
    await change('视图失败后迟到输入');
    const damagedInput = (await read()).current!.input;
    assert.equal((await edit(damaged.id, { kind: 'apply', value: version(damagedInput) })).code, 'DOCUMENT_CLEANUP_REQUIRED');
    assert.equal((await edit(damaged.id, { kind: 'save-copy', stateRevision: damagedInput.stateRevision })).code, 'DOCUMENT_CLEANUP_REQUIRED');
    assert.equal((await open()).code, 'DOCUMENT_CLEANUP_REQUIRED');
    ui.close(); await until(() => !runtime.closing && errors.at(-1) === 'DOCUMENT_CLEANUP_REQUIRED', 'uncertain view blocks native close');
    assert.equal(ui.isDestroyed(), false); assert.equal(damaged.preview.isActive(), true);
    assert.equal(damaged.input.snapshot().input!.text, '视图失败后迟到输入');
    assert.deepEqual(Buffer.from(damaged.draft.candidate.bytes), original); assert.deepEqual(await readFile(entry), original);
    pass('a real native resize event with injected bounds failure marks the session unavailable, retains late input and original bytes, and blocks Apply/Save/Open/Close instead of proceeding with an uncertain view');

    await writeFile(join(results, 'session.json'), JSON.stringify({ status: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      platform: { os: type(), release: release(), arch: arch() }, versions: process.versions, passed,
      fileHashes: { original: hash(original), second: hash(secondBytes), css: hash(css), copy: hash(expected), closeCopy: hash(closeExpected) } }, null, 2));
  } finally { await runtime.dispose(); if (!ui.isDestroyed()) ui.destroy(); }
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'session.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  await runtime?.dispose(); if (ui && !ui.isDestroyed()) ui.destroy(); app.exit(1);
});
