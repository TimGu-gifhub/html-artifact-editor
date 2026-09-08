import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { createEditorBridge } from '../../src/main/editor/bridge.ts';
import { acceptsEditorSender } from '../../src/main/editor/authority.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createDraftSession } from '../../src/main/draft/session.ts';
import { createInputController } from '../../src/main/draft/input.ts';
import { createNewFileWriter } from '../../src/platform/new-file.ts';
import { EDITOR_STATE, EDITOR_URL } from '../../src/contracts/editor.ts';
import type { EditorConnection, EditorReply, EditorResult } from '../../src/contracts/editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';

registerSchemes(); app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'editor-profile'));
const passed: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const previews = new PreviewController(outputRoot);
let ui: BrowserWindow;
let peer: BrowserWindow | undefined;
let bridge: ReturnType<typeof createEditorBridge> | undefined;
let input: ReturnType<typeof createInputController> | undefined;
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
async function call(method: string, value?: unknown): Promise<EditorResult> {
  return ui.webContents.executeJavaScript(`haeEditor[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
}
async function read(): Promise<InputSnapshot> {
  const result = await call('read'); assert.equal(result.ok, true); assert.ok(result.state); return result.state;
}
const version = (state: InputSnapshot) => ({ editToken: state.input!.editToken, inputRevision: state.input!.revision });

async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const directory = await mkdtemp(join(results, 'editor-case-'));
  const assets = join(directory, 'bundled'); await mkdir(assets);
  // Self-authored inert transport fixture, not a product UI or visual target.
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>IPC test fixture</title>');
  await writeFile(join(assets, 'other.html'), '<!doctype html><title>Wrong URL</title>');
  const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制报告</title></head><body><h1>A &amp; 😀</h1><table><tr><td>相同</td><td>相同</td></tr></table><!-- keep --></body></html>');
  const entry = join(directory, 'original.html'); await writeFile(entry, original);
  const preview = await previews.open(entry);
  const mapping = await createPreviewMapping(outputRoot, preview);
  assert.equal(mapping.status, 'ready');
  const draft = createDraftSession(outputRoot, mapping);
  input = createInputController(mapping, draft);
  const uiSession = session.fromPartition(`editor-test-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', assets);
  const preferences = { ...securePreferences, session: uiSession, preload: join(outputRoot, 'editor/probe/index.cjs') };
  ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: preferences });
  lockContents(ui.webContents);
  ui.contentView.addChildView(preview.view); preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
  let choose: () => Promise<string | undefined> = async () => undefined;
  let chooseCalls = 0; let writes = 0;
  const writer = await createNewFileWriter(directory);
  const createBridge = () => createEditorBridge(ui.webContents, input!, async () => { chooseCalls++; return choose(); },
    { directory: writer.directory, write: async (path, bytes) => { writes++; return writer.write(path, bytes); } });
  bridge = createBridge();
  try {
    await ui.loadURL('editor://app/other.html');
    assert.equal(await ui.webContents.executeJavaScript('typeof haeEditor'), 'undefined');
    assert.equal(await ui.webContents.executeJavaScript('editorProbe.connect()'), null);
    await ui.loadURL(EDITOR_URL);
    const initial = await read(); assert.equal(initial.selection, null); assert.equal(bridge.active, true);
    assert.deepEqual(await ui.webContents.executeJavaScript('Object.keys(haeEditor).sort()'),
      ['apply', 'begin', 'change', 'onState', 'read', 'resolve', 'saveCopy']);
    assert.deepEqual(await ui.webContents.executeJavaScript('[typeof require,typeof process,typeof ipcRenderer,typeof Buffer]'), Array(4).fill('undefined'));
    assert.deepEqual(await preview.contents.executeJavaScript('[typeof haeEditor,typeof editorProbe,typeof require,typeof ipcRenderer]'), Array(4).fill('undefined'));
    pass('real isolated preload exposes seven fixed methods only at the exact trusted URL; user Preview has no editor or IPC capability');

    await ui.webContents.executeJavaScript(`(() => {
      window.stateEvents=[]; window.stopEvents=haeEditor.onState(s=>stateEvents.push(s));
      window.stopThrowing=haeEditor.onState(()=>{throw Error('subscriber failure')});
      const f=document.createElement('iframe');document.body.append(f);
    })()`);
    const child = ui.webContents.mainFrame.frames[0]; assert.ok(child);
    assert.equal(await child.executeJavaScript('typeof haeEditor'), 'undefined');
    assert.equal(acceptsEditorSender({ contents: ui.webContents, session: uiSession,
      frame: () => ui.webContents.mainFrame, isActive: () => true },
    { sender: ui.webContents, senderFrame: child } as IpcMainInvokeEvent), false);
    peer = new BrowserWindow({ show: false, webPreferences: preferences }); lockContents(peer.webContents);
    await peer.loadURL(EDITOR_URL);
    assert.equal(await peer.webContents.executeJavaScript('editorProbe.connect().then(()=>"unexpected",()=>"rejected")'), 'rejected');
    peer.destroy(); peer = undefined;
    pass('another real window with the same session/URL cannot reach the scoped handler; a real child frame has no API and fails the Main sender predicate');

    ui.showInactive();
    const point = await preview.contents.executeJavaScript(`(() => {
      const r=document.createRange();r.selectNodeContents(document.querySelector('h1'));const b=r.getBoundingClientRect();
      return {x:Math.round(b.x+6),y:Math.round(b.y+b.height/2)};
    })()`);
    preview.contents.focus();
    preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => mapping.selection !== null, 'native selection');
    let state = await read();
    assert.equal((await call('begin', { selection: state.selection!.reference, draftRevision: state.draftRevision })).ok, true);
    state = await read();
    assert.equal((await call('change', { ...version(state), inputRevision: state.input!.revision + 1, newText: '未应用中文', composing: true })).ok, true);
    state = await read();
    assert.equal((await call('apply', version(state))).code, 'INPUT_COMPOSING');
    assert.equal((await call('saveCopy', state.stateRevision)).code, 'INPUT_COMPOSING');
    assert.equal(chooseCalls, 0); assert.equal(writes, 0); assert.deepEqual(Buffer.from(draft.candidate.bytes), original);
    assert.equal(await preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'A & 😀');
    assert.equal((await call('change', { ...version(state), inputRevision: state.input!.revision + 1, newText: 'invalid\0text', composing: false })).ok, true);
    state = await read();
    assert.equal((await call('apply', version(state))).code, 'INVALID_TEXT_NUL');
    assert.equal((await read()).input!.text, 'invalid\0text');
    pass('public bridge reaches Main pending input without DOM/file changes; composing and validation failures preserve text and return bounded error codes');

    state = await read();
    assert.equal((await call('change', { ...version(state), inputRevision: state.input!.revision + 1,
      newText: '新标题 <script>& 😀', composing: false })).ok, true);
    state = await read();
    assert.equal((await call('apply', version(state))).ok, true);
    state = await read(); assert.equal(state.changes.length, 1); assert.equal(state.hasUnappliedInput, false);
    assert.equal(await preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '新标题 <script>& 😀');
    assert.equal((await call('resolve', { ...version(state), decision: 'discard', intentSequence: null })).ok, true);
    state = await read(); assert.equal(state.input, null);
    const cancelled = await call('saveCopy', state.stateRevision);
    assert.equal(cancelled.ok, true); assert.deepEqual(cancelled.copy, { status: 'cancelled' });
    assert.equal(writes, 0); assert.equal((await read()).lastCopy, null);
    choose = async () => join(directory, '桥接另存.html');
    const created = await call('saveCopy', (await read()).stateRevision);
    assert.equal(created.ok, true); assert.equal(created.copy!.status, 'created');
    state = await read(); assert.equal(state.lastCopy!.status, 'created'); assert.equal(state.lastCopy!.name, '桥接另存.html');
    const copy = await readFile(join(directory, '桥接另存.html'));
    assert.deepEqual(copy, Buffer.from(original.toString('utf8').replace('A &amp; 😀', '新标题 &lt;script&gt;&amp; 😀')));
    assert.equal(hash(copy), state.candidateHash); assert.equal(state.changes.length, 1); assert.equal(writes, 1);
    assert.equal(JSON.stringify(state).includes(directory), false); assert.equal(Object.hasOwn(state.lastCopy!, 'path'), false);
    choose = async () => undefined;
    const cancelledAfterSuccess = await call('saveCopy', (await read()).stateRevision);
    assert.deepEqual(cancelledAfterSuccess.copy, { status: 'cancelled' });
    assert.equal(cancelledAfterSuccess.state!.lastCopy!.status, 'created'); assert.equal(writes, 1);
    pass('real renderer IPC applies literal text only to the owned Text; cancelled chooser writes nothing and explicit copy matches an independent full-byte expectation');

    choose = async () => entry;
    const refused = await call('saveCopy', (await read()).stateRevision);
    assert.equal(refused.ok, false); assert.equal(refused.code, 'COPY_FAILED'); assert.equal(refused.copy!.status, 'failed');
    assert.deepEqual(await readFile(entry), original); assert.equal(writes, 2);
    choose = async () => { throw new Error('PRIVATE_CHOOSER_DETAIL'); };
    const failed = await call('saveCopy', (await read()).stateRevision);
    assert.equal(failed.code, 'EDITOR_COMMAND_FAILED'); assert.equal(JSON.stringify(failed).includes('PRIVATE_CHOOSER_DETAIL'), false);
    assert.equal(failed.copy, null);
    assert.equal((await read()).changes.length, 1); assert.equal(writes, 2);
    const connection: EditorConnection = await ui.webContents.executeJavaScript('editorProbe.connect()');
    await ui.webContents.executeJavaScript('stopThrowing()');
    const beforeEvents: InputSnapshot[] = await ui.webContents.executeJavaScript('stateEvents');
    assert.ok(beforeEvents.length > 3);
    assert.ok(beforeEvents.every((value, index) => index === 0 || value.stateRevision > beforeEvents[index - 1]!.stateRevision));
    ui.webContents.mainFrame.send(EDITOR_STATE, { sessionId: connection.sessionId, state: initial });
    ui.webContents.mainFrame.send(EDITOR_STATE, { sessionId: randomUUID(), state: { ...state, stateRevision: 999999 } });
    await delay(30);
    assert.equal(await ui.webContents.executeJavaScript('stateEvents.length'), beforeEvents.length);
    await ui.webContents.executeJavaScript('stopEvents()');
    pass('per-request copy outcome distinguishes cancellation after success and refused overwrite; subscriptions ignore old snapshots and exceptions cannot leak paths or erase drafts');

    const request = { sessionId: connection.sessionId, sequence: 10000, command: { kind: 'read' } };
    const raw = (value: unknown, extra = ''): Promise<EditorReply | null> =>
      ui.webContents.executeJavaScript(`editorProbe.request(${JSON.stringify(value)}${extra})`);
    assert.equal(await ui.webContents.executeJavaScript('editorProbe.connect({path:"x"})'), null);
    for (const bad of [{ ...request, sessionId: randomUUID() }, { ...request, offset: 1 },
      { ...request, command: { kind: 'save-copy', stateRevision: state.stateRevision, path: 'forged.html' } },
      { ...request, command: { kind: 'invoke', channel: 'fs', path: 'forged.html' } }]) assert.equal(await raw(bad), null);
    assert.equal(await raw(request, ', "extra"'), null);
    const accepted = await raw(request); assert.equal(accepted!.result.ok, true);
    assert.equal(await raw(request), null); assert.equal(await raw({ ...request, sequence: 9999 }), null);
    assert.equal(writes, 2);
    bridge.close();
    // A new explicitly attached bridge has a new connection; old request data is never reusable.
    bridge = createBridge(); await ui.reload();
    await until(() => !ui.webContents.isLoading(), 'reloaded trusted fixture');
    const reconnected = await read(); assert.equal(reconnected.changes.length, 1);
    const nextConnection: EditorConnection = await ui.webContents.executeJavaScript('editorProbe.connect()');
    assert.notEqual(nextConnection.sessionId, connection.sessionId); assert.equal(await raw({ ...request, sequence: 10001 }), null);
    pass('raw real IPC rejects extra fields/arguments, path authority, unknown commands, cross-session requests and replay without side effects');

    let releaseChooser: (value: string | undefined) => void = () => {};
    choose = () => new Promise((resolveChoice) => { releaseChooser = resolveChoice; });
    const callsBefore = chooseCalls;
    const saving = call('saveCopy', reconnected.stateRevision);
    await until(() => chooseCalls === callsBefore + 1, 'pending native chooser callback');
    bridge.close(); releaseChooser(join(directory, 'must-not-be-created.html'));
    assert.equal((await saving).code, 'EDITOR_DISCONNECTED');
    assert.equal(writes, 2); assert.equal(input.snapshot().phase, 'idle'); assert.equal(input.snapshot().changes.length, 1);
    assert.deepEqual(await readFile(entry), original);
    pass('revoking a bridge during a pending chooser prevents a subsequent write and retains the current Main candidate');

    bridge = createBridge(); await ui.reload(); await until(() => !ui.webContents.isLoading(), 'second trusted load');
    await read(); assert.equal(bridge.active, true);
    await ui.loadURL('editor://app/other.html');
    assert.equal(bridge.active, false); assert.equal(input.snapshot().changes.length, 1);
    assert.equal(await ui.webContents.executeJavaScript('editorProbe.connect().then(()=>"unexpected",()=>"revoked")'), 'revoked');
    assert.deepEqual(await readFile(entry), original);
    pass('actual main-frame navigation revokes handlers; loaded page and old session cannot reuse input authority while Main keeps source/copy evidence');

    bridge = createBridge(); await ui.loadURL(EDITOR_URL);
    state = await read();
    assert.equal((await call('begin', { selection: state.selection!.reference, draftRevision: state.draftRevision })).ok, true);
    state = await read();
    assert.equal((await call('change', { ...version(state), inputRevision: state.input!.revision + 1,
      newText: '界面崩溃前尚未应用', composing: false })).ok, true);
    const retained = input.snapshot().input;
    ui.webContents.forcefullyCrashRenderer();
    await until(() => !bridge!.active, 'renderer crash revocation');
    assert.equal(input.snapshot().input, retained); assert.equal(input.snapshot().input!.text, '界面崩溃前尚未应用');
    assert.equal(hash(draft.candidate.bytes), hash(copy)); assert.deepEqual(await readFile(entry), original);
    pass('actual trusted renderer crash revokes its bridge while Main retains exact pending text and the verified candidate; no crash-persistence claim');
    await writeFile(join(results, 'editor.json'), JSON.stringify({ status: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      platform: { os: type(), release: release(), arch: arch() }, versions: process.versions,
      passed, fileHashes: { original: hash(original), copy: hash(copy) } }, null, 2));
  } finally {
    bridge?.close(); input.close(); await previews.close(); peer?.destroy();
    if (!ui.isDestroyed()) ui.destroy(); uiSession.protocol.unhandle('editor');
  }
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'editor.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  bridge?.close(); input?.close(); await previews.close(); peer?.destroy();
  if (ui && !ui.isDestroyed()) ui.destroy(); app.exit(1);
});
