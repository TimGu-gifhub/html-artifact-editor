import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, BrowserWindow, ipcMain, session } from 'electron';
import type { IpcMainEvent } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import type { ProjectPreview } from '../../src/main/preview/project-preview.ts';
import { acceptsPreviewReady } from '../../src/main/preview/authority.ts';
import { securePreferences } from '../../src/main/preview/security.ts';
import { PREVIEW_READY_CHANNEL } from '../../src/contracts/preview.ts';
import { resourceURL } from '../../src/main/protocol/resource-policy.ts';
import { testFont } from './test-font.ts';
import { captureReady } from '../helpers/capture.ts';

registerSchemes();
app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'security-profile'));
const passed: string[] = [];
function pass(message: string): void { passed.push(message); console.log(`PASS: ${message}`); }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const previews = new PreviewController(outputRoot);

async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result[relative(root, path).replaceAll('\\', '/')] = hash(await readFile(path));
    }
  }
  await walk(root);
  return result;
}
async function blocked(preview: ProjectPreview, url: string): Promise<void> {
  await assert.rejects(preview.session.fetch(url), /net::ERR_BLOCKED_BY_CLIENT/);
}
async function nodeGlobals(preview: ProjectPreview): Promise<void> {
  assert.deepEqual(await preview.contents.executeJavaScript(`[
    typeof require, typeof process, typeof Buffer, typeof ipcRenderer, typeof haeBootstrap,
    typeof securityProbe, typeof RTCPeerConnection, typeof webkitRTCPeerConnection,
    typeof WebTransport, typeof showOpenFilePicker, typeof showSaveFilePicker,
    typeof showDirectoryPicker
  ]`), Array(12).fill('undefined'));
  assert.equal(preview.acknowledgement.sandboxed, true);
  assert.equal(preview.acknowledgement.contextIsolated, true);
  assert.equal(preview.acknowledgement.readOnly, true);
}

