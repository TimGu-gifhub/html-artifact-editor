import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { app, BaseWindow } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import type { TextHistory, HistoryTransition } from '../../src/core/history/timeline.ts';
import { prepareDraft } from '../../src/main/draft/prepare.ts';
import { prepareSourceDiff } from '../../src/main/draft/source-diff.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createOriginalSaver } from '../../src/main/storage/original.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { runHistoryPreview } from './preview.ts';
import { runHistoryWorkspace } from './workspace.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', event => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'history-profile'));
const passed: string[] = []; const pending: string[] = []; const evidence: Record<string, string> = {};
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const identity = (generation: number) => ({ projectId: 'history-case', documentId: `generation-${generation}`, generation });
const original = Buffer.from('\ufeff<!doctype html>\r\n<meta charset="utf-8"><link rel="stylesheet" href="keep.css"><script>window.existing=41</script>'
  + '<h1>年度 &#65; 😀</h1><p id="first">重复</p><p id="target">重复</p><pre id="pre">原</pre><!-- 原样 -->');
const css = Buffer.from('body{font-family:sans-serif}p{color:rgb(12,34,56)}');

async function fixture(step?: (value: string) => Promise<void>) {
  const root = await mkdtemp(join(results, 'history-case-')); const project = join(root, 'project'); const privateRoot = join(root, 'private');
  await mkdir(project); await mkdir(privateRoot); const entry = join(project, 'report.html');
  await writeFile(entry, original); await writeFile(join(project, 'keep.css'), css);
  const history = createTextHistory(original, identity(1), hash);
  const stores = await createSavePreparationStore(privateRoot, step, process.platform === 'win32'
    ? await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')) : undefined);
  const save = createOriginalSaver(stores); const source = await openSaveSource(entry, original);
  return { entry, project, privateRoot, history, stores, save, source };
}
const find = (history: TextHistory, tag: string, last = false) => {
  const nodes = history.source.nodes.filter(node => node.parentTag === tag && node.editable);
  return history.logicalTarget(nodes[last ? nodes.length - 1 : 0]!.nodeId)!;
};
function apply(history: TextHistory, target: string, text: string): void {
  const nodeId = history.sourceTarget(target)!;
  history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
    nodeId, expectedText: history.textFor(nodeId)!, newText: text }));
}
async function workerPlan(history: TextHistory, plan: HistoryTransition) {
  assert.equal(plan.changes.length, 1); const change = plan.changes[0]!;
  const candidate = await prepareDraft(outputRoot, history.source, history.candidate,
    { identity: history.source.identity, baseHash: history.source.baseHash, ...change }, new AbortController().signal);
  assert.deepEqual(candidate.bytes, plan.candidate.bytes);
  const diff = await prepareSourceDiff(outputRoot, history.source, candidate, new AbortController().signal);
  const base = history.source.bytes; const parts: Uint8Array[] = []; let end = 0;
  for (const item of diff.changes) {
    assert.deepEqual(Buffer.from(item.before.text), Buffer.from(base.subarray(item.before.startByte, item.before.endByte)));
    parts.push(base.subarray(end, item.before.startByte), Buffer.from(item.after.text)); end = item.before.endByte;
  }
  parts.push(base.subarray(end)); assert.deepEqual(Buffer.concat(parts), Buffer.from(candidate.bytes)); return diff;
}
async function reopen(entry: string, expected: { title: string; target: string; pre: string; empty: boolean }) {
  const previews = new PreviewController(outputRoot); const window = new BaseWindow({ show: false, width: 960, height: 640 });
  try {
    const preview = await previews.open(entry); window.contentView.addChildView(preview.view);
    preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    const mapping = await createPreviewMapping(outputRoot, preview); assert.equal(mapping.status, 'ready');
    assert.deepEqual(await preview.contents.executeJavaScript(`({title:document.querySelector('h1').textContent,
      target:document.querySelector('#target').textContent,pre:document.querySelector('#pre').textContent,
      empty:document.querySelector('#target').childNodes.length===0,first:document.querySelector('#first').textContent,
      scripts:document.scripts.length,images:document.images.length,color:getComputedStyle(document.querySelector('#first')).color,
      authority:[typeof require,typeof haeWorkspace,typeof ipcRenderer],executed:typeof existing})`),
    { ...expected, first: '重复', scripts: 1, images: 0, color: 'rgb(12, 34, 56)', authority: ['undefined', 'undefined', 'undefined'], executed: 'undefined' });
    mapping.close();
  } finally { await previews.close(); window.destroy(); }
}

