import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import type { ProjectPreview } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import type { PreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { createDraftSession } from '../../src/main/draft/session.ts';
import type { DraftSession } from '../../src/main/draft/session.ts';
import { prepareDraft } from '../../src/main/draft/prepare.ts';
import { MAPPING_APPLY, MAPPING_APPLY_RESULT, MAPPING_EVENT, MAPPING_CHECK_RESULT } from '../../src/contracts/mapping.ts';
import type { MappingApply, MappingSelection } from '../../src/contracts/mapping.ts';
import { captureReady } from '../helpers/capture.ts';
import { createNewFileWriter } from '../../src/platform/new-file.ts';

registerSchemes(); app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'draft-profile'));
const passed: string[] = [];
const fileHashes: Record<string, string> = {};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const previews = new PreviewController(outputRoot);
let mapping: PreviewMapping | undefined;
let draft: DraftSession | undefined;
let window: BaseWindow;
const baseline = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制报告</title><link rel="stylesheet" href="keep.css"></head><body>\n<h1>A &amp; 😀</h1>\r\n<table><tr><td>相同文字</td><td>相同文字</td></tr></table>\n<pre>\n\n首行</pre><!-- preserve -->\r\n<script src="keep.js"></script></body></html>');
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
async function click(preview: ProjectPreview, current: PreviewMapping, selector: string): Promise<MappingSelection> {
  const before = current.selection;
  // Test-only DOM queries find a click point. Production authority still comes
  // from native input, the isolated Text registry and Main's original source.
  const position = await preview.contents.executeJavaScript(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});
    const r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);
    const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};
  })()`);
  preview.contents.focus();
  preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
  preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
  await until(() => current.selection !== null && current.selection !== before, 'native selected Text');
  return current.selection!;
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const directory = await mkdtemp(join(results, 'draft-case-'));
  const entry = join(directory, 'original.html');
  await writeFile(entry, baseline);
  await writeFile(join(directory, 'keep.css'), 'body{font:22px sans-serif;padding:20px}td{padding:16px}h1{color:rgb(30,80,130)}');
  await writeFile(join(directory, 'keep.js'), 'window.originalScript=41');
  for (const name of ['original.html', 'keep.css', 'keep.js']) fileHashes[name] = hash(await readFile(join(directory, name)));
  const channels = [MAPPING_EVENT, MAPPING_CHECK_RESULT, MAPPING_APPLY_RESULT];
  const listeners = channels.map((channel) => ipcMain.listenerCount(channel));
  window = new BaseWindow({ show: false, width: 960, height: 640 });
  const open = async (prepare = prepareDraft) => {
    draft?.close(); mapping?.close();
    const preview = await previews.open(entry);
    window.contentView.addChildView(preview.view);
    preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    window.showInactive(); await delay(40);
    const mapped = await createPreviewMapping(outputRoot, preview);
    assert.equal(mapped.status, 'ready'); mapping = mapped;
    const session = createDraftSession(outputRoot, mapped, prepare); draft = session;
    const apply = (text: string) => session.apply({ selection: mapped.selection, draftRevision: session.revision, newText: text });
    return { preview, mapped, session, apply };
  };
  try {
    let f = await open();
    const first = await click(f.preview, f.mapped, 'h1');
    const title = '<script>新标题😀</script>&\n第二行';
    await f.apply(title);
    assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("h1").firstChild.data'), title);
    assert.equal(f.mapped.status, 'ready');
    assert.equal(await f.mapped.validateSelection(first), false);
    assert.ok(await f.mapped.validateSelection(f.mapped.selection!));
    assert.deepEqual(await f.preview.contents.executeJavaScript('[document.scripts.length,typeof originalScript,typeof ipcRenderer,typeof haeMapping,typeof require]'), [1, 'undefined', 'undefined', 'undefined', 'undefined']);
    pass('native title selection -> bounded worker candidate -> synchronous isolated Text mutation; pasted markup stays literal and old selection retires');

    await f.preview.contents.executeJavaScript('globalThis.originalTextObject=document.querySelector("h1").firstChild');
    await f.apply('');
    assert.deepEqual(await f.preview.contents.executeJavaScript('[document.querySelector("h1").childNodes.length,originalTextObject===document.querySelector("h1").firstChild,originalTextObject.data]'), [1, true, '']);
    await f.apply('再次输入😀');
    const stable = f.session.candidate;
    const revision = f.session.revision;
    await f.apply('再次输入😀');
    assert.equal(f.session.candidate, stable); assert.equal(f.session.revision, revision);
    await f.apply('A & 😀');
    assert.equal(f.session.candidate.patches.length, 0);
    assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
    pass('clearing retains the exact empty Text object; refill/no-op/return to baseline preserve identity and original entity bytes');

    await click(f.preview, f.mapped, 'td:nth-child(2)');
    await f.apply('第二个单元格，增长 & 😀');
    await click(f.preview, f.mapped, 'h1'); await f.apply('报告 2026');
    assert.deepEqual(await f.preview.contents.executeJavaScript('[...document.querySelectorAll("td")].map(e=>e.textContent)'), ['相同文字', '第二个单元格，增长 & 😀']);
    const expected = Buffer.from(baseline.toString().replace('A &amp; 😀', '报告 2026').replace('<td>相同文字</td></tr>', '<td>第二个单元格，增长 &amp; 😀</td></tr>'));
    assert.deepEqual(Buffer.from(f.session.candidate.bytes), expected);
    await writeFile(join(results, 'draft-applied.png'), await captureReady(f.preview.contents));
    pass('two independent, different-length drafts change only the chosen heading and repeated table cell; byte expectation is assembled independently');

    const writer = await createNewFileWriter(directory);
    const candidate = f.session.candidate;
    assert.equal(await f.session.saveCopy(async () => undefined, writer), null);
    assert.equal((await f.session.saveCopy(async () => entry, writer))!.code, 'NEW_FILE_EXISTS');
    const copy = join(directory, '另存报告.html');
    assert.equal((await f.session.saveCopy(async () => copy, writer))!.status, 'created');
    assert.equal(f.session.candidate, candidate);
    assert.deepEqual(await readFile(copy), expected);
    fileHashes['另存报告.html'] = hash(expected);
    const copies = new PreviewController(outputRoot);
    try {
      const reopened = await copies.open(copy);
      const reindexed = await createPreviewMapping(outputRoot, reopened);
      try {
        assert.equal(reindexed.status, 'ready');
        assert.deepEqual(await reopened.contents.executeJavaScript('[document.querySelector("h1").textContent,...[...document.querySelectorAll("td")].map(e=>e.textContent)]'),
          ['报告 2026', '相同文字', '第二个单元格，增长 & 😀']);
      } finally { reindexed.close(); }
    } finally { await copies.close(); }
    await writeFile(join(results, 'draft-copy-location.txt'), copy);
    pass('cancelled copy chooser writes nothing; existing original is refused; exclusive new sibling is byte-verified and reopened with exact text and a fresh mapping');

    const send = f.preview.contents.send.bind(f.preview.contents);
    f.preview.contents.send = (channel: string, ...args: unknown[]): void => {
      if (channel === MAPPING_APPLY) {
        const request = args[0] as MappingApply;
        const reply = { identity: request.identity, requestId: request.requestId, nodeId: request.nodeId,
          revision: request.revision, nextRevision: request.revision + 1, outcome: 'applied' };
        const before = f.mapped.selection;
        ipcMain.emit(MAPPING_APPLY_RESULT, { sender: f.preview.contents, senderFrame: { url: f.preview.url } }, reply);
        ipcMain.emit(MAPPING_APPLY_RESULT, { sender: {}, senderFrame: f.preview.contents.mainFrame }, reply);
        ipcMain.emit(MAPPING_APPLY_RESULT, { sender: f.preview.contents, senderFrame: f.preview.contents.mainFrame }, { ...reply, offset: 0 });
        assert.equal(f.mapped.selection, before);
      }
      send(channel, ...args);
    };
    try { await f.apply('仍由真实确认应用'); } finally { f.preview.contents.send = send; }
    assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '仍由真实确认应用');
    pass('forged mutation acknowledgements from another sender/frame or with offset fields cannot commit a draft');

    const own = f.session.candidate;
    await f.preview.contents.executeJavaScript('document.querySelector("h1").firstChild.data=document.querySelector("h1").firstChild.data');
    await until(() => f.mapped.status === 'invalidated', 'post-editor external mutation');
    await assert.rejects(f.apply('must not apply'), /DRAFT_UNAVAILABLE/);
    assert.equal(f.session.candidate, own);
    pass('same-value page mutation after a valid editor change still invalidates mapping; own-record handling leaves no observation gap');

    f = await open(async (...args) => {
      const candidate = await prepareDraft(...args);
      await f.preview.contents.executeJavaScript('document.querySelector("h1").firstChild.data="external"');
      return candidate;
    });
    await click(f.preview, f.mapped, 'h1');
    await assert.rejects(f.apply('stale candidate'), /STALE_SELECTION|DRAFT_OUTCOME_UNKNOWN/);
    assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
    assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'external');
    pass('DOM changes during worker preparation reject the stale candidate without overwriting the changed Text or prior draft');

    f = await open(); await click(f.preview, f.mapped, 'h1');
    const handlers = ipcMain.listeners(MAPPING_APPLY_RESULT) as ((event: IpcMainEvent, payload: unknown) => void)[];
    ipcMain.removeAllListeners(MAPPING_APPLY_RESULT); // Test-only lost-ack fault after actual renderer mutation.
    try { await assert.rejects(f.apply('applied but acknowledgement lost'), /DRAFT_OUTCOME_UNKNOWN/); }
    finally { for (const handler of handlers) ipcMain.on(MAPPING_APPLY_RESULT, handler); }
    assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'applied but acknowledgement lost');
    assert.equal(f.session.phase, 'uncertain');
    assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
    assert.equal(f.session.uncertainCandidate!.patches[0]!.newText, 'applied but acknowledgement lost');
    await assert.rejects(f.apply('blind retry'), /DRAFT_UNAVAILABLE/);
    pass('lost acknowledgement after real mutation preserves old and prepared candidates, marks unknown and rejects retry');

    f = await open(); await click(f.preview, f.mapped, 'h1');
    const aborted = new AbortController(); aborted.abort();
    const change = { identity: f.mapped.source.identity, baseHash: f.mapped.source.baseHash,
      nodeId: f.mapped.selection!.nodeId, expectedText: 'A & 😀', newText: 'cancelled' };
    await assert.rejects(prepareDraft(outputRoot, f.mapped.source, f.session.candidate, change, aborted.signal), /DRAFT_PREPARE_CANCELLED/);
    const cancelling = new AbortController();
    const pending = prepareDraft(outputRoot, f.mapped.source, f.session.candidate, change, cancelling.signal);
    cancelling.abort(); await assert.rejects(pending, /DRAFT_PREPARE_CANCELLED/);
    for (const [name, before] of Object.entries(fileHashes)) assert.equal(hash(await readFile(join(directory, name))), before, name);
    pass('pre-start and running worker cancellation settle only after termination; original HTML/CSS/JS are byte-identical across all draft operations');
  } finally {
    draft?.close(); mapping?.close(); await previews.close(); window.close();
  }
  assert.deepEqual(channels.map((channel) => ipcMain.listenerCount(channel)), listeners);
  await writeFile(join(results, 'draft.json'), JSON.stringify({ status: 'passed',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions, passed, fileHashes }, null, 2));
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error);
  await mkdir(results, { recursive: true });
  await writeFile(join(results, 'draft.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  draft?.close(); mapping?.close(); await previews.close();
  if (window && !window.isDestroyed()) window.close(); app.exit(1);
});
