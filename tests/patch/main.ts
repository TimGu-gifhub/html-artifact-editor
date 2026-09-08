import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { captureReady } from '../helpers/capture.ts';

registerSchemes();
app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'patch-profile'));
const passed: string[] = [];
const evidence: Record<string, string> = {};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const previews = new PreviewController(outputRoot);
function pass(message: string): void { passed.push(message); console.log(`PASS: ${message}`); }

async function run(): Promise<void> {
  await mkdir(results, { recursive: true });
  await app.whenReady();
  const project = await mkdtemp(join(results, 'patch-case-'));
  const original = Buffer.from('\ufeff<!doctype html>\r\n<meta charset="utf-8"><link rel="stylesheet" href="keep.css"><script src="keep.js"></script>'
    + '<main><p id="target" data-original="&amp;">原文 😀 &#xA0;</p><p id="clear">清空目标</p>'
    + '<p id="last">最后一段</p><pre id="pre">原 pre</pre></main><!--注释原样-->', 'utf8');
  const css = 'body{font-family:sans-serif}p{color:rgb(12,34,56)}';
  const js = 'window.originalScriptRan=41;';
  const originals: Record<string, Uint8Array> = { 'original.html': original, 'keep.css': Buffer.from(css), 'keep.js': Buffer.from(js) };
  for (const [name, bytes] of Object.entries(originals)) {
    await writeFile(join(project, name), bytes); evidence[name] = hash(bytes);
  }
  const identity = { projectId: 'patch-project', documentId: 'patch-file', generation: 1 };
  const source = createSourceIndex(original, identity, hash);
  const engine = createPatchEngine(source, hash);
  const set = (old: string, text: string): void => {
    const node = source.nodes.find((item) => item.decodedText === old)!;
    engine.apply({ identity, baseHash: source.baseHash, nodeId: node.nodeId, expectedText: node.decodedText, newText: text });
  };
  const pasted = '<script>window.injected=true</script><img src=x onerror=boom()> & 中文 e\u0301 😀';
  set('原文 😀 \u00a0', pasted);
  set('清空目标', '');
  set('最后一段', '更长的最后一段 🧪');
  set('原 pre', '\n新增空行\n\n正文');
  const candidate = engine.candidate;
  const candidatePath = join(project, 'candidate.html');
  // Test-owned file creation is not the application's save transaction.
  await writeFile(candidatePath, candidate.bytes, { flag: 'wx' });
  assert.equal(hash(await readFile(candidatePath)), candidate.resultHash);
  evidence['candidate.html'] = candidate.resultHash;
  const window = new BaseWindow({ show: false, width: 960, height: 640 });
  try {
    const preview = await previews.open(candidatePath);
    window.contentView.addChildView(preview.view);
    preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    window.showInactive(); await delay(80);
    const mapping = await createPreviewMapping(outputRoot, preview);
    assert.equal(mapping.status, 'ready');
    assert.deepEqual(await preview.contents.executeJavaScript(`({
      target:document.querySelector('#target').textContent,
      clear:document.querySelector('#clear').textContent,
      clearNodes:document.querySelector('#clear').childNodes.length,
      last:document.querySelector('#last').textContent,pre:document.querySelector('#pre').textContent,
      attr:document.querySelector('#target').getAttribute('data-original'),
      scripts:document.scripts.length,images:document.images.length,
      color:getComputedStyle(document.querySelector('#target')).color,
      executed:typeof originalScriptRan,injected:typeof injected
    })`), { target: pasted, clear: '', clearNodes: 0, last: '更长的最后一段 🧪', pre: '\n新增空行\n\n正文',
      attr: '&', scripts: 1, images: 0, color: 'rgb(12, 34, 56)', executed: 'undefined', injected: 'undefined' });
    await writeFile(join(results, 'patch-candidate.png'), await captureReady(preview.contents));
    pass('T-07/T-11/T-20: Chromium reopens candidate bytes with exact pasted text, empty-node removal, multi-node growth and pre leading blank lines; attributes/CSS/script count intact');
    mapping.close();
    const interactive = await previews.open(candidatePath, 'interactive');
    assert.deepEqual(await interactive.contents.executeJavaScript('[originalScriptRan,typeof injected,document.images.length]'), [41, 'undefined', 0]);
    pass('pasted script/image tags stay text even when original local JavaScript is enabled in read-only interactive preview');

    const preCases = [
      '<pre>\n旧</pre>', '<pre>\n\n旧</pre>', '<pre>&#10;\n旧</pre>',
      '<pre>\r\n\r\n旧</pre>', '<pre><!--保留-->旧</pre>', '<listing>旧</listing>',
    ];
    for (const [index, body] of preCases.entries()) {
      const bytes = Buffer.from(`<!doctype html><meta charset="utf-8">${body}`);
      const base = createSourceIndex(bytes, identity, hash);
      const patcher = createPatchEngine(base, hash);
      const node = base.nodes.find((item) => item.decodedText.includes('旧'))!;
      const result = patcher.apply({ identity, baseHash: base.baseHash, nodeId: node.nodeId, expectedText: node.decodedText, newText: '\n\n新行😀' });
      const path = join(project, `pre-${index}.html`);
      await writeFile(path, result.bytes, { flag: 'wx' });
      evidence[`pre-${index}.html`] = result.resultHash;
      const next = await previews.open(path);
      const verified = await createPreviewMapping(outputRoot, next);
      assert.equal(verified.status, 'ready', body);
      assert.equal(await next.contents.executeJavaScript('document.querySelector("pre,listing").textContent'), '\n\n新行😀', body);
      verified.close();
    }
    pass('six real Chromium pre/listing cases preserve leading blank lines with literal/entity/mixed prefixes and comments');
    for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(project, name)), Buffer.from(bytes), name);
    pass('original HTML and CSS/JS resource byte hashes remain unchanged; only new test-owned candidate files were written');
  } finally { await previews.close(); window.destroy(); }
}

void run().then(async () => {
  await writeFile(join(results, 'patch.json'), JSON.stringify({ status: 'passed', scope: 'HAE-004 candidate bytes, not application Save',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    os: `${type()} ${release()} ${arch()}`, versions: process.versions, passed, evidence }, null, 2));
  app.exit(0);
}).catch(async (error: unknown) => {
  console.error(error);
  await mkdir(results, { recursive: true });
  await writeFile(join(results, 'patch.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  app.exit(1);
});
