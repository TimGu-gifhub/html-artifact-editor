import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import type { CleanupSummary } from '../../src/contracts/record-cleanup.ts';
import { proofreadDocument, proofreadSnapshot } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';
import { source, css } from './acceptance-fixture.ts';

const [mode = '', profile = '', project = '', stage = ''] = process.argv.slice(2);
const modes = ['empty', 'basic', 'seed', 'resume', 'unsupported', 'close-join', 'loss-before', 'loss-after',
  'unknown', 'warning', 'root-replaced', 'profile-probe', 'quota-copy'];
if (!profile || !project || !modes.includes(mode)) throw Error('Invalid record cleanup arguments');
const entry = join(project, 'report.html'), outputRoot = resolve(__dirname, '..');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
const receipt = (value: unknown): void => { process.stdout.write('HAE_CLEANUP:' + JSON.stringify(value) + '\n'); };
const barrier = () => { let release!: () => void; const wait = new Promise<void>(done => { release = done; }); return { wait, release }; };
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
let product: Awaited<ReturnType<typeof createProductApplication>> | undefined;
let reviewChoice: 'confirm' | 'cancel' | 'invalid' = 'confirm';
let reviewCalls = 0, openCalls = 0, removeCount = 0;
let lastSummary: CleanupSummary | null = null;
let reviewHold: ReturnType<typeof barrier> | null = null;
let commitHold: ReturnType<typeof barrier> | null = null;
let reachedCommit = false;
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('TIMEOUT: ' + label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label = ''): Promise<void> {
  const hit: { point: { x: number; y: number } | null } = { point: null };
  await until(async () => {
    hit.point = await window.webContents.executeJavaScript('(() => {const e=[...document.querySelectorAll(' + JSON.stringify(selector)
      + ')].find(x=>!x.disabled&&x.getBoundingClientRect().width>0&&x.textContent.includes(' + JSON.stringify(label)
      + '));if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
    return hit.point !== null;
  }, 'enabled control ' + selector + ' ' + label);
  assert.ok(hit.point);
  window.focus(); window.webContents.focus();
  await until(() => window.isFocused() && window.webContents.isFocused(), 'native UI focus before click');
  window.webContents.sendInputEvent({ type: 'mouseDown', ...hit.point, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...hit.point, button: 'left', clickCount: 1 });
}
async function select(contents: WebContents, selector: string): Promise<void> {
  const point = await contents.executeJavaScript('(() => {const e=document.querySelector(' + JSON.stringify(selector)
    + ');const r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);const b=r.getBoundingClientRect();'
    + 'return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
  contents.focus();
  contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isFile()) result[item.name] = hash(await readFile(join(root, item.name)));
    else if (item.isDirectory()) for (const name of await readdir(join(root, item.name))) {
      result[item.name + '/' + name] = hash(await readFile(join(root, item.name, name)));
    }
  }
  return result;
}