async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const f = await fixture(); let history = f.history;
  const title = find(history, 'h1'); const target = find(history, 'p', true); const pre = find(history, 'pre');
  apply(history, title, '修订标题🧪'); apply(history, pre, '\n新 <&> 😀'); apply(history, target, '');
  const empty = Buffer.from(original.toString().replace('年度 &#65; 😀', '修订标题🧪').replace('<pre id="pre">原</pre>', '<pre id="pre">\r\n\r\n新 &lt;&amp;&gt; 😀</pre>')
    .replace('<p id="target">重复</p>', '<p id="target"></p>'));
  assert.deepEqual(Buffer.from(history.candidate.bytes), empty); assert.deepEqual(await readFile(f.entry), original);
  const entries = await readdir(f.privateRoot);
  const drafts = await createDraftCheckpointStore(f.privateRoot, undefined, f.stores);
  const rejected = await drafts.write(f.source, history.source, history.candidate, randomUUID(), 4);
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.code, 'DRAFT_HISTORY_UNSUPPORTED');
  assert.deepEqual(await readdir(f.privateRoot), entries); assert.deepEqual(await readFile(f.entry), original);
  pass('the existing v1 store refuses a history-backed candidate before creating a lock or record, so it cannot claim persistence while dropping the history branch and source proof');
  if (process.platform === 'win32') {
    const saved = await f.save(f.source, history.candidate, new AbortController().signal); assert.equal(saved.status, 'committed');
    const current = await openSaveSource(f.entry, empty); assert.equal(await saved.verifySaved!(current), true);
    history = history.rebaseSaved(current.bytes, identity(2)); evidence.emptySaved = hash(await readFile(f.entry));
    await reopen(f.entry, { title: '修订标题🧪', target: '', pre: '\n新 <&> 😀', empty: true });
    pass('actual Windows Save writes the independent expected bytes, then fresh Chromium parsing confirms the Text is absent without changing scripts, attributes or resources');

    const before = history.capture(); const reverse = history.prepareMove('undo'); const diff = await workerPlan(history, reverse);
    assert.equal(history.capture().record, before.record); assert.equal(diff.changes[0]!.before.text, '');
    assert.equal(diff.changes[0]!.after.text, '重复'); assert.equal(diff.unchangedBytes, empty.length);
    history.commit(reverse); assert.deepEqual(await readFile(f.entry), empty);
    const restored = Buffer.from(empty.toString().replace('<p id="target"></p>', '<p id="target">重复</p>'));
    assert.deepEqual(Buffer.from(history.candidate.bytes), restored);
    const unsaved = history.capture();
    history = createTextHistory(current.bytes, identity(20), hash,
      { originBytes: unsaved.originBytes, record: JSON.parse(JSON.stringify(unsaved.record)) });
    assert.deepEqual(Buffer.from(history.candidate.bytes), restored);
    const roundTripRedo = history.prepareMove('redo'); await workerPlan(history, roundTripRedo); history.commit(roundTripRedo);
    const roundTripUndo = history.prepareMove('undo'); await workerPlan(history, roundTripUndo); history.commit(roundTripUndo);
    assert.deepEqual(Buffer.from(history.candidate.bytes), restored); assert.deepEqual(await readFile(f.entry), empty);
    pass('real Draft and Diff workers re-prove an empty target on the saved baseline; committing logical Undo only changes the in-memory draft, with a full reconstructible source Diff');

    const prepared = await f.stores.prepare(current, history.candidate); assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') throw Error('PREPARE_FAILED'); await prepared.cancel();
    assert.deepEqual(await readFile(f.entry), empty); assert.equal(history.summary().dirty, true);
    const second = await f.save(current, history.candidate, new AbortController().signal); assert.equal(second.status, 'committed');
    const next = await openSaveSource(f.entry, restored); assert.equal(await second.verifySaved!(next), true);
    history = history.rebaseSaved(next.bytes, identity(3)); await reopen(f.entry, { title: '修订标题🧪', target: '重复', pre: '\n新 <&> 😀', empty: false });
    const redo = history.prepareMove('redo'); await workerPlan(history, redo); history.commit(redo);
    assert.deepEqual(await readFile(f.entry), restored); assert.deepEqual(Buffer.from(history.candidate.bytes), empty);
    evidence.restoredSaved = hash(await readFile(f.entry));
    pass('cancelling preparation leaves HTML and Undo history intact; explicit second Save restores exactly one duplicate Text, and Redo becomes a new unsaved change against the next baseline');

    const checkpoint = history.capture(); const rebuilt = createTextHistory(next.bytes, identity(4), hash,
      { originBytes: checkpoint.originBytes, record: JSON.parse(JSON.stringify(checkpoint.record)) });
    const restoredUndo = rebuilt.prepareMove('undo'); await workerPlan(rebuilt, restoredUndo); rebuilt.commit(restoredUndo);
    assert.deepEqual(rebuilt.candidate.bytes, next.bytes); assert.equal(rebuilt.summary().dirty, false);
    pass('the strict logical history record round-trips under Electron Node with a fresh identity, retaining the saved point and Redo branch without serializing offsets or executing HTML');

    await writeFile(f.entry, 'external edit'); const retained = history.capture().record;
    const conflict = await f.save(next, history.candidate, new AbortController().signal); assert.equal(conflict.status, 'failed'); assert.equal(conflict.code, 'FILE_CHANGED');
    assert.equal(history.capture().record, retained); assert.equal(await readFile(f.entry, 'utf8'), 'external edit');
    pass('an external file conflict still rejects saving a historical candidate while preserving external bytes and the entire logical history');
  } else pending.push('Windows actual Save, cancellation, repeated savepoints, file conflict and Chromium reopening of the saved file');
  assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);

  const g = await fixture(async step => { if (step === 'native-replaced') throw Error('test lost acknowledgement'); });
  if (process.platform === 'win32') {
    const titleId = find(g.history, 'h1'); apply(g.history, titleId, '未知结果'); const retained = g.history.capture();
    const result = await g.save(g.source, g.history.candidate, new AbortController().signal); assert.equal(result.status, 'unknown');
    assert.equal(result.verifySaved, null); assert.equal(g.history.capture().record, retained.record);
    assert.deepEqual(Buffer.from(g.history.source.bytes), original); assert.deepEqual(await readFile(g.entry), Buffer.from(g.history.candidate.bytes));
    assert.equal((await g.stores.scan()).locked, true);
    pass('a real Windows replacement with a lost acknowledgement retains the old savepoint, candidate and private lock; matching disk bytes alone do not advance logical history');
  } else pending.push('Windows unknown replacement outcome');
  if (process.platform === 'win32') {
    const h = await fixture(); const pasted = '<script>window.injected=1</script><img src=x onerror=boom()> & 😀';
    const encoded = '&lt;script&gt;window.injected=1&lt;/script&gt;&lt;img src=x onerror=boom()&gt; &amp; 😀';
    const input = Buffer.from(original.toString().replace('<p id="target">重复</p>', `<p id="target">${encoded}</p>`));
    await writeFile(h.entry, input); let timeline = createTextHistory(input, identity(1), hash);
    const source = await openSaveSource(h.entry, input); const logical = find(timeline, 'p', true); apply(timeline, logical, '');
    const emptyBytes = timeline.candidate.bytes;
    const emptied = await h.save(source, timeline.candidate, new AbortController().signal); assert.equal(emptied.status, 'committed');
    const emptySource = await openSaveSource(h.entry, emptyBytes); assert.equal(await emptied.verifySaved!(emptySource), true);
    timeline = timeline.rebaseSaved(emptySource.bytes, identity(2));
    const undo = timeline.prepareMove('undo'); await workerPlan(timeline, undo); timeline.commit(undo);
    const finalSave = await h.save(emptySource, timeline.candidate, new AbortController().signal); assert.equal(finalSave.status, 'committed');
    assert.equal(await finalSave.verifySaved!(await openSaveSource(h.entry, input)), true);
    assert.deepEqual(await readFile(h.entry), input);
    await reopen(h.entry, { title: '年度 A 😀', target: pasted, pre: '原', empty: false });
    const previews = new PreviewController(outputRoot);
    try {
      const preview = await previews.open(h.entry, 'interactive');
      assert.deepEqual(await preview.contents.executeJavaScript('[existing,typeof injected,document.images.length]'), [41, 'undefined', 0]);
    } finally { await previews.close(); }
    pass('restoring a saved empty Text containing script/image-looking text remains literal after native Save and real Chromium reopening, including read-only interactive preview');
  } else pending.push('Windows saved empty Text restoration with script/image-looking text');
  await runHistoryPreview(outputRoot, pass);
  await runHistoryWorkspace(outputRoot, results, pass);
  evidence.original = hash(original); evidence.css = hash(css);
  await writeFile(join(results, 'history.json'), JSON.stringify({ status: 'passed', passed, pending, evidence,
    scope: 'Core history, bounded workers, isolated Preview, trusted Workspace commands, complete private history checkpoints and verified Windows Save; no product controls or manual IME acceptance',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions }, null, 2));
}
void run().then(() => app.exit(0)).catch(async error => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'history.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