async function run(): Promise<void> {
  await mkdir(results, { recursive: true });
  await app.whenReady();
  const fixtureRoot = await mkdtemp(join(results, 'security-case-'));
  const project = join(fixtureRoot, '项目 中文 🧪');
  await cp(resolve(outputRoot, '../tests/fixtures/security'), project, {
    recursive: true, filter: (source) => basename(source) !== 'README.md',
  });
  await writeFile(join(project, 'assets/test.ttf'), testFont());
  const entry = join(project, 'index.html');
  for (const name of ['.git', 'backups', 'recovery', 'drafts', 'secrets']) {
    await mkdir(join(project, name));
    await writeFile(join(project, name, 'private.css'), 'PRIVATE SENTINEL');
  }
  await writeFile(join(project, 'other.html'), 'PRIVATE HTML');
  const restrictive = '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src \'none\'; style-src \'none\'"><style>body{color:red}</style><p>CSP 原样保留</p><script>window.originalCspBypassed=true</script>';
  await writeFile(join(project, 'restrictive.html'), restrictive);
  const before = await hashes(project);
  const server = createServer((_request, response) => { response.end('NETWORK SHOULD NOT BE REACHED'); });
  let connections = 0;
  server.on('connection', () => { connections++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const window = new BaseWindow({ show: false, width: 960, height: 640 });
  const capture = async (preview: ProjectPreview, name: string): Promise<void> => {
    window.contentView.addChildView(preview.view);
    preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    window.showInactive(); await delay(200);
    await writeFile(join(results, name), await captureReady(preview.contents));
    window.contentView.removeChildView(preview.view);
  };
  try {
    const proofread = await previews.open(entry);
    await nodeGlobals(proofread);
    assert.equal(proofread.identity.mode, 'proofread');
    assert.equal(hash(proofread.sourceBytes()), before['index.html']);
    const response = await proofread.session.fetch(proofread.url);
    assert.equal(hash(new Uint8Array(await response.arrayBuffer())), before['index.html']);
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const local = await proofread.contents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      const loaded = await document.fonts.load('16px HaeTest', 'A');
      return { title: document.querySelector('h1').textContent, color: getComputedStyle(document.body).color,
        border: getComputedStyle(document.querySelector('h1')).borderBottomWidth,
        image: document.querySelector('#local-image').naturalWidth, font: loaded.length,
        script: typeof inlineRan, external: typeof externalRan, module: typeof moduleRan,
        dynamic: document.querySelector('#dynamic').textContent };
    })()`);
    assert.deepEqual(local, { title: '中文 & Emoji 🧪', color: 'rgb(12, 34, 56)', border: '2px',
      image: 40, font: 1, script: 'undefined', external: 'undefined', module: 'undefined', dynamic: '静态原文' });
    pass('S-03: sandboxed proofread; byte-identical entry, Unicode/entities, CSS imports, local SVG image and actual test font loaded');

    await proofread.contents.executeJavaScript(`(() => {
      document.querySelector('#inline-button').click(); document.querySelector('#js-link').click();
      const script = document.createElement('script'); script.textContent = 'window.injectedRan=true'; document.body.append(script);
    })()`);
    assert.deepEqual(await proofread.contents.executeJavaScript('[typeof handlerRan, typeof javascriptURLRan, typeof injectedRan, typeof svgHandlerRan]'), Array(4).fill('undefined'));
    await blocked(proofread, resourceURL(proofread.identity.sessionId, 'assets/local.js'));
    pass('proofread denies inline/external/module scripts, SVG event handlers, injected scripts, onclick and javascript URLs');

    for (const path of ['.git/private.css', 'backups/private.css', 'recovery/private.css', 'drafts/private.css', 'secrets/private.css',
      'other.html', 'index.html:secret', '%252e%252e/private.css', '%2fprivate.css', '%5c%5cserver/x.css', 'C:/x.css']) {
      await blocked(proofread, `artifact://${proofread.identity.sessionId}/${path}`);
    }
    await blocked(proofread, `artifact://00000000-0000-4000-8000-000000000002/assets/site.css`);
    await assert.rejects(proofread.session.fetch(proofread.url, { method: 'POST', body: 'fake write' }), /ERR_BLOCKED_BY_CLIENT/);
    pass('S-01/S-05: live protocol rejects private paths, alternate HTML, encoded paths, ADS, cross-project host and POST');
    await capture(proofread, 'security-proofread.png');

    const oldSession = proofread.session;
    const oldURL = proofread.url;
    await proofread.contents.executeJavaScript("localStorage.setItem('private-session-marker', 'first')");
    const interactive = await previews.open(entry, 'interactive');
    await nodeGlobals(interactive);
    assert.equal(proofread.isActive(), false);
    assert.equal(proofread.contents.isDestroyed(), true);
    await assert.rejects(oldSession.fetch(oldURL), /ERR_BLOCKED_BY_CLIENT/);
    assert.notEqual(interactive.session, oldSession);
    assert.equal(await interactive.contents.executeJavaScript("localStorage.getItem('private-session-marker')"), null);
    assert.deepEqual(await interactive.contents.executeJavaScript(`({inline: inlineRan, external: externalRan,
      module: moduleRan, dynamic: document.querySelector('#dynamic').textContent,
      shadow: document.querySelector('#shadow-host').shadowRoot.textContent,
      canvas: document.querySelector('#canvas').getContext('2d').getImageData(0,0,1,1).data[3]})`),
    { inline: true, external: true, module: 'local module', dynamic: '脚本生成（只读）', shadow: '只读 Shadow DOM', canvas: 255 });
    pass('T-08/S-02/S-05: local classic/module/inline JS, Shadow DOM and Canvas are read-only; mode switch destroys and revokes old session and storage');
    await capture(interactive, 'security-interactive.png');

    const forbidden = [endpoint, `https://127.0.0.1:${address.port}/`, `http://localhost:${address.port}/`,
      'https://example.invalid/', 'http://192.168.1.1/', 'http://10.0.0.1/', 'http://[::1]:9/',
      'file:///C:/Windows/win.ini', 'editor://app/index.html'];
    for (const url of forbidden) await blocked(interactive, url);
    const attacks = await interactive.contents.executeJavaScript(`(async () => {
      const endpoint = ${JSON.stringify(endpoint)};
      const attempt = async f => { try { await f(); return false; } catch { return true; } };
      const fetchBlocked = await attempt(() => fetch(endpoint));
      const wsBlocked = await new Promise(resolve => {
        try { const socket = new WebSocket(endpoint.replace('http:', 'ws:')); socket.onerror = () => resolve(true); socket.onopen = () => { socket.close(); resolve(false); }; }
        catch { resolve(true); }
      });
      const xhrBlocked = await new Promise(resolve => {
        const xhr = new XMLHttpRequest(); xhr.open('GET', endpoint); xhr.onerror = () => resolve(true); xhr.onload = () => resolve(false); xhr.send();
      });
      const sseBlocked = await new Promise(resolve => { const source = new EventSource(endpoint); source.onerror = () => { source.close(); resolve(true); }; source.onopen = () => { source.close(); resolve(false); }; });
      const imageBlocked = await new Promise(resolve => { const img = new Image(); img.onload = () => resolve(false); img.onerror = () => resolve(true); img.src = endpoint + '/image.png'; });
      const fontBlocked = await attempt(() => new FontFace('remote', 'url(' + endpoint + '/font.ttf)').load());
      const workerBlocked = await new Promise(resolve => { try { const w = new Worker('assets/local.js'); w.onerror = e => { e.preventDefault(); w.terminate(); resolve(true); }; w.onmessage = () => resolve(false); } catch { resolve(true); } });
      const dataBlocked = await new Promise(resolve => { const img = new Image(); img.onload = () => resolve(false); img.onerror = () => resolve(true); img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'; });
      const popupBlocked = window.open(endpoint) === null;
      const beaconViolations = [];
      const observe = event => { beaconViolations.push(event.effectiveDirective); };
      document.addEventListener('securitypolicyviolation', observe);
      // sendBeacon reports queue acceptance, not delivery. Verify CSP rejection.
      navigator.sendBeacon(endpoint + '/beacon', 'private');
      await new Promise(resolve => setTimeout(resolve, 50));
      document.removeEventListener('securitypolicyviolation', observe);
      const beaconBlocked = beaconViolations.includes('connect-src');
      const notificationDenied = await Notification.requestPermission() === 'denied';
      const mediaDenied = await attempt(() => navigator.mediaDevices.getUserMedia({audio:true}));
      const link = document.createElement('link'); link.rel = 'preconnect'; link.href = endpoint; document.head.append(link);
      const dns = document.createElement('link'); dns.rel = 'dns-prefetch'; dns.href = 'https://example.invalid'; document.head.append(dns);
      const form = document.createElement('form'); form.action = endpoint; form.method = 'POST'; document.body.append(form); form.submit();
      const download = document.createElement('a'); download.href = 'assets/site.css'; download.download = 'should-not-download.css'; document.body.append(download); download.click();
      const external = document.createElement('a'); external.href = 'hae-test-external:must-not-open'; document.body.append(external); external.click();
      return {fetchBlocked, wsBlocked, xhrBlocked, sseBlocked, imageBlocked, fontBlocked, workerBlocked,
        dataBlocked, popupBlocked, beaconBlocked, notificationDenied, mediaDenied};
    })()`, true);
    assert.deepEqual(attacks, Object.fromEntries(Object.keys(attacks).map((key) => [key, true])));
    await delay(200);
    assert.equal(interactive.contents.getURL(), interactive.url);
    assert.equal(connections, 0, 'No loopback TCP connection, including resource hints');
    assert.ok(interactive.diagnostics().some(({ target }) => target === endpoint));
    let downloadPrevented = false;
    interactive.session.once('will-download', (event) => { downloadPrevented = event.defaultPrevented; });
    const downloadEvent = once(interactive.session, 'will-download');
    interactive.contents.downloadURL(resourceURL(interactive.identity.sessionId, 'assets/site.css'));
    await downloadEvent;
    assert.equal(downloadPrevented, true);
    const fileInputCancelled = await interactive.contents.executeJavaScript(`new Promise(resolve => {
      const input = document.querySelector('#file-input');
      input.addEventListener('cancel', () => resolve(input.files.length === 0), {once:true});
      input.click();
    })`, true);
    assert.equal(fileInputCancelled, true);
    pass('S-03/S-04: actual fetch/XHR/WebSocket/EventSource, images/fonts, worker/data, permissions, popup, form, download, external scheme and resource hints denied; loopback server saw zero connections');

    const frames = await interactive.contents.executeJavaScript(`(() => {
      const a = document.createElement('iframe'); document.body.append(a);
      const first = [typeof a.contentWindow.RTCPeerConnection, typeof a.contentWindow.require];
      const host = document.createElement('div'); host.innerHTML = '<iframe></iframe>'; document.body.append(host);
      const second = typeof host.firstChild.contentWindow.RTCPeerConnection;
      const result = {first, second, redefine: false};
      try { Object.defineProperty(window, 'RTCPeerConnection', {value: function(){}}); result.redefine = true; } catch {}
      a.remove(); host.remove(); return result;
    })()`);
    assert.deepEqual(frames, { first: ['undefined', 'undefined'], second: 'undefined', redefine: false });
    pass('S-03/S-04: WebRTC/WebTransport/file-picker globals unavailable; immediate about:blank child realms cannot recover a socket constructor');

    // A deliberately stronger, TEST-ONLY bridge probes the production authority guard.
    const probeSession = session.fromPartition(`hae-security-probe-${Date.now()}`, { cache: false });
    const probe = new BrowserWindow({ show: false, webPreferences: { ...securePreferences,
      session: probeSession, nodeIntegrationInSubFrames: true,
      preload: resolve(outputRoot, 'security/preload/index.cjs') } });
    const probeURL = 'data:text/html,<iframe srcdoc="child"></iframe>';
    await probe.loadURL(probeURL);
    const seen: boolean[] = [];
    let live = true;
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      seen.push(acceptsPreviewReady({ contents: probe.webContents, session: probeSession, url: probeURL,
        identity: interactive.identity, isActive: () => live }, event, payload));
    };
    ipcMain.on(PREVIEW_READY_CHANNEL, listener);
    const ack = interactive.acknowledgement;
    await probe.webContents.executeJavaScript(`securityProbe.send(${JSON.stringify(PREVIEW_READY_CHANNEL)}, ${JSON.stringify(ack)})`);
    await probe.webContents.executeJavaScript(`securityProbe.send(${JSON.stringify(PREVIEW_READY_CHANNEL)}, ${JSON.stringify({ ...ack, path: '../private', offset: 0, nodeId: 'forged' })})`);
    await probe.webContents.executeJavaScript(`securityProbe.send(${JSON.stringify(PREVIEW_READY_CHANNEL)}, ${JSON.stringify({ ...ack, generation: 0 })})`);
    live = false;
    await probe.webContents.executeJavaScript(`securityProbe.send(${JSON.stringify(PREVIEW_READY_CHANNEL)}, ${JSON.stringify(ack)})`);
    assert.equal(await probe.webContents.executeJavaScript("securityProbe.invoke('hae:save', {path:'../private',offset:0}).then(() => false, () => true)"), true);
    await delay(50);
    live = true;
    const childFrame = probe.webContents.mainFrame.frames[0];
    assert.ok(childFrame, 'test-only hostile child frame exists');
    await childFrame.executeJavaScript(`securityProbe.send(${JSON.stringify(PREVIEW_READY_CHANNEL)}, ${JSON.stringify(ack)})`);
    assert.equal(await childFrame.executeJavaScript("securityProbe.invoke('hae:save', {}).then(() => false, () => true)"), true);
    await delay(50);
    assert.deepEqual(seen, [true, false, false, false, false]);
    ipcMain.removeListener(PREVIEW_READY_CHANNEL, listener);
    probe.destroy();
    pass('S-02: real IPC rejects forged write fields, stale generation, revoked authority and child-frame acknowledgement; main/child save handler does not exist');

    const csp = await previews.open(join(project, 'restrictive.html'), 'interactive');
    assert.equal(await csp.contents.executeJavaScript('typeof originalCspBypassed'), 'undefined');
    assert.equal(await csp.contents.executeJavaScript('getComputedStyle(document.body).color'), 'rgb(0, 0, 0)');
    assert.equal(hash(csp.sourceBytes()), before['restrictive.html']);
    await assert.rejects(previews.open(join(project, 'missing.html')));
    assert.equal(previews.current, csp);
    assert.equal(csp.isActive(), true);
    pass('original meta CSP stays byte-identical and still blocks local script/style; failed next open preserves current preview');

    const racing = new PreviewController(outputRoot);
    const raced = await Promise.allSettled([racing.open(entry), racing.open(entry, 'interactive')]);
    assert.equal(raced[0]!.status, 'rejected');
    assert.equal(raced[1]!.status, 'fulfilled');
    assert.equal(racing.current?.identity.mode, 'interactive');
    const winner = racing.current!;
    await racing.close();
    assert.equal(winner.isActive(), false);
    assert.equal(winner.contents.isDestroyed(), true);
    const cancelling = new PreviewController(outputRoot);
    const cancelled = assert.rejects(cancelling.open(entry));
    await cancelling.close();
    await cancelled;
    assert.equal(cancelling.current, undefined);
    pass('rapid open and close invalidate pending generations; no stale view replaces the latest successful preview');

    await capture(csp, 'security-preview.png');
    const destroyed = once(csp.contents, 'destroyed');
    csp.contents.debugger.detach();
    await destroyed;
    assert.equal(csp.isActive(), false);
    await blocked(csp, csp.url);
    await previews.close();
    assert.deepEqual(await hashes(project), before);
    assert.equal(connections, 0);
    pass('guard detachment fails closed; all fixture bytes and private sentinels unchanged; preview/session cleanup complete');
    window.destroy();
    server.close();
    const report = { status: 'passed', scope: 'HAE-002 local project preview security',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
      worktreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
      platform: process.platform, os: `${type()} ${release()}`, arch: arch(),
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      fixtures: before, passed, networkConnections: connections,
      pending: ['Windows 10 and macOS', 'native chooser/manual platform acceptance', 'product UI/IME', 'source mapping/patch/save/recovery'] };
    await writeFile(join(results, 'security.json'), `${JSON.stringify(report, null, 2)}\n`);
    app.exit(0);
  } catch (error) {
    console.error('FAIL: preview security', error);
    await writeFile(join(results, 'security.json'), `${JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)}\n`);
    app.exit(1);
  }
}
void run().catch(async (error) => {
  console.error(error);
  await writeFile(join(results, 'security.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }));
  app.exit(1);
});
