import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, ipcMain } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import type { ProjectPreview } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import type { PreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { parseSource } from '../../src/main/parser/parse-source.ts';
import { MAPPING_EVENT, MAPPING_CHECK_RESULT } from '../../src/contracts/mapping.ts';
import type { MappingSelection } from '../../src/contracts/mapping.ts';
import { mappingCases } from '../fixtures/mapping/cases.ts';
import { captureReady } from '../helpers/capture.ts';

registerSchemes();
app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'mapping-profile'));
const passed: string[] = [];
const fixtureHashes: Record<string, string> = {};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function pass(message: string): void { passed.push(message); console.log(`PASS: ${message}`); }
const previews = new PreviewController(outputRoot);
let currentMapping: PreviewMapping | undefined;
let window: BaseWindow;

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(15); }
}
async function mount(preview: ProjectPreview): Promise<void> {
  window.contentView.addChildView(preview.view);
  preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
  window.showInactive();
  await delay(60);
}
async function point(preview: ProjectPreview, index = 0): Promise<{ x: number; y: number }> {
  return preview.contents.executeJavaScript(`(() => {
    const p = document.querySelectorAll('p')[${index}];
    p.scrollIntoView({block:'nearest'});
    const r = document.createRange(); r.setStart(p.firstChild,0); r.setEnd(p.firstChild,1);
    const b = r.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};
  })()`);
}
async function click(preview: ProjectPreview, mapping: PreviewMapping, index = 0): Promise<MappingSelection> {
  const before = mapping.selection;
  const position = await point(preview, index);
  preview.contents.focus();
  preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
  preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
  await until(() => mapping.selection !== null && mapping.selection !== before, 'trusted selection');
  return mapping.selection!;
}

