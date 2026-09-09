import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseWindow, ipcMain } from 'electron';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import type { TextHistory, HistoryTransition } from '../../src/core/history/timeline.ts';
import type { SourceLineage } from '../../src/core/parser/source-index.ts';
import { PreviewController } from '../../src/main/preview/project-preview.ts';
import { createPreviewMapping } from '../../src/main/preview/source-mapping.ts';
import type { PreviewMapping } from '../../src/main/preview/source-mapping.ts';
import { prepareDraft } from '../../src/main/draft/prepare.ts';
import { MAPPING_EVENT, MAPPING_INSTALL } from '../../src/contracts/mapping.ts';
import { MAPPING_HISTORY, MAPPING_HISTORY_RESULT } from '../../src/contracts/mapping-history.ts';
import type { MappingHistory } from '../../src/contracts/mapping-history.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const id = (generation: number) => ({ projectId: 'history-preview', documentId: `fixture-${generation}`, generation });
const original = '\ufeff<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}p{margin:18px}</style>'
  + '<h1>原题😀</h1><p id="first">重复</p><p id="target">重复</p><div id="mixed">左<!-- keep --><b>粗</b>右</div><pre id="pre">原</pre>';
const target = (history: TextHistory, value: string, last = false) => {
  const matches = history.source.nodes.filter(node => node.editable && node.decodedText === value);
  return matches[last ? matches.length - 1 : 0]!.nodeId;
};
function edit(history: TextHistory, nodeId: string, newText: string): void {
  history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
    nodeId, expectedText: history.textFor(nodeId)!, newText }));
}
function seed(html = original): TextHistory {
  const history = createTextHistory(Buffer.from(html), id(1), hash);
  if (html === original) {
    edit(history, target(history, '原题😀'), '前置增长🧪');
    for (const value of ['左', '右', '原']) edit(history, target(history, value), '');
    edit(history, target(history, '重复', true), '');
  } else edit(history, target(history, 'A'), '');
  return history.rebaseSaved(history.candidate.bytes, id(2));
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('HISTORY_PREVIEW_WAIT_TIMEOUT'); await new Promise(resolveWait => setTimeout(resolveWait, 15)); }
}

