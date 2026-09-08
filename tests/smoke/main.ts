import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import { createApplication, registerSchemes } from '../../src/main/application.ts';

// A separate main entry, never imported or enabled by the application entry.
registerSchemes();
app.enableSandbox();
// Keep the harness alive after its last window closes so the report is flushed.
// Explicit app.exit below bypasses before-quit; the parent enforces a timeout.
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', resolve(results, 'profile'));
const passed: string[] = [];
async function runSmoke(): Promise<void> {
  await mkdir(results, { recursive: true });
  await app.whenReady();
  try {
    const runtime = await createApplication(outputRoot, false);
    const { window, preview, uiReady, previewReady } = runtime;
    assert.equal(uiReady.surface, 'ui');
    assert.equal(previewReady.surface, 'preview');
    passed.push('both independent preloads ran with sandbox and context isolation');

    for (const contents of [window.webContents, preview.webContents]) {
      const globals = await contents.executeJavaScript(`({
        require: typeof require, process: typeof process, Buffer: typeof Buffer,
        ipcRenderer: typeof ipcRenderer
      })`);
      assert.deepEqual(globals, { require: 'undefined', process: 'undefined', Buffer: 'undefined', ipcRenderer: 'undefined' });
    }
    assert.notEqual(window.webContents.session, preview.webContents.session);
    assert.notEqual(await window.webContents.executeJavaScript('location.origin'),
      await preview.webContents.executeJavaScript('location.origin'));
    passed.push('separate sessions and origins; Node globals absent in both page worlds');

    let uiLoaded = false;
    for (let attempt = 0; attempt < 50 && !uiLoaded; attempt++) {
      uiLoaded = await window.webContents.executeJavaScript("document.querySelector('[data-bootstrap=ready]') !== null");
      if (!uiLoaded) await delay(50);
    }
    assert.equal(uiLoaded, true, 'React should render the bootstrap status');
    assert.equal(await preview.webContents.executeJavaScript('typeof window.haeBootstrap'), 'undefined');
    assert.equal(await preview.webContents.executeJavaScript('document.querySelector("h1").textContent'), '内置静态样例');
    assert.match(await preview.webContents.executeJavaScript('document.body.textContent'), /Emoji 🧪 与实体 &/u);
    passed.push('React rendered and static Chinese/Emoji/entity fixture loaded; UI bridge absent in Preview');

    await preview.webContents.executeJavaScript(`(() => {
      const script = document.createElement('script');
      script.textContent = 'window.pageScriptExecuted = true';
      document.body.append(script);
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.pageHandlerExecuted = true');
      document.body.append(button);
      button.click();
      script.remove(); button.remove();
    })()`);
    assert.deepEqual(await preview.webContents.executeJavaScript(`({
      script: typeof window.pageScriptExecuted, handler: typeof window.pageHandlerExecuted
    })`), { script: 'undefined', handler: 'undefined' });
    passed.push('Preview CSP blocked injected page script and inline event handler');

    const blocked = await window.webContents.executeJavaScript(`(async () => {
      try { await fetch('https://example.invalid/'); return false; } catch { return true; }
    })()`);
    assert.equal(blocked, true);
    assert.equal(await window.webContents.executeJavaScript("window.open('https://example.invalid/') === null"), true);
    for (const url of ['https://example.invalid/', 'http://127.0.0.1:9/', 'file:///etc/passwd', runtime.uiURL]) {
      await assert.rejects(preview.webContents.session.fetch(url), /net::ERR_BLOCKED_BY_CLIENT/);
    }
    const response = await window.webContents.session.fetch(runtime.uiURL);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    passed.push('external requests, file scheme, cross-session UI access and popup rejected; CSP present');

    window.setContentSize(960, 640);
    await delay(100);
    const actualSize = window.getContentBounds();
    assert.deepEqual(preview.getBounds(), {
      x: 0, y: 210, width: actualSize.width, height: actualSize.height - 210,
    });
    window.showInactive();
    await delay(300);
    await writeFile(resolve(results, 'ui.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(resolve(results, 'preview.png'), (await preview.webContents.capturePage()).toPNG());
    const previewContents = preview.webContents;
    const previewDestroyed = once(previewContents, 'destroyed');
    window.destroy();
    await previewDestroyed;
    assert.equal(previewContents.isDestroyed(), true);
    passed.push('minimum-size resize and child WebContents cleanup');

    const packageJson = JSON.parse(await readFile(resolve(outputRoot, '../package.json'), 'utf8'));
    assert.equal(process.versions.electron, packageJson.devDependencies.electron);
    const report = {
      status: 'passed', scope: 'HAE-001 bundled scaffold only',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
      worktreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
      platform: process.platform, os: `${type()} ${release()}`, arch: arch(),
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      passed, pending: ['T-01 user files/dialog cancellation', 'product UI and IME', 'file patches/save/recovery', 'manual platform acceptance'],
    };
    await writeFile(resolve(results, 'smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    app.exit(0);
  } catch (error) {
    console.error('FAIL: Electron smoke', error);
    await writeFile(resolve(results, 'smoke.json'), `${JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)}\n`);
    app.exit(1);
  }
}
void runSmoke().catch((error) => { console.error(error); app.exit(1); });