async function run(): Promise<void> {
  await mkdir(results, { recursive: true });
  await app.whenReady();
  const project = await mkdtemp(join(results, 'mapping-case-'));
  const listenersBefore = [ipcMain.listenerCount(MAPPING_EVENT), ipcMain.listenerCount(MAPPING_CHECK_RESULT)];
  window = new BaseWindow({ show: false, width: 960, height: 640 });
  const open = async (id: string, html: string): Promise<{ preview: ProjectPreview; mapping: PreviewMapping }> => {
    currentMapping?.close();
    const entry = join(project, `${id}.html`);
    await writeFile(entry, html);
    fixtureHashes[`${id}.html`] = hash(Buffer.from(html));
    const preview = await previews.open(entry);
    await mount(preview);
    const mapping = await createPreviewMapping(outputRoot, preview);
    currentMapping = mapping;
    return { preview, mapping };
  };
  try {
    const counts: Record<string, number> = { repeated: 11, nested: 8, entities: 2, noscript: 1,
      contexts: 1, foster: 0, adoption: 0, 'parse-error': 0, 'no-doctype': 1, 'pre-leading-newline': 1 };
    for (const fixture of mappingCases) {
      const { preview, mapping } = await open(fixture.id, fixture.html);
      assert.equal(mapping.status, 'ready', `${fixture.id}: ${mapping.reason}`);
      assert.equal(mapping.source.nodes.filter((node) => node.editable).length, counts[fixture.id], fixture.id);
      assert.equal(hash(mapping.source.bytes), fixtureHashes[`${fixture.id}.html`]);
      if (fixture.id === 'repeated') {
        const ids = new Set<string>();
        for (let i = 0; i < 10; i++) {
          const selection = await click(preview, mapping, i);
          assert.ok(await mapping.validateSelection(selection));
          ids.add(selection.nodeId);
          const node = mapping.source.nodes.find((item) => item.nodeId === selection.nodeId)!;
          assert.equal(node.decodedText, '相同文字 & 😀');
          const prefix = Buffer.from(mapping.source.bytes.slice(0, node.startByte)).toString();
          assert.ok(prefix.endsWith(`data-order="${i}">`));
        }
        assert.equal(ids.size, 10);
        await writeFile(join(results, 'mapping-repeated.png'), await captureReady(preview.contents));
        const old = mapping.selection!;
        const next = await click(preview, mapping, 0);
        assert.equal(await mapping.validateSelection(old), false);
        assert.ok(await mapping.validateSelection(next));
        assert.equal(await mapping.validateSelection({ ...next, identity: { ...next.identity,
          preview: { ...next.identity.preview, generation: next.identity.preview.generation + 1 } } }), false);
        const event = { sender: preview.contents, senderFrame: preview.contents.mainFrame };
        const payload = { kind: 'selection', identity: mapping.identity, revision: next.revision + 1, nodeId: next.nodeId };
        for (const [sender, message] of [
          [event, { ...payload, offset: 1 }], [event, { ...payload, path: 'x.html' }],
          [event, { ...payload, nodeId: 'n999999' }], [event, { ...payload, revision: 1 }],
          [event, { ...payload, identity: { ...mapping.identity, documentId: randomUUID() } }],
          [{ ...event, senderFrame: { url: preview.url } }, payload],
          [{ ...event, sender: {} }, payload],
        ]) ipcMain.emit(MAPPING_EVENT, sender, message);
        assert.equal(mapping.selection, next);
        await preview.contents.executeJavaScript(`document.querySelector('p').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:15,clientY:20}))`);
        assert.equal(mapping.selection, next);
        assert.deepEqual(await preview.contents.executeJavaScript('[typeof require,typeof process,typeof ipcRenderer,typeof haeMapping]'), Array(4).fill('undefined'));
        pass('T-03/S-02: ten trusted native clicks locate ten exact ranges; synthetic events, forged fields/ids/frames and stale revisions rejected');
      }
    }
    pass('T-04/T-05/T-06/T-08: ten parse5/Chromium trees agree, including nested/adjacent text, implicit tbody, noscript, BOM, Unicode, entities, mixed endings and read-only repairs/contexts');

    for (const mutation of [
      { id: 'same-value', code: 't.data=t.data' },
      { id: 'clone', code: 't.replaceWith(t.cloneNode(true))' },
      { id: 'detach-return', code: 'const p=t.parentNode;t.remove();p.append(t)' },
      { id: 'change-restore', code: 'const value=t.data;t.data="changed";t.data=value' },
      { id: 'split-normalize', code: 'const p=t.parentNode;t.splitText(1);p.normalize()' },
      { id: 'attribute', code: 't.parentNode.setAttribute("data-state","changed")' },
      { id: 'comment', code: 'document.body.append(document.createComment("change"))' },
      { id: 'template', code: 'document.querySelector("template").content.firstChild.firstChild.data="changed"' },
    ]) {
      const { preview, mapping } = await open(mutation.id, '<!doctype html><p>原文😀</p><template><b>模板</b></template>');
      assert.equal(mapping.status, 'ready');
      const selected = await click(preview, mapping);
      await preview.contents.executeJavaScript(`(() => { const t=document.querySelector('p').firstChild;${mutation.code}; })()`);
      assert.equal(await mapping.validateSelection(selected), false, mutation.id);
      await until(() => mapping.status === 'invalidated', mutation.id);
      assert.equal(mapping.reason, 'DOM_MUTATED');
      assert.equal(mapping.selection, null);
    }
    pass('T-13: same-value assignment, clone, detach/return, change/restore, split/normalize, attributes, comments and template mutation invalidate object identities and selections');

    const earlyEntry = join(project, 'early.html');
    await writeFile(earlyEntry, '<!doctype html><p>原文</p>');
    fixtureHashes['early.html'] = hash(await readFile(earlyEntry));
    currentMapping?.close();
    const early = await previews.open(earlyEntry);
    await early.contents.executeJavaScript('document.querySelector("p").firstChild.data="原文"');
    currentMapping = await createPreviewMapping(outputRoot, early);
    assert.equal(currentMapping.status, 'invalidated');
    assert.equal(currentMapping.reason, 'DOM_MUTATED');
    pass('mutation between DOMContentLoaded and binding is rejected, including unchanged text');

    for (const mode of ['open', 'closed']) {
      const { mapping } = await open(`shadow-${mode}`, `<!doctype html><p>普通正文</p><div><template shadowrootmode="${mode}"><span>影子文字</span></template></div>`);
      assert.equal(mapping.status, 'invalidated');
      assert.ok(['TREE_MISMATCH', 'UNSUPPORTED_DOM'].includes(mapping.reason!));
    }
    pass('declarative open and closed Shadow DOM are rejected instead of guessed');

    const generated = await open('css-generated', '<!doctype html><style>p.generated::before{content:"CSS_ONLY";display:inline-block;width:180px}</style><p class="generated">源码文字</p><p>普通文字</p>');
    assert.equal(generated.mapping.status, 'ready');
    const selected = await click(generated.preview, generated.mapping, 1);
    assert.ok(await generated.mapping.validateSelection(selected));
    const coordinate = await generated.preview.contents.executeJavaScript('(() => {const r=document.querySelector("p").getBoundingClientRect();return {x:Math.round(r.x+5),y:Math.round(r.y+r.height/2)}})()');
    generated.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...coordinate });
    generated.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...coordinate });
    await until(() => generated.mapping.selection === null, 'generated text is unselectable');
    const sourcePoint = await point(generated.preview, 0);
    generated.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...sourcePoint });
    generated.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...sourcePoint });
    await delay(50);
    assert.equal(generated.mapping.selection, null);
    pass('CSS-generated text and source Text under its pseudo-bearing ancestor are conservatively unselectable');

    const crossing = await open('crossing-text', '<!doctype html><p>第一处</p><p>第二处</p>');
    const single = await click(crossing.preview, crossing.mapping);
    await crossing.preview.contents.executeJavaScript(`(() => { const p=document.querySelectorAll('p');
      document.getSelection().setBaseAndExtent(p[0].firstChild,0,p[1].firstChild,2); })()`);
    assert.equal(await crossing.mapping.validateSelection(single), false);
    await until(() => crossing.mapping.selection === null, 'cross-Text selection');
    pass('a browser selection spanning different Text objects clears the single-node selection');

    const previous = await open('old-generation', '<!doctype html><p>同一原文</p>');
    const oldSelection = await click(previous.preview, previous.mapping);
    const replacement = await open('new-generation', '<!doctype html><p>同一原文</p>');
    assert.equal(previous.mapping.status, 'closed');
    assert.equal(await replacement.mapping.validateSelection(oldSelection), false);
    assert.ok(previous.preview.contents.isDestroyed());
    currentMapping?.close();
    const interactive = await previews.open(join(project, 'contexts.html'), 'interactive');
    await assert.rejects(createPreviewMapping(outputRoot, interactive), /INTERACTIVE_PREVIEW_READ_ONLY/);
    assert.equal(await interactive.contents.executeJavaScript('window.ran'), true);
    pass('T-08/T-13: same text in a new generation rejects old selection; interactive scripts run only in an unmapped read-only view');

    const identity = { projectId: randomUUID(), documentId: randomUUID(), generation: 1 };
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(parseSource(outputRoot, new Uint8Array(), identity, cancelled.signal), /SOURCE_PARSE_CANCELLED/);
    const busy = new AbortController();
    const task = parseSource(outputRoot, Buffer.from('<!doctype html>' + '<p>文字</p>'.repeat(30_000)), identity, busy.signal);
    busy.abort();
    await assert.rejects(task, /SOURCE_PARSE_CANCELLED/);
    await assert.rejects(parseSource(outputRoot, new Uint8Array([0xff]), identity), /UNSUPPORTED_ENCODING/);
    await assert.rejects(parseSource(outputRoot, Buffer.from('<!doctype html>' + '<div>'.repeat(300)), identity), /SOURCE_TREE_LIMIT/);
    const large = await parseSource(outputRoot, Buffer.from('<!doctype html>' + '<p>文字😀</p>\n'.repeat(10_000)), identity);
    assert.equal(large.nodes.filter((node) => node.decodedText === '文字😀').length, 10_000);
    const largeHash = hash(large.bytes);
    large.bytes.fill(0);
    assert.equal(hash(large.bytes), largeHash);
    const faultRoot = await mkdtemp(join(results, 'mapping-worker-fault-'));
    await mkdir(join(faultRoot, 'parser-worker'));
    await writeFile(join(faultRoot, 'parser-worker/index.cjs'), 'setInterval(() => {}, 1000);');
    const timeoutStarted = Date.now();
    await assert.rejects(parseSource(faultRoot, new Uint8Array(), identity), /SOURCE_PARSE_TIMEOUT/);
    assert.ok(Date.now() - timeoutStarted >= 4900);
    await writeFile(join(faultRoot, 'parser-worker/index.cjs'), 'throw new Error("synthetic worker failure");');
    await assert.rejects(parseSource(faultRoot, new Uint8Array(), identity), /SOURCE_PARSE_FAILED/);
    pass('S-10: real worker rejects invalid encoding/depth, cancels, terminates a hung worker, handles a crash, and indexes 10,000 immutable-source lines');

    const closingPreview = await previews.open(earlyEntry);
    const binding = createPreviewMapping(outputRoot, closingPreview);
    const rejectedBinding = assert.rejects(binding, /SOURCE_PARSE_CANCELLED|MAPPING_CLOSED/);
    await closingPreview.close();
    await rejectedBinding;

    await previews.close();
    assert.deepEqual([ipcMain.listenerCount(MAPPING_EVENT), ipcMain.listenerCount(MAPPING_CHECK_RESULT)], listenersBefore);
    for (const [name, expected] of Object.entries(fixtureHashes)) assert.equal(hash(await readFile(join(project, name))), expected, name);
    pass('all source fixtures retain original byte hashes; mapping IPC listeners are released on close');
  } finally {
    currentMapping?.close();
    await previews.close();
    window.destroy();
  }
}

const started = Date.now();
void run().then(async () => {
  await writeFile(join(results, 'mapping.json'), JSON.stringify({ status: 'passed', os: `${type()} ${release()} ${arch()}`,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    versions: process.versions, passed, fixtureHashes, durationMs: Date.now() - started }, null, 2));
  app.exit(0);
}).catch(async (error: unknown) => {
  console.error(error);
  await mkdir(results, { recursive: true });
  await writeFile(join(results, 'mapping.json'), JSON.stringify({ status: 'failed', passed, fixtureHashes, error: String(error) }, null, 2));
  app.exit(1);
});
