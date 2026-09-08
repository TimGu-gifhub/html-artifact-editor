import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, BrowserWindow, session } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import type { WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import type { LeaveReview, WorkspaceSnapshot } from '../../src/contracts/workspace.ts';
import { registerSchemes } from '../../src/main/application.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { createProjectPreview } from '../../src/main/preview/project-preview.ts';
import type { ProjectPreview } from '../../src/main/preview/project-preview.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { authorizeProject } from '../../src/main/protocol/project-files.ts';
import { resourceURL } from '../../src/main/protocol/resource-policy.ts';
import { createWorkspaceSession } from '../../src/main/workspace/session.ts';
import { testFont } from '../security/test-font.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'project-profile'));
const passed: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
let ui: BrowserWindow; let runtime: ReturnType<typeof createWorkspaceSession>;
let interactive: ProjectPreview | undefined; let interactiveWindow: BaseWindow | undefined;
const server = createServer((_req, res) => { res.end('MUST NOT CONNECT'); }); let connections = 0;
server.on('connection', () => { connections++; });
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
async function call(expression: string): Promise<WorkspaceResult> { return ui.webContents.executeJavaScript(expression); }
async function read(): Promise<WorkspaceSnapshot> {
  const result = await call('haeWorkspace.read()'); assert.equal(result.ok, true); assert.ok(result.state); return result.state;
}
const currentDocument = () => runtime.workspace.current!;
async function openDirectory(): Promise<WorkspaceResult> { return call(`haeWorkspace.openDirectory(${(await read()).stateRevision})`); }
async function switchEntry(): Promise<WorkspaceResult> {
  const state = await read(); return call(`haeWorkspace.switchEntry(${JSON.stringify(state.current!.id)},${state.stateRevision})`);
}
async function change(text: string, composing = false): Promise<void> {
  const value = (await read()).current!; const input = value.input.input!;
  const command = { kind: 'change', value: { editToken: input.editToken, inputRevision: input.revision + 1, newText: text, composing } };
  const result = await call(`haeWorkspace.edit(${JSON.stringify(value.id)},${JSON.stringify(command)})`);
  assert.equal(result.ok, true, result.code ?? undefined);
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const fixture = await mkdtemp(join(results, 'project-case-'));
  const root = join(fixture, '项目 中文 🧪'); const reports = join(root, '报告 目录'); const assets = join(root, 'assets');
  await mkdir(reports, { recursive: true }); await mkdir(assets);
  const outside = join(fixture, 'outside.html'); await writeFile(outside, '<!doctype html><p>outside</p>');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}`;
  const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>目录样例</title><base href="../">'
    + '<link rel="stylesheet" href="assets/theme.css?v=private"><link rel="stylesheet" href="assets/missing.css">'
    + `<link rel="stylesheet" href="${endpoint}/cdn.css?secret=value#private"><script src="assets/main.js"></script>`
    + `<script src="${endpoint}/cdn.js?secret=value"></script></head><body><h1>目录标题 &amp; 😀</h1>`
    + '<img id="local-image" src="assets/图 🧪.svg"><p id="font-probe">A</p><!-- preserve --></body></html>');
  const css = Buffer.from('@font-face{font-family:HaeTest;src:url("./test.ttf")}body{font:24px sans-serif;color:rgb(12,34,56)}#font-probe{font-family:HaeTest}');
  const js = Buffer.from(`window.projectScript=41;fetch(${JSON.stringify(`${endpoint}/api?secret=value`)}).catch(()=>{window.apiBlocked=true});`);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="green"/></svg>');
  const font = testFont();
  const entry = join(reports, '入口 😀.html'); const nextEntry = join(reports, 'next.html'); const copyPath = join(reports, '副本 😀.html');
  const second = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>next</title></head><body><h1>下一份</h1></body></html>');
  for (const [path, bytes] of [[entry, original], [nextEntry, second], [join(assets, 'theme.css'), css],
    [join(assets, 'main.js'), js], [join(assets, '图 🧪.svg'), svg], [join(assets, 'test.ttf'), font]] as const) await writeFile(path, bytes);
  for (const name of ['.git', 'backups']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'private.css'), 'PRIVATE'); }
  const bundled = join(fixture, 'bundled'); await mkdir(bundled);
  await writeFile(join(bundled, 'index.html'), '<!doctype html><title>Project transport fixture</title>');
  const uiSession = session.fromPartition(`project-test-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', bundled);
  ui = new BrowserWindow({ show: false, width: 960, height: 640,
    webPreferences: { ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs') } });
  lockContents(ui.webContents);
  let chosenRoot: string | undefined; let chosenEntry: string | undefined; let entryCalls = 0; let rootCalls = 0;
  let chooseRoot: () => Promise<string | undefined> = async () => chosenRoot;
  let review: (value: LeaveReview) => Promise<unknown> = async (value) => ({ reviewId: value.reviewId, decision: 'cancel' });
  const errors: string[] = [];
  runtime = createWorkspaceSession(ui, outputRoot, {
    chooseOpen: async () => undefined, chooseCopy: async () => copyPath, review: (value) => review(value), reportError: (code) => errors.push(code),
    bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; },
    projectChoices: { chooseDirectory: () => { rootCalls++; return chooseRoot(); },
      chooseEntry: async (directory) => { assert.equal(directory, root); entryCalls++; return chosenEntry; } },
  });
  try {
    await ui.loadURL(EDITOR_URL); await read();
    assert.equal((await openDirectory()).outcome, 'cancelled'); assert.equal(entryCalls, 0);
    chosenRoot = root;
    assert.equal((await openDirectory()).outcome, 'cancelled'); assert.equal(entryCalls, 1);
    chosenEntry = outside; assert.equal((await openDirectory()).code, 'RESOURCE_BLOCKED');
    assert.equal(runtime.workspace.current, null); assert.equal(runtime.host.current, null);
    pass('directory and entry are separate Main choices; cancelling either creates no document, and selecting an outside HTML never expands the root grant');

    chosenEntry = entry; assert.equal((await openDirectory()).outcome, 'opened');
    const first = currentDocument(); const initial = await read();
    assert.equal(initial.current!.project.name, '项目 中文 🧪'); assert.equal(initial.current!.project.entry, '报告 目录/入口 😀.html');
    assert.equal(first.preview.grant.root, root); assert.equal(first.mapping.status, 'ready');
    assert.deepEqual(first.preview.sourceBytes(), new Uint8Array(original));
    ui.showInactive();
    const local = await first.preview.contents.executeJavaScript(`(async()=>{
      await document.fonts.ready; const font=await document.fonts.load('16px HaeTest','A');
      return {color:getComputedStyle(document.body).color,image:document.querySelector('#local-image').naturalWidth,font:font.length,script:typeof projectScript};
    })()`);
    assert.deepEqual(local, { color: 'rgb(12, 34, 56)', image: 12, font: 1, script: 'undefined' });
    pass('a nested Unicode/BOM/CRLF entry uses its explicit larger root; relative base, sibling CSS, image and real font load in Chromium while proofreading scripts remain disabled');

    await until(() => first.preview.diagnostics().some((item) => item.target === `${endpoint}/cdn.css`), 'CSP-blocked CDN diagnostic');
    const resources = (await read()).current!.project.resources;
    assert.ok(resources.items.some((item) => item.target === 'project:/assets/missing.css' && item.resourceType === 'stylesheet' && item.reason === 'RESOURCE_MISSING'));
    assert.ok(resources.items.some((item) => item.target === `${endpoint}/cdn.css` && item.resourceType === 'stylesheet' && item.reason === 'CSP_BLOCKED'));
    assert.ok(resources.items.some((item) => item.target === 'project:/assets/main.js' && item.resourceType === 'script' && item.reason === 'CSP_BLOCKED'));
    const json = JSON.stringify(resources); assert.equal(json.includes('secret'), false); assert.equal(json.includes('value'), false); assert.equal(json.includes(fixture), false);
    const rev = (await read()).stateRevision;
    await ui.webContents.executeJavaScript(`(()=>{
      globalThis.resourceNotice = new Promise(resolve => {
        const stop = haeWorkspace.onState(state => {
          if (state.current?.project.resources.items.some(item => item.target === 'project:/assets/later-missing.css')) {
            stop(); resolve(state);
          }
        });
      }); return true;
    })()`);
    const absent = await first.preview.session.fetch(resourceURL(first.preview.identity.sessionId, 'assets/later-missing.css'));
    assert.equal(absent.status, 403); assert.equal(await absent.text(), '');
    await until(() => runtime.workspace.snapshot().stateRevision > rev, 'diagnostic state notification');
    const notification: WorkspaceSnapshot = await ui.webContents.executeJavaScript(`Promise.race([resourceNotice,
      new Promise((_, reject) => setTimeout(() => reject(new Error('RESOURCE_NOTIFICATION_TIMEOUT')), 2500))])`);
    assert.equal(notification.current!.id, first.id); assert.ok(notification.stateRevision > rev);
    assert.ok(notification.current!.project.resources.items.some((item) => item.target === 'project:/assets/later-missing.css'));
    assert.ok((await read()).current!.project.resources.items.some((item) => item.target === 'project:/assets/later-missing.css'));
    for (const path of ['.git/private.css', 'backups/private.css']) {
      await assert.rejects(first.preview.session.fetch(`artifact://${first.preview.identity.sessionId}/${path}`), /ERR_BLOCKED_BY_CLIENT/);
    }
    assert.equal(connections, 0);
    pass('Main diagnostics include missing paths, CSP-blocked CDN URL/type and disabled scripts, update through the production workspace IPC, strip query/credentials/native paths and keep all network connections at zero');

    const point = await first.preview.contents.executeJavaScript('(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector("h1"));const b=r.getBoundingClientRect();return{x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)}})()');
    first.preview.contents.focus();
    first.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    first.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => !!first.mapping.selection, 'native title selection');
    const selected = (await read()).current!;
    assert.equal((await call(`haeWorkspace.edit(${JSON.stringify(first.id)},${JSON.stringify({ kind: 'begin', value: {
      selection: selected.input.selection!.reference, draftRevision: selected.input.draftRevision } })})`)).ok, true);
    await change('保留中文组合态', true); const beforeEntryCalls = entryCalls;
    assert.equal((await switchEntry()).code, 'INPUT_COMPOSING'); assert.equal(entryCalls, beforeEntryCalls);
    await change('保留未应用中文'); const retained = first.input.snapshot();
    chosenEntry = undefined; assert.equal((await switchEntry()).outcome, 'cancelled');
    chosenEntry = outside; assert.equal((await switchEntry()).code, 'RESOURCE_BLOCKED');
    chosenEntry = nextEntry; assert.equal((await switchEntry()).outcome, 'cancelled');
    assert.equal(runtime.workspace.current, first); assert.deepEqual(first.input.snapshot(), retained); assert.deepEqual(await readFile(entry), original);
    assert.equal(rootCalls, 4, 'entry changes never issue a new root grant');
    pass('entry changes retain the original root and existing draft rules: composing blocks the chooser, cancelled/outside/declined choices preserve pending input, live view and original bytes');

    const applying = first.input.snapshot().input!;
    assert.equal((await call(`haeWorkspace.edit(${JSON.stringify(first.id)},${JSON.stringify({ kind: 'apply', value: {
      editToken: applying.editToken, inputRevision: applying.revision } })})`)).ok, true);
    const expected = Buffer.from(original.toString().replace('<h1>目录标题 &amp; 😀</h1>', '<h1>保留未应用中文</h1>'));
    assert.deepEqual(Buffer.from(first.draft.candidate.bytes), expected);
    const saved = await call(`haeWorkspace.edit(${JSON.stringify(first.id)},${JSON.stringify({ kind: 'save-copy', stateRevision: first.input.snapshot().stateRevision })})`);
    assert.equal(saved.copy?.status, 'created'); assert.deepEqual(await readFile(copyPath), expected); assert.deepEqual(await readFile(entry), original);
    chosenEntry = copyPath; review = async (value) => ({ reviewId: value.reviewId, decision: 'discard' });
    assert.equal((await switchEntry()).outcome, 'opened');
    const copy = currentDocument(); assert.equal(copy.preview.grant.rootIdentity, first.preview.grant.rootIdentity);
    assert.equal(copy.preview.grant.root, root); assert.equal(copy.preview.grant.entry, '报告 目录/副本 😀.html');
    assert.equal(first.preview.contents.isDestroyed(), true);
    assert.equal(await copy.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '保留未应用中文');
    assert.equal(await copy.preview.contents.executeJavaScript('getComputedStyle(document.body).color'), 'rgb(12, 34, 56)');
    const stale = await call(`haeWorkspace.switchEntry(${JSON.stringify(first.id)},${(await read()).stateRevision})`);
    assert.equal(stale.code, 'STALE_DOCUMENT');
    pass('a directory document edits through verified native selection and exact byte patches, saves beside its nested entry and reopens under the same root with relative assets intact; old document entry requests are rejected');

    interactive = await createProjectPreview(outputRoot, copy.preview.grant, 'interactive', 1);
    interactiveWindow = new BaseWindow({ show: false, width: 960, height: 640 });
    interactiveWindow.contentView.addChildView(interactive.view); interactive.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    assert.equal(await interactive.contents.executeJavaScript('projectScript'), 41);
    await until(() => interactive!.diagnostics().some((item) => item.target === `${endpoint}/api` && item.resourceType === 'fetch'), 'blocked API diagnostic');
    assert.deepEqual(await interactive.contents.executeJavaScript('[typeof haeWorkspace,typeof haeEditor,typeof require]'), Array(3).fill('undefined'));
    assert.equal(interactive.identity.mode, 'interactive'); assert.equal(connections, 0);
    await interactive.close(); interactive = undefined; interactiveWindow.destroy(); interactiveWindow = undefined;
    pass('the separate read-only interactive preview executes allowed project JS under the same root, reports blocked online API URL/type and exposes no editor/Node capability; the loopback server receives zero connections');

    let finishRoot!: (value: string) => void; let startedRoot!: () => void;
    const rootStarted = new Promise<void>((yes) => { startedRoot = yes; });
    chooseRoot = async () => { startedRoot(); return new Promise<string>((yes) => { finishRoot = yes; }); };
    const beforeLateEntry = entryCalls;
    void openDirectory().catch(() => {}); await rootStarted;
    await ui.loadURL(EDITOR_URL);
    await until(() => runtime.workspace.snapshot().phase === 'idle' && !runtime.connected, 'revoked root chooser');
    finishRoot(root); await delay(20); assert.equal(entryCalls, beforeLateEntry);
    assert.equal(runtime.workspace.current, copy); assert.equal(copy.preview.isActive(), true);
    await runtime.reloadUI(); await read();
    pass('revoking the UI while a directory chooser has not returned cancels its workspace operation; a late directory answer cannot open the second chooser or replace the current entry');

    const movedRoot = `${root}-original`;
    await rename(root, movedRoot); await mkdir(reports, { recursive: true }); await writeFile(nextEntry, second);
    chosenEntry = nextEntry;
    assert.equal((await switchEntry()).code, 'RESOURCE_BLOCKED'); assert.equal(runtime.workspace.current, copy);
    assert.equal(copy.preview.isActive(), true); assert.deepEqual(copy.preview.sourceBytes(), new Uint8Array(expected));
    const noResource = await copy.preview.session.fetch(resourceURL(copy.preview.identity.sessionId, 'assets/theme.css'));
    assert.equal(noResource.status, 403); assert.equal(await noResource.text(), '');
    for (const [relative, bytes] of [['报告 目录/入口 😀.html', original], ['报告 目录/副本 😀.html', expected],
      ['报告 目录/next.html', second], ['assets/theme.css', css], ['assets/main.js', js], ['assets/图 🧪.svg', svg], ['assets/test.ttf', font]] as const) {
      assert.deepEqual(await readFile(join(movedRoot, ...relative.split('/'))), bytes);
    }
    assert.equal(connections, 0); assert.equal(errors.length, 0);
    pass('replacing the root directory after authorization cannot silently regrant entry/resource access; the current document snapshot remains, forbidden reads return no bytes and every original HTML/CSS/JS/image/font byte is unchanged');

    await writeFile(join(results, 'project.json'), JSON.stringify({ status: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      platform: { os: type(), release: release(), arch: arch() }, versions: process.versions, passed, networkConnections: connections,
      fileHashes: { original: hash(original), copy: hash(expected), second: hash(second), css: hash(css), js: hash(js), image: hash(svg), font: hash(font) } }, null, 2));
  } finally {
    await interactive?.close(); if (interactiveWindow && !interactiveWindow.isDestroyed()) interactiveWindow.destroy();
    await runtime.dispose(); if (!ui.isDestroyed()) ui.destroy(); server.close();
  }
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'project.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  await interactive?.close(); if (interactiveWindow && !interactiveWindow.isDestroyed()) interactiveWindow.destroy();
  await runtime?.dispose(); if (ui && !ui.isDestroyed()) ui.destroy(); server.close(); app.exit(1);
});
