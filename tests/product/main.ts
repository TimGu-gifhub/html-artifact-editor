import { proofreadSnapshot, proofreadDocument } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { captureReady } from '../helpers/capture.ts';

registerSchemes(); app.enableSandbox(); app.on('window-all-closed', () => {});
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, `product-profile-${randomUUID()}`));
const passed: string[] = []; const pass = (value: string) => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 12000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(`TIMEOUT: ${label}`); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, text?: string): Promise<void> {
  const locate = () => window.webContents.executeJavaScript(`(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = elements.find(value => value.getBoundingClientRect().width > 0 && !value.disabled
      && (${JSON.stringify(text ?? null)} === null || value.textContent.includes(${JSON.stringify(text ?? '')})));
    if (!el) return null; const box = el.getBoundingClientRect(); return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
  })()`);
  // Wait for React to publish the requested control, without repeating the
  // click or inferring readiness from an earlier Main snapshot.
  let point = await locate();
  await until(async () => { if (!point) point = await locate(); return !!point; }, `enabled control: ${selector} ${text ?? ''}`, 3000);
  assert.ok(point, `missing enabled control: ${selector} ${text ?? ''}`);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function select(contents: WebContents, selector: string): Promise<void> {
  const point = await contents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); const range = document.createRange();
    range.setStart(el.firstChild,0); range.setEnd(el.firstChild,1); const box = range.getBoundingClientRect();
    return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
  })()`);
  contents.focus(); contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function typeDraft(window: BrowserWindow, value: string): Promise<void> {
  await until(() => window.webContents.executeJavaScript('!!document.querySelector("textarea.draft-input")'), 'real draft textarea');
  window.focus(); window.webContents.focus();
  await window.webContents.executeJavaScript('document.querySelector("textarea.draft-input").focus(); document.querySelector("textarea.draft-input").select();');
  await window.webContents.insertText(value);
}
const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制产品验收</title><link rel="stylesheet" href="keep.css"></head><body>'
  + '<h1>2025 年度报告 &amp; 😀</h1><p id="date">2025-01-01</p><table><tbody><tr><td>一</td><td>二</td><td>三</td></tr></tbody></table>'
  + '<p id="extra">第六处普通正文</p><button>受限按钮</button><script>globalThis.pageRan=true</script><!-- 原样保留 --></body></html>\r\n');
const css = Buffer.from('body{font:20px sans-serif;padding:24px;color:#24344c}table{border-collapse:collapse}td{padding:12px;border:1px solid #aaa}');

async function run() {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const root = await mkdtemp(join(results, 'product-document-')); const entry = join(root, '报告.html');
  const destination = join(root, '打印预览.pdf');
  await writeFile(entry, original); await writeFile(join(root, 'keep.css'), css);
  let pdfChoice: string | undefined; let leaveDecision = 'cancel'; let backupReviews = 0;
  let releaseSave!: () => void; const saveGate = new Promise<void>(done => { releaseSave = done; }); let savePreparing = false;
  const product = await createProductApplication(outputRoot, { visible: false, bindQuit: false,
    onStorageStep: async (kind, step) => { if (kind === 'save' && step === 'prepared-synced' && !savePreparing) { savePreparing = true; await saveGate; } }, choices: {
    open: async () => entry, pdf: async () => pdfChoice, copy: async () => join(root, '草稿.html'),
    review: async value => ({ reviewId: value.reviewId, decision: leaveDecision }),
    backup: async value => { ++backupReviews; return { reviewId: value.reviewId, decision: 'cancel' }; },
  } });
  const { window, runtime, desktop } = product; const state = () => proofreadSnapshot(runtime.workspace.snapshot());
  const desk = () => desktop.extension(window.webContents).snapshot();
  const settled = (text: string) => { const input = state().current?.input; return input?.input?.appliedText === text && !input.hasUnappliedInput && input.phase === 'idle'; };
  const uiErrors: string[] = [];
  window.webContents.on('console-message', (_event, _level, message) => { if (message.includes('Uncaught')) uiErrors.push(message); });
  try {
    window.showInactive();
    await until(() => window.webContents.executeJavaScript('!!document.querySelector(".app")'), 'production React workbench');
    await click(window, '.toolbar button', '打开 HTML');
    await until(() => !!state().current && (runtime.host.current?.getBounds().width ?? 0) > 100, 'document and native Preview layout');
    const first = proofreadDocument(runtime.workspace.current!);
    assert.equal(first.mapping.status, 'ready');
    assert.deepEqual(await first.preview.contents.executeJavaScript('({require:typeof require,process:typeof process,workspace:typeof haeWorkspace,desktop:typeof haeDesktop,pageRan:typeof pageRan})'),
      { require: 'undefined', process: 'undefined', workspace: 'undefined', desktop: 'undefined', pageRan: 'undefined' });
    assert.notEqual(window.webContents.session, first.preview.session);
    pass('normal product assets open a real HTML through the production Workspace; isolated Preview has no privileged API or page scripts');

    const firstTitle = '2026 年度报告 <&> 🧪';
    await select(first.preview.contents, 'h1'); await typeDraft(window, firstTitle);
    await until(() => settled(firstTitle), 'live preview without Apply');
    assert.equal(await first.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), firstTitle);
    assert.deepEqual(await readFile(entry), original);
    const current = state().current!;
    const rejected = await window.webContents.executeJavaScript(`haeWorkspace.save(${JSON.stringify(current.id)},${state().stateRevision},${JSON.stringify({ draftRevision: current.input.draftRevision, candidateHash: current.input.candidateHash })})`);
    assert.equal(rejected.code, 'REVIEW_REQUIRED'); assert.deepEqual(await readFile(entry), original);
    pass('typing automatically updates the exact Text, leaves original bytes untouched, and Main rejects Save without current review');

    await click(window, '.toolbar button', 'PDF');
    await until(async () => await window.webContents.executeJavaScript('!!document.querySelector("[role=dialog]")') && runtime.host.current!.getBounds().width === 0, 'PDF dialog hides native Preview');
    await click(window, '[role=dialog] .dlg-actions button.primary');
    await until(() => !!desk().pdf && !desk().pdfBusy, 'PDF generated', 45000);
    const pdf = desk().pdf!;
    await until(() => desktop.ownedWindows().some(value => value.getTitle().includes('PDF')), 'native PDF viewer');
    const viewer = desktop.ownedWindows().find(value => value.getTitle().includes('PDF'))!;
    await until(async () => {
      const frame = viewer.webContents.mainFrame.framesInSubtree.find(value => value !== viewer.webContents.mainFrame
        && value.url === `hae-pdf://preview/${pdf.id}.pdf`);
      return !!frame && (await frame.executeJavaScript('!!document.querySelector("#sizer") && document.querySelector("#sizer").offsetHeight > 0').catch(() => false)) === true;
    }, 'built-in PDF engine rendered page dimensions');
    await delay(200);
    await writeFile(join(results, 'product-pdf-viewer.png'), await captureReady(viewer.webContents));
    const renderedPdf = new Uint8Array(await (await viewer.webContents.session.fetch(`hae-pdf://preview/${pdf.id}.pdf`)).arrayBuffer());
    assert.equal(Buffer.from(renderedPdf.subarray(0, 5)).toString(), '%PDF-'); assert.ok(pdf.dirty);
    for (const url of ['https://example.invalid/', 'file:///C:/Windows/win.ini', 'editor://app/index.html']) {
      await assert.rejects(viewer.webContents.session.fetch(url));
    }
    assert.equal(await viewer.webContents.executeJavaScript('typeof haeWorkspace'), 'undefined');
    viewer.close(); await until(() => viewer.isDestroyed(), 'PDF viewer closes independently');
    await click(window, '[role=dialog] button', '导出');
    await until(() => desk().pdfExport?.status === 'cancelled', 'PDF native chooser cancellation');
    pdfChoice = destination; await click(window, '[role=dialog] button', '导出');
    await until(() => desk().pdfExport?.status === 'created', 'PDF export');
    assert.deepEqual(await readFile(destination), Buffer.from(renderedPdf)); assert.deepEqual(await readFile(entry), original);
    await click(window, '[role=dialog] .dlg-actions button', '关闭');
    await until(() => runtime.host.current!.getBounds().width > 100, 'Preview restored after PDF dialog');
    pass('PDF preview contains the draft; cancelled export writes nothing, export reuses the exact preview bytes, and the PDF window cannot read editor/files/network');

    await click(window, '.check-all input'); await until(() => desk().reviewed.length === 1, 'select all review');
    const finalTitle = firstTitle + ' 已核对'; await typeDraft(window, finalTitle);
    await until(() => settled(finalTitle), 'later title update'); assert.equal(desk().reviewed.length, 0);
    await select(first.preview.contents, '#extra');
    await until(() => state().current?.input.input?.appliedText === '第六处普通正文', 'select sixth static field');
    await typeDraft(window, '普通正文也可编辑'); await until(() => settled('普通正文也可编辑'), 'sixth field update');
    assert.equal(state().current!.input.changes.length, 2);
    await click(window, '.check-all input'); await until(() => desk().reviewed.length === 2, 'complete review');
    await click(window, '.toolbar button', '复核并保存');
    await until(async () => await window.webContents.executeJavaScript('!!document.querySelector("[role=dialog] .diff-list .ci-diff")')
      && runtime.host.current!.getBounds().width === 0, 'actual source Diff and acknowledged native Preview layout');
    assert.equal(runtime.host.current!.getBounds().width, 0);
    await click(window, '[role=dialog] .dlg-actions button.primary');
    await until(() => savePreparing, 'accepted native Save held before replacement');
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role=dialog]');
      return !!dialog && [...dialog.querySelectorAll('button')].every(button => button.disabled)
        && document.querySelector('textarea.draft-input')?.disabled === true;
    })()`), true, 'Save locks dialog cancellation and underlying input');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await delay(30); assert.equal(await window.webContents.executeJavaScript('!!document.querySelector("[role=dialog] .diff-list")'), true);
    assert.deepEqual(await readFile(entry), original); releaseSave();
    await until(() => state().lastSave?.status === 'saved' && state().phase === 'idle', 'verified Windows Save', 30000);
    const expected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '2026 年度报告 &lt;&amp;&gt; 🧪 已核对').replace('第六处普通正文', '普通正文也可编辑'));
    assert.deepEqual(await readFile(entry), expected); assert.deepEqual(await readFile(join(root, 'keep.css')), css);
    assert.equal(state().current!.input.changes.length, 0); assert.notEqual(state().current!.id, first.id);
    pass('editing is not limited to five prototype nodes; changed items lose review, all-reviewed source Diff saves exact bytes with resources unchanged');

    await until(() => window.webContents.executeJavaScript('!document.querySelector("[role=dialog]")'), 'Save UI acknowledgement');
    await click(window, '.toolbar button[aria-label="更多操作"]');
    await click(window, '[role=menuitem]', '备份与恢复');
    await until(() => window.webContents.executeJavaScript('!!document.querySelector("[role=dialog] .record-item")'), 'real backup catalog');
    await click(window, '[role=dialog] .record-item button', '恢复此备份');
    await until(async () => backupReviews === 1 && state().phase === 'idle'
      && await window.webContents.executeJavaScript('document.querySelector("[role=dialog] .record-item button")?.disabled === false'), 'separate backup confirmation cancelled');
    await click(window, '[role=dialog] button[aria-label="关闭"]');
    assert.deepEqual(await readFile(entry), expected);
    pass('product backup list uses current metadata and cancelling the separate Main confirmation does not replace HTML');

    await click(window, '.toolbar button[aria-label^="撤销"]');
    await until(() => state().current!.input.changes.length === 1, 'product Undo after Save');
    assert.deepEqual(await readFile(entry), expected);
    await click(window, '.toolbar button[aria-label="在独立窗口中校稿"]');
    await until(() => desk().panel === 'floating', 'floating editor ownership');
    const floating = desktop.ownedWindows().find(value => !value.getTitle().includes('PDF'))!;
    await select(proofreadDocument(runtime.workspace.current!).preview.contents, 'h1');
    await typeDraft(floating, '浮窗中的中文 🧪'); await until(() => settled('浮窗中的中文 🧪'), 'floating input updates Main document');
    await until(() => floating.webContents.executeJavaScript('document.querySelector(".field-foot .badge-ok")?.textContent === "草稿已预览"'), 'floating UI acknowledgement');
    await delay(200); // Let Chromium composite the acknowledged React state.
    await writeFile(join(results, 'product-floating.png'), await captureReady(floating.webContents));
    floating.close(); await until(() => desk().panel === 'docked' && !floating.isVisible(), 'native floating close docks');
    await until(() => window.webContents.executeJavaScript('document.querySelector("textarea.draft-input")?.value === "浮窗中的中文 🧪"'), 'docked input preserved');
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea.draft-input'); input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    })()`);
    await until(() => state().current?.input.input?.composing === true, 'composition-start-only published through product UI');
    window.close(); assert.equal(await runtime.requestClose(), 'cancelled');
    assert.equal(window.isDestroyed(), false); assert.equal(state().current!.input.input!.composing, true);
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea.draft-input');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: input.value }));
    })()`);
    await until(() => state().current?.input.input?.composing === false, 'composition-end clears the actual Main flag');
    assert.equal(await desktop.flush('action'), true); assert.equal(desk().error, null);
    pass('synthetic composition start reaches Main before text changes; native close preserves composition and waits for an explicit end');
    const dockedWidth = runtime.host.current!.getBounds().width;
    await click(window, '.toolbar button[aria-label="隐藏校稿栏"]');
    await until(() => desk().panel === 'hidden' && runtime.host.current!.getBounds().width > dockedWidth, 'hidden editor expands Preview');
    await click(window, '.toolbar button', '恢复校稿栏');
    await until(() => desk().panel === 'docked', 'editor shown again');
    assert.deepEqual(await readFile(entry), expected);
    pass('Undo stays in drafts; a real floating editor shares one document, native close docks without losing text, and hide/show resizes Preview');

    await writeFile(join(results, 'product-ui.png'), await captureReady(window.webContents));
    await writeFile(join(results, 'product-preview.png'), await captureReady(proofreadDocument(runtime.workspace.current!).preview.contents));
    window.setContentSize(960, 640); await delay(200);
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    await click(window, '.toolbar button', '复核变更');
    await until(() => runtime.host.current!.getBounds().width === 0, 'narrow review drawer hides Preview');
    await click(window, '[role=dialog] button[aria-label="关闭"]');
    await until(() => runtime.host.current!.getBounds().width > 0, 'narrow drawer closes');
    window.close(); assert.equal(await runtime.requestClose(), 'cancelled'); assert.equal(window.isDestroyed(), false);
    assert.equal(state().current!.input.input!.appliedText, '浮窗中的中文 🧪');
    leaveDecision = 'discard'; assert.equal(await runtime.requestClose(), 'closed'); await runtime.dispose();
    assert.deepEqual(await readFile(entry), expected); assert.deepEqual(await readFile(join(root, 'keep.css')), css);
    assert.deepEqual(uiErrors, []);
    pass('960×640 product controls fit; review drawer hides native content; native close cancellation preserves input and explicit discard drains the runtime');
    const fault = await createProductApplication(outputRoot, { visible: false, bindQuit: false, choices: { open: async () => entry } });
    try {
      // The fault case is another real product window. A ready source mapping
      // alone does not mean its native view has received the React layout yet.
      fault.window.showInactive();
      await until(() => fault.window.webContents.executeJavaScript('[...document.querySelectorAll("button")].some(button => button.textContent.includes("打开 HTML"))'), 'second product UI ready');
      await click(fault.window, 'button', '打开 HTML');
      await until(() => proofreadSnapshot(fault.runtime.workspace.snapshot()).current?.input.mappingStatus === 'ready'
        && fault.runtime.workspace.snapshot().phase === 'idle'
        && (fault.runtime.host.current?.getBounds().width ?? 0) > 100, 'second product document and native layout ready');
      await select(proofreadDocument(fault.runtime.workspace.current!).preview.contents, 'h1');
      await until(() => fault.window.webContents.executeJavaScript('!!document.querySelector("textarea.draft-input")'), 'fault input ready');
      await fault.window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('textarea.draft-input'); input.focus();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      })()`);
      const retainedText = '映射失效时仍须保留的中文输入 🧪';
      await typeDraft(fault.window, retainedText);
      assert.notEqual(proofreadSnapshot(fault.runtime.workspace.snapshot()).current!.input.input!.appliedText, retainedText);
      await proofreadDocument(fault.runtime.workspace.current!).preview.contents.executeJavaScript("document.querySelector('h1').firstChild.data = 'TEST_FAULT_MUTATION'");
      await until(() => proofreadSnapshot(fault.runtime.workspace.snapshot()).current?.input.mappingStatus === 'invalidated', 'fault invalidates real mapping');
      await until(() => fault.window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('textarea[aria-label="保留的输入（可复制）"]');
        return input?.readOnly === true && input.disabled === false && input.value === ${JSON.stringify(retainedText)};
      })()`), 'lost mapping keeps an accessible copy of pending input');
      assert.deepEqual(await readFile(entry), expected);
      pass('real mapping loss during composing exposes preserved input as read-only copyable text without applying or writing HTML');
    } finally {
      await fault.runtime.dispose();
      if (!fault.window.isDestroyed()) fault.window.destroy();
    }
    await writeFile(join(results, 'product.json'), JSON.stringify({ status: 'passed', passed, platform: { os: type(), release: release(), arch: arch(), versions: process.versions },
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      evidence: { originalHash: hash(original), savedHash: hash(expected), cssHash: hash(css), pdfHash: hash(renderedPdf), pdf: destination },
      pending: ['real Windows IME and native choosers', 'Windows 10 / DPI / screen reader', 'maintainer document and product restart acceptance'] }, null, 2));
  } finally { releaseSave(); await runtime.dispose().catch(() => {}); if (!window.isDestroyed()) window.destroy(); }
}
void run().then(() => app.exit(0), async (error: unknown) => {
  console.error(error); await writeFile(join(results, 'product.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