export async function runHistoryPreview(outputRoot: string, pass: (message: string) => void): Promise<void> {
  async function view(initial = seed()) {
    const root = await mkdtemp(join(resolve(outputRoot, '../test-results'), 'history-preview-case-'));
    const entry = join(root, 'report.html'); await writeFile(entry, initial.source.bytes);
    const previews = new PreviewController(outputRoot); const window = new BaseWindow({ show: false, width: 900, height: 700 });
    const preview = await previews.open(entry); window.contentView.addChildView(preview.view);
    preview.view.setBounds({ x: 0, y: 0, width: 900, height: 700 }); window.showInactive();
    let mapping: PreviewMapping | undefined;
    return { entry, preview, initial,
      async bind(lineage: SourceLineage = initial.source.lineage!) {
        mapping = await createPreviewMapping(outputRoot, preview, new AbortController().signal, lineage);
        assert.equal(mapping.status, 'ready', mapping.reason ?? 'mapping not ready');
        const history = createTextHistory(mapping.source.bytes, mapping.source.identity, hash, initial.capture());
        return { mapping, history };
      },
      async close() { mapping?.close(); await previews.close(); window.destroy(); },
    };
  }
  async function move(mapping: PreviewMapping, history: TextHistory, direction: 'undo' | 'redo') {
    const revision = mapping.revision; const plan = history.prepareMove(direction); const change = plan.changes[0]!;
    const candidate = await prepareDraft(outputRoot, mapping.source, history.candidate,
      { identity: mapping.source.identity, baseHash: mapping.source.baseHash, ...change }, new AbortController().signal);
    assert.deepEqual(candidate.bytes, plan.candidate.bytes);
    assert.equal(await mapping.applyHistory(revision, change), 'applied'); history.commit(plan); return plan;
  }
  async function clickTitle(f: Awaited<ReturnType<typeof view>>, mapping: PreviewMapping): Promise<void> {
    const point = await f.preview.contents.executeJavaScript('(()=>{const r=document.querySelector("h1").getBoundingClientRect();return {x:Math.floor(r.x+12),y:Math.floor(r.y+r.height/2)}})()') as { x: number; y: number };
    f.preview.contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    f.preview.contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await until(() => mapping.selection !== null);
  }

  const f = await view();
  try {
    assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("#target").childNodes.length'), 0);
    const { mapping, history } = await f.bind();
    mapping.source.bytes.fill(0); mapping.source.lineage!.originBytes.fill(0);
    assert.equal(Object.isFrozen(mapping.source.lineage!.values), true);
    assert.deepEqual(await f.preview.contents.executeJavaScript(`({target:document.querySelector('#target').childNodes.length,
      mixed:[...document.querySelector('#mixed').childNodes].map(n=>[n.nodeType,n.nodeValue]),pre:document.querySelector('#pre').childNodes.length,
      authority:[typeof require,typeof ipcRenderer,typeof haeWorkspace,typeof lineage]})`),
    { target: 1, mixed: [[3, ''], [8, ' keep '], [1, null], [3, '']], pre: 1,
      authority: ['undefined', 'undefined', 'undefined', 'undefined'] });
    for (let i = 0; i < 4; ++i) await move(mapping, history, 'undo');
    assert.deepEqual(await f.preview.contents.executeJavaScript('[document.querySelector("#first").textContent,document.querySelector("#target").textContent,document.querySelector("#mixed").textContent,document.querySelector("#pre").textContent]'),
      ['重复', '重复', '左粗右', '原']);
    for (let i = 0; i < 4; ++i) await move(mapping, history, 'redo');
    assert.equal(mapping.selection, null); assert.equal(history.summary().dirty, false);
    assert.deepEqual(await readFile(f.entry), Buffer.from(f.initial.source.bytes));
    pass('fresh source proof installs only the missing empty Text objects in a real isolated Preview; production Worker candidates and confirmed Undo/Redo update exact duplicate, mixed-sibling and pre targets without HTML writes or page authority');

    const oldRevision = mapping.revision; const before = history.capture(); const stale = history.prepareMove('undo');
    await clickTitle(f, mapping);
    assert.equal(await mapping.applyHistory(oldRevision, stale.changes[0]!), 'rejected'); assert.equal(history.capture().record, before.record);
    const selected = mapping.selection!; const token = await mapping.beginEditing(selected); assert.ok(token);
    assert.equal(await mapping.applyHistory(mapping.revision, stale.changes[0]!), 'rejected');
    const change = { identity: mapping.source.identity, baseHash: mapping.source.baseHash, nodeId: selected.nodeId,
      expectedText: history.textFor(selected.nodeId)!, newText: '普通应用 <&> 😀' };
    const plan = history.prepareEdit(change);
    assert.equal(await mapping.applyText(mapping.selection!, change.expectedText, change.newText), 'applied'); history.commit(plan);
    assert.equal(await mapping.finishEditing(token!, 'release', null), true);
    await move(mapping, history, 'undo'); assert.equal(await f.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '前置增长🧪');
    assert.equal(mapping.selection, null); assert.deepEqual(await readFile(f.entry), Buffer.from(f.initial.source.bytes));
    pass('native clicks invalidate prepared mapping revisions, edit-token ownership blocks history writes, and a confirmed ordinary Apply updates the private expected value used by the next historical Undo');
  } finally { await f.close(); }

  const plain = createTextHistory(Buffer.from('<!doctype html><p>A</p>'), id(1), hash); const r = await view(plain);
  try {
    const { mapping, history } = await r.bind(); const nodeId = target(history, 'A');
    const plan = history.prepareEdit({ identity: mapping.source.identity, baseHash: mapping.source.baseHash, nodeId, expectedText: 'A', newText: 'restored <&> 😀' });
    assert.equal(await mapping.restoreTexts(plan.changes), 'applied'); history.commit(plan);
    await move(mapping, history, 'undo'); assert.equal(await r.preview.contents.executeJavaScript('document.querySelector("p").textContent'), 'A');
    assert.deepEqual(await readFile(r.entry), Buffer.from(plain.source.bytes));
    pass('a fresh recovery batch updates the same retained Text values, so later historical Undo remains valid without reusing restoration authority');
  } finally { await r.close(); }

  const bad = await view();
  try {
    const lineage = bad.initial.source.lineage!;
    await assert.rejects(() => bad.bind({ ...lineage, originBytes: Buffer.from(Buffer.from(lineage.originBytes).toString().replace('<!-- keep -->', '<!-- changed -->')) }), /HISTORY_SOURCE_MISMATCH/);
    assert.equal(await bad.preview.contents.executeJavaScript('document.querySelector("#target").childNodes.length'), 0);
    assert.deepEqual(await readFile(bad.entry), Buffer.from(bad.initial.source.bytes));
  } finally { await bad.close(); }
  const early = await view();
  try {
    await early.preview.contents.executeJavaScript('(()=>{const p=document.querySelector("#target");p.setAttribute("data-change","yes");p.removeAttribute("data-change")})()');
    await assert.rejects(() => early.bind(), /DOM_MUTATED/);
    assert.equal(await early.preview.contents.executeJavaScript('document.querySelector("#target").childNodes.length'), 0);
  } finally { await early.close(); }
  for (const html of [
    '<!doctype html><p id="target">A</p><div><template shadowrootmode="open"><b>shadow</b></template></div>',
    '<!doctype html><style>p::before{content:"generated"}</style><p id="target">A</p>',
  ]) {
    const blocked = await view(seed(html));
    try {
      await assert.rejects(() => blocked.bind(), /UNSUPPORTED_DOM|TREE_MISMATCH/);
      assert.equal(await blocked.preview.contents.executeJavaScript('document.querySelector("#target").childNodes.length'), 0);
    } finally { await blocked.close(); }
  }
  pass('foreign source lineage, pre-binding DOM changes, a mismatching declarative Shadow DOM and generated-content targets are rejected before any empty Text insertion');

  const changed = await view();
  try {
    const { mapping, history } = await changed.bind(); const captured = history.capture();
    await changed.preview.contents.executeJavaScript('(()=>{const p=document.querySelector("#target"),n=p.firstChild;p.removeChild(n);p.append(n)})()');
    await until(() => mapping.status === 'invalidated');
    assert.equal(mapping.reason, 'DOM_MUTATED');
    assert.equal(await mapping.applyHistory(mapping.revision, history.prepareMove('undo').changes[0]!), 'rejected');
    assert.equal(history.capture().record, captured.record); assert.deepEqual(await readFile(changed.entry), Buffer.from(changed.initial.source.bytes));
    pass('removing and reinserting the same empty Text invalidates the mapping even when final DOM values are unchanged, retaining the original history and source');
  } finally { await changed.close(); }

  const lost = await view();
  try {
    const { mapping, history } = await lost.bind(); const before = history.capture(); const plan = history.prepareMove('undo');
    const callbacks = ipcMain.listeners(MAPPING_HISTORY_RESULT) as Array<Parameters<typeof ipcMain.on>[1]>;
    assert.equal(callbacks.length, 1); callbacks.forEach(callback => ipcMain.removeListener(MAPPING_HISTORY_RESULT, callback));
    try {
      assert.equal(await mapping.applyHistory(mapping.revision, plan.changes[0]!), 'unknown');
      assert.equal(mapping.status, 'invalidated'); assert.equal(mapping.reason, 'HISTORY_OUTCOME_UNKNOWN');
      assert.equal(await lost.preview.contents.executeJavaScript('document.querySelector("#target").textContent'), '重复');
      assert.equal(history.capture().record, before.record); assert.deepEqual(history.candidate.bytes, lost.initial.candidate.bytes);
      assert.equal(await mapping.applyHistory(mapping.revision, plan.changes[0]!), 'rejected');
      assert.deepEqual(await readFile(lost.entry), Buffer.from(lost.initial.source.bytes));
    } finally { callbacks.forEach(callback => ipcMain.on(MAPPING_HISTORY_RESULT, callback)); }
    pass('a deliberately lost acknowledgement after an actual isolated Text write returns unknown, invalidates further writes and leaves the old logical history plus the prepared candidate available without automatic retry');
  } finally { await lost.close(); }

  const owner = await view(); const peer = await view();
  try {
    const { mapping, history } = await owner.bind(); const plan: HistoryTransition = history.prepareMove('undo');
    const send = owner.preview.contents.send; let request: MappingHistory | undefined;
    owner.preview.contents.send = function(channel, ...args) {
      if (channel === MAPPING_HISTORY) { request = args[0] as MappingHistory; return; }
      send.call(this, channel, ...args);
    };
    try {
      let settled = false; const pending = mapping.applyHistory(mapping.revision, plan.changes[0]!).then(value => { settled = true; return value; });
      assert.ok(request);
      const response = { identity: request!.identity, requestId: request!.requestId, nodeId: request!.nodeId,
        revision: request!.revision, nextRevision: request!.revision + 1, outcome: 'applied' };
      ipcMain.emit(MAPPING_HISTORY_RESULT, { sender: peer.preview.contents, senderFrame: peer.preview.contents.mainFrame }, response);
      ipcMain.emit(MAPPING_HISTORY_RESULT, { sender: owner.preview.contents, senderFrame: owner.preview.contents.mainFrame }, { ...response, requestId: randomUUID() });
      await new Promise(resolveTick => setTimeout(resolveTick, 0)); assert.equal(settled, false); assert.equal(history.summary().dirty, false);
      send.call(owner.preview.contents, MAPPING_HISTORY, request);
      assert.equal(await pending, 'applied'); history.commit(plan);
      ipcMain.emit(MAPPING_HISTORY_RESULT, { sender: owner.preview.contents, senderFrame: owner.preview.contents.mainFrame }, response);
      assert.equal(history.summary().undoCount, 4); assert.equal(mapping.status, 'ready');
    } finally { owner.preview.contents.send = send; }
    pass('a real peer Preview sender, a foreign request acknowledgement and a replay cannot confirm or repeat another mapping historical operation');
  } finally { await owner.close(); await peer.close(); }

  const missing = await view();
  try {
    const identity = { preview: missing.preview.identity, documentId: randomUUID(), baseHash: missing.initial.source.baseHash };
    const failure = new Promise<string>((resolveFailure, rejectFailure) => {
      const timeout = setTimeout(() => { ipcMain.removeListener(MAPPING_EVENT, listen); rejectFailure(new Error('EXPECTED_MAPPING_FAILURE')); }, 3000);
      const listen = (_event: unknown, payload: { identity?: { documentId: string }; kind?: string; reason: string }) => {
        if (payload.identity?.documentId !== identity.documentId || payload.kind !== 'invalidated') return;
        clearTimeout(timeout); ipcMain.removeListener(MAPPING_EVENT, listen); resolveFailure(payload.reason);
      };
      ipcMain.on(MAPPING_EVENT, listen);
    });
    missing.preview.contents.send(MAPPING_INSTALL, { identity, tree: missing.initial.source.tree });
    assert.equal(await failure, 'TREE_MISMATCH');
    assert.equal(await missing.preview.contents.executeJavaScript('document.querySelector("#target").childNodes.length'), 0);
    pass('an augmented source tree alone cannot create missing DOM nodes: isolated installation requires the explicit proven-empty contract and otherwise fails without writes');
  } finally { await missing.close(); }
}