async function run(): Promise<void> {
  await app.whenReady();
  if (mode === 'profile-probe') {
    const acquired = app.requestSingleInstanceLock();
    assert.equal(acquired, false);
    receipt({ event: 'checked', kind: 'profile-exclusion' }); app.exit(0); return;
  }
  product = await createProductApplication(outputRoot, { visible: false, choices: {
    open: async () => { openCalls++; return entry; },
    copy: async () => join(project, 'quota-draft.html'),
    review: async value => ({ reviewId: value.reviewId, decision: mode === 'quota-copy' ? 'save-copy' : 'cancel' }),
    cleanupReview: async summary => {
      reviewCalls++; lastSummary = summary;
      assert.equal(JSON.stringify(summary).includes(project), false);
      assert.equal(JSON.stringify(summary).includes(profile), false);
      if (reviewHold) await reviewHold.wait;
      return { reviewId: reviewChoice === 'invalid' ? randomUUID() : summary.reviewId,
        decision: reviewChoice === 'cancel' ? 'cancel' : 'clear-records' };
    },
  }, onRecordCleanupStep: async step => {
    if (step === 'cleanup-after-remove') removeCount++;
    if (mode === 'seed' && step === stage && (stage !== 'cleanup-after-remove' || removeCount === 1)) {
      receipt({ event: 'seeded', stage, pid: process.pid, summary: lastSummary });
      await new Promise<void>(() => {});
    }
    if (step === 'cleanup-journal-ready' && commitHold) { reachedCommit = true; await commitHold.wait; }
    if (mode === 'unknown' && step === 'cleanup-after-remove' && removeCount === 1) throw Error('Injected uncertain cleanup after exact removal');
    if (mode === 'warning' && step === 'cleanup-finished') throw Error('Injected completion warning');
  } });
  const { window, runtime, desktop } = product;
  window.showInactive();
  const state = () => proofreadSnapshot(runtime.workspace.snapshot());
  const extension = desktop.extension(window.webContents);
  const status = () => extension.snapshot().cleanup!;
  const ui = (script: string) => window.webContents.executeJavaScript(script);
  const privateRoot = runtime.storage.directory;
  await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'real product ready');
  const settled = async (): Promise<void> => until(() => {
    const current = state().current;
    return !!current && state().phase === 'idle' && !current.input.hasUnappliedInput
      && current.persistence?.status === 'persisted' && !current.persistence.cleanupPending
      && current.persistence.persisted?.draftRevision === current.input.draftRevision
      && current.persistence.persisted.resultHash === current.input.candidateHash;
  }, 'latest product checkpoint', 30000);
  const open = async (): Promise<void> => {
    await click(window, 'button', '打开 HTML');
    await until(() => state().current?.input.mappingStatus === 'ready', 'opened source');
  };
  const edit = async (durable = true): Promise<void> => {
    await until(() => runtime.host.current!.getBounds().width > 0, 'visible native Preview');
    const preview = proofreadDocument(runtime.workspace.current!).preview.contents;
    const before = await preview.executeJavaScript('document.querySelector("h1").textContent');
    await select(preview, 'h1');
    await until(async () => state().current?.input.input?.appliedText === before
      && await ui('!!document.querySelector("textarea.draft-input:not(:disabled)")'), 'selected real Text');
    await ui('(()=>{const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
    window.webContents.focus(); await window.webContents.insertText('年度 B 报告 🧪');
    await until(() => state().current?.input.input?.appliedText === '年度 B 报告 🧪'
      && !state().current?.input.hasUnappliedInput, 'live preview');
    if (durable) await settled();
  };
  const menu = async (): Promise<void> => {
    await click(window, '.toolbar button[aria-label="更多操作"]');
    await click(window, '[role=menuitem]', '清理本地记录');
    await until(() => ui('!!document.querySelector("[role=dialog]")'), 'cleanup dialog');
  };
  const start = async (): Promise<void> => { await click(window, '[role=dialog] button.primary'); };
  const result = async (expected: string): Promise<void> => {
    await until(() => status().phase === 'idle' && status().result?.status === expected, 'cleanup result ' + expected, 30000);
    await until(() => ui('!!document.querySelector("[role=dialog]")'), 'result dialog retained');
  };
  const closeDialog = async (): Promise<void> => {
    await click(window, '[role=dialog] .dlg-close');
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'dialog closed');
  };
  const close = (): void => { receipt({ event: 'closing', versions: process.versions }); window.close(); };
  const save = async (): Promise<void> => {
    await click(window, '.check-all input');
    await until(() => desktop.extension(window.webContents).snapshot().reviewed.length === state().current!.input.changes.length, 'all changes reviewed');
    await click(window, '.toolbar button', '复核并保存');
    await until(() => ui('!!document.querySelector("[role=dialog] .diff-list")'), 'actual reviewed Diff');
    await click(window, '[role=dialog] button.primary', '确认保存');
    await until(() => state().lastSave?.status === 'saved' && state().phase === 'idle', 'actual Windows Save', 30000);
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'Save acknowledgement'); await settled();
  };
  const seed = async (quota = false): Promise<void> => {
    const bytes = new Uint8Array(await readFile(entry)); const saved = await openSaveSource(entry, bytes);
    const sessionId = randomUUID();
    const history = createTextHistory(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
    const change = (value: string) => {
      const node = history.source.nodes.find(row => row.parentTag === 'h1')!;
      history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
        nodeId: node.nodeId, expectedText: history.textFor(node.nodeId)!, newText: value }));
    };
    change('草稿一 🧪');
    if (!quota) {
      const store = runtime.storage.checkpoints;
      assert.equal((await store.write(saved, history.source, history.candidate, sessionId, history.revision, history.capture())).status, 'persisted');
      change('草稿二 🧪');
      assert.equal((await store.write(saved, history.source, history.candidate, sessionId, history.revision, history.capture())).status, 'persisted');
      assert.equal((await store.retire(saved, sessionId, history.revision, 'discarded')).status, 'retired');
      assert.equal((await store.write(saved, history.source, history.candidate, randomUUID(), history.revision, history.capture())).status, 'persisted');
    }
    for (let i = 0; i < (quota ? 20 : 1); i++) {
      const plan = await runtime.storage.saves.prepare(saved, history.candidate);
      assert.equal(plan.status, 'prepared', plan.code ?? undefined);
      if (plan.status === 'prepared') await plan.cancel();
    }
  };
  if (mode === 'empty') {
    assert.equal((await ui('haeDesktop.request({kind:"clear-records",stateRevision:999999})')).code, 'STALE_WORKSPACE');
    const invalid = await ui('haeDesktop.request({kind:"clear-records",stateRevision:' + state().stateRevision + ',path:"foreign"})');
    assert.equal(invalid.ok, false); assert.equal(reviewCalls, 0);
    await menu();
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] button.primary")'), 'initial keyboard focus');
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] .dlg-close")'), 'Tab wraps inside dialog');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] button.primary")'), 'Shift Tab wraps inside dialog');
    await start(); await result('unavailable');
    assert.equal(status().result?.code, 'RECORD_CLEANUP_EMPTY');
    assert.equal(reviewCalls, 0); assert.deepEqual(await readdir(privateRoot), []);
    await closeDialog();
    assert.equal(await ui('document.activeElement?.getAttribute("aria-label")'), '更多操作');
    await open(); await menu();
    assert.equal(await ui('document.querySelector("[role=dialog] button.primary").disabled'), true);
    assert.equal((await ui('haeDesktop.request({kind:"clear-records",stateRevision:' + state().stateRevision + '})')).code, 'RECORD_CLEANUP_RESTART_REQUIRED');
    assert.equal(reviewCalls, 0); await closeDialog();
    receipt({ event: 'checked', kind: mode }); close(); return;
  }
  if (mode === 'quota-copy') {
    await seed(true);
    await open(); await edit(false);
    await until(() => state().current?.persistence?.status === 'failed', 'quota stopped persistence');
    assert.deepEqual(await readFile(entry), Buffer.from(source));
    const before = await files(privateRoot);
    receipt({ event: 'quota-full', persistence: state().current!.persistence, records: before });
    window.close(); const closed = await runtime.requestClose();
    assert.equal(closed, 'closed');
    // The parent independently reads the exclusive copy and records after exit.
    receipt({ event: 'checked', kind: mode }); return;
  }
  if (!['resume', 'unsupported'].includes(mode)) await seed();
  if (mode === 'root-replaced') {
    await rename(privateRoot, join(profile, 'workspace-records-preserved'));
    await mkdir(privateRoot);
  }
  const initial = await readFile(entry), before = await files(privateRoot);
  await menu(); window.setSize(960, 640);
  await until(() => ui('(()=>{const b=document.querySelector("[role=dialog]").getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})()'), '960x640 dialog');
  if (mode === 'unsupported' || mode === 'root-replaced') {
    await start(); await result('failed');
    assert.equal(reviewCalls, 0); assert.equal(status().requiresReview, false);
    if (mode === 'root-replaced') assert.equal(status().result?.code, 'RECORD_CLEANUP_ROOT_MISMATCH');
    assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
    receipt({ event: 'checked', kind: mode, result: status().result });
    if (mode === 'root-replaced') { await new Promise<void>(() => {}); return; }
    await closeDialog(); close(); return;
  }
  if (mode === 'basic' || mode === 'resume') {
    if (mode === 'basic') await writeFile(join(project, '../record-cleanup-start.png'), await captureReady(window.webContents));
    for (const choice of ['cancel', 'invalid'] as const) {
      reviewChoice = choice; const calls = reviewCalls; await start();
      await until(() => reviewCalls === calls + 1, 'separate Main review');
      await result(choice === 'cancel' ? 'cancelled' : 'failed');
      assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
      assert.equal(lastSummary!.resuming, mode === 'resume' && stage !== 'quota');
    }
    if (mode === 'basic') {
      reviewChoice = 'cancel'; reviewHold = barrier(); const calls = reviewCalls;
      await ui('(()=>{const b=document.querySelector("[role=dialog] button.primary");b.click();b.click();'
        + 'document.querySelector("[role=dialog] .dlg-close").click();'
        + 'document.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
        + 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"o",ctrlKey:true,bubbles:true}));})()');
      await until(() => reviewCalls === calls + 1 && status().phase === 'reviewing', 'one accepted Main review');
      assert.equal((await ui('haeDesktop.request({kind:"clear-records",stateRevision:' + state().stateRevision + '})')).code, 'RECORD_CLEANUP_BUSY');
      assert.equal((await ui('haeWorkspace.open(' + state().stateRevision + ')')).code, 'RECORD_CLEANUP_BUSY');
      assert.equal(openCalls, 0);
      assert.equal(await ui('!!document.querySelector("[role=dialog] .dlg-close:disabled")'), true);
      const held = reviewHold; reviewHold = null; held.release(); await result('cancelled');
      assert.deepEqual(await files(privateRoot), before);
    }
    reviewChoice = 'confirm';
  }
  if (mode === 'loss-before') {
    reviewHold = barrier(); await start();
    await until(() => status().phase === 'reviewing' && reviewCalls === 1, 'bound review before renderer loss');
    window.webContents.forcefullyCrashRenderer(); await until(() => !runtime.connected, 'old renderer revoked');
    const held = reviewHold; reviewHold = null; held.release();
    await until(() => status().phase === 'idle' && status().result?.status === 'cancelled', 'uncommitted decision cancelled');
    assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
    await runtime.reloadUI();
    await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'fresh renderer ready');
    await menu();
  }
  if (mode === 'close-join' || mode === 'loss-after') commitHold = barrier();
  await start();
  if (mode === 'seed') { await new Promise<void>(() => {}); return; }
  if (commitHold) {
    await until(() => reachedCommit && status().phase === 'cleaning', 'durable cleanup accepted');
    let closing: Promise<unknown> | null = null;
    if (mode === 'close-join') {
      window.close(); closing = runtime.requestClose(); await delay(150);
      assert.equal(window.isDestroyed(), false); assert.equal(runtime.connected, true);
    } else {
      window.webContents.forcefullyCrashRenderer(); await until(() => !runtime.connected, 'renderer lost after commitment');
    }
    assert.deepEqual(await readFile(entry), initial);
    const held = commitHold; commitHold = null; held.release();
    if (closing) {
      assert.equal(await closing, 'closed'); assert.equal(status().result?.status, 'cleared');
      receipt({ event: 'checked', kind: mode }); return;
    }
    await until(() => status().phase === 'idle' && status().result?.status === 'cleared', 'cleanup reconciled without renderer');
    await runtime.reloadUI();
    await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'new renderer ready');
    await menu();
  }
  await result(mode === 'unknown' ? 'unknown' : 'cleared');
  assert.deepEqual(await readFile(entry), initial);
  assert.deepEqual(await readFile(join(project, 'keep.css')), Buffer.from(css));
  assert.equal(runtime.workspace.current, null);
  if (mode === 'unknown' || mode === 'warning') {
    assert.equal(status().requiresReview, true);
    assert.equal((await ui('haeWorkspace.open(' + state().stateRevision + ')')).code, 'RECORD_CLEANUP_REVIEW_REQUIRED');
    assert.equal((await ui('haeDesktop.request({kind:"clear-records",stateRevision:' + state().stateRevision + '})')).code, 'RECORD_CLEANUP_REVIEW_REQUIRED');
    assert.equal(reviewCalls, 1); assert.equal(openCalls, 0);
    assert.equal(await runtime.requestClose(), 'cancelled'); assert.equal(window.isDestroyed(), false);
    await assert.rejects(runtime.dispose(), /EDITOR_RUNTIME_CLEANUP_REQUIRED/);
    assert.ok(app.hasSingleInstanceLock());
    if (mode === 'warning') assert.deepEqual(await readdir(privateRoot), []);
    else assert.ok((await readdir(privateRoot)).includes('record-cleanup.json'));
    receipt({ event: 'retained', kind: mode, result: status().result });
    await new Promise<void>(() => {}); return;
  }
  assert.deepEqual(await readdir(privateRoot), []);
  const oldIds = Object.keys(before).filter(name => name.includes('/')).map(name => name.split('/')[0]);
  if (mode === 'basic') await writeFile(join(project, '../record-cleanup-result.png'), await captureReady(window.webContents));
  await closeDialog(); window.setSize(1440, 900);
  if (mode === 'basic' || mode === 'resume') {
    await open(); await edit(); await save();
    assert.deepEqual(await readFile(entry), Buffer.from(source.replace('年度 &#65; 报告 😀', '年度 B 报告 🧪')));
    for (const id of await readdir(privateRoot)) assert.equal(oldIds.includes(id), false);
    assert.deepEqual(await proofreadDocument(runtime.workspace.current!).preview.contents.executeJavaScript(
      '({desktop:typeof haeDesktop,workspace:typeof haeWorkspace,node:typeof require})'),
      { desktop: 'undefined', workspace: 'undefined', node: 'undefined' });
  }
  receipt({ event: 'checked', kind: mode, result: status().result, summary: lastSummary, htmlHash: hash(await readFile(entry)) });
  close();
}
void run().catch(async (error: unknown) => {
  let uiEvidence: unknown = null;
  try {
    if (product && !product.window.isDestroyed() && !product.window.webContents.isCrashed()) {
      uiEvidence = await Promise.race([product.window.webContents.executeJavaScript(
        '({text:document.body.innerText,focus:document.activeElement?.outerHTML})'), delay(2500).then(() => ({ unavailable: true }))]);
      await writeFile(join(project, '../record-cleanup-failed.png'), await captureReady(product.window.webContents));
    }
  } catch { /* Preserve the original failure when the renderer is unavailable. */ }
  receipt({ event: 'failed', error: String(error), stack: error instanceof Error ? error.stack : null,
    workspace: product?.runtime.workspace.snapshot(), uiEvidence });
  app.exit(1);
});
