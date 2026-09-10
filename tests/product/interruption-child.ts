import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { proofreadDocument, proofreadSnapshot } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';
import type { InterruptionSummary } from '../../src/contracts/interruption.ts';
import { source, css, edits } from './acceptance-fixture.ts';

const [mode = '', profile = '', projectArg = '', requestedSession = '', observation = 'baseline-matches'] = process.argv.slice(2);
const modes = ['seed-prepared', 'seed-committed', 'seed-candidate', 'seed-compaction', 'seed-incomplete', 'empty', 'unsupported', 'basic',
  'simple', 'stale-review', 'close-join', 'loss-before', 'loss-after', 'unknown', 'warning', 'seed-resolution'];
if (!profile || !projectArg || !mode || !modes.includes(mode)) throw Error('Invalid interruption arguments');
const project = projectArg, entry = join(project, 'report.html'), outputRoot = resolve(__dirname, '..');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
const receipt = (value: unknown): void => { process.stdout.write('HAE_INTERRUPTION:' + JSON.stringify(value) + '\n'); };
const barrier = () => { let release!: () => void; const wait = new Promise<void>(done => { release = done; }); return { wait, release }; };
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
let product: Awaited<ReturnType<typeof createProductApplication>> | undefined;
let sourceChoice: 'normal' | 'cancel' | 'wrong' = 'normal';
let reviewChoice: 'confirm' | 'cancel' | 'invalid' | 'change-source' = 'confirm';
let chooseCalls = 0, reviewCalls = 0, openCalls = 0;
let chooserHold: ReturnType<typeof barrier> | null = null;
let reviewHold: ReturnType<typeof barrier> | null = null;
let commitHold: ReturnType<typeof barrier> | null = null;
let reachedCommit = false;
let lastSummary: InterruptionSummary | null = null;
let snapshotStatus: (() => unknown) | undefined;

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
  product = await createProductApplication(outputRoot, { visible: false, choices: {
    open: async () => { openCalls++; return entry; },
    interruptionSource: async () => {
      chooseCalls++; if (chooserHold) await chooserHold.wait;
      return sourceChoice === 'cancel' ? undefined : sourceChoice === 'wrong' ? join(project, 'wrong.html') : entry;
    },
    interruptionReview: async summary => {
      reviewCalls++; lastSummary = summary;
      if (reviewHold) await reviewHold.wait;
      if (reviewChoice === 'change-source') await writeFile(entry, source + '<!-- external review-time change -->\r\n');
      return { reviewId: reviewChoice === 'invalid' ? randomUUID() : summary.reviewId,
        decision: reviewChoice === 'cancel' ? 'cancel' : summary.kind === 'save' ? 'keep-current' : 'continue-cleanup' };
    },
    review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }),
  }, onStorageStep: async (kind, step) => {
    const target = mode === 'seed-incomplete' ? 'backup-created' : mode === 'seed-prepared' ? 'prepared-synced' : mode === 'seed-committed' ? 'committed-synced'
      : mode === 'seed-candidate' ? 'native-replaced' : mode === 'seed-compaction' ? 'compaction-after-origin.bin' : null;
    if (!target || step !== target) return;
    assert.equal(kind, mode === 'seed-compaction' ? 'checkpoint' : 'save');
    const document = proofreadDocument(product!.runtime.workspace.current!);
    receipt({ event: 'seeded', sessionId: document.checkpointSessionId, step,
      draftRevision: document.draft.revision, candidateHash: document.input.snapshot().candidateHash, pid: process.pid });
    await new Promise<void>(() => {});
  }, onInterruptionStep: async (_kind, step) => {
    const recordReady = step === 'save-recovery-record-ready' || step === 'recovery-record-ready';
    if (mode === 'seed-resolution' && recordReady) {
      receipt({ event: 'resolution-seeded', step, pid: process.pid }); await new Promise<void>(() => {});
    }
    if (recordReady && commitHold) { reachedCommit = true; await commitHold.wait; }
    if (mode === 'unknown' && recordReady) throw Error('Test interruption after durable resolution record');
    if (mode === 'warning' && (step === 'save-recovery-after-lock' || step === 'recovery-after-lock')) throw Error('Test confirmed cleanup warning');
  } });
  const { window, runtime, desktop } = product;
  window.showInactive();
  const state = () => proofreadSnapshot(runtime.workspace.snapshot());
  const extension = desktop.extension(window.webContents);
  const status = () => extension.snapshot().interruption!;
  snapshotStatus = status;
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
  const edit = async (selector: string, value: string, durable = true): Promise<void> => {
    await until(() => runtime.host.current!.getBounds().width > 0, 'visible native Preview');
    const preview = proofreadDocument(runtime.workspace.current!).preview.contents;
    const before = await preview.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').textContent');
    await select(preview, selector);
    await until(async () => state().current?.input.input?.appliedText === before
      && await ui('!!document.querySelector("textarea.draft-input:not(:disabled)")'), 'selected real Text');
    await ui('(()=>{const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
    window.webContents.focus(); await window.webContents.insertText(value);
    await until(() => state().current?.input.input?.appliedText === value && !state().current?.input.hasUnappliedInput, 'live preview');
    if (durable) await settled();
  };
  const menu = async (label: string): Promise<void> => {
    await click(window, '.toolbar button[aria-label="更多操作"]');
    await click(window, '[role=menuitem]', label);
    await until(() => ui('!!document.querySelector("[role=dialog]")'), 'product dialog ' + label);
  };
  const start = async (): Promise<void> => { await click(window, '[role=dialog] button.primary'); };
  const result = async (expected: string): Promise<void> => {
    await until(() => status().phase === 'idle' && status().result?.status === expected, 'interruption result ' + expected);
    await until(() => ui('!!document.querySelector("[role=dialog]")'), 'result dialog retained');
  };
  const save = async (wait = true): Promise<void> => {
    await click(window, '.check-all input');
    await until(() => desktop.extension(window.webContents).snapshot().reviewed.length === state().current!.input.changes.length, 'all changes reviewed');
    await click(window, '.toolbar button', '复核并保存');
    await until(() => ui('!!document.querySelector("[role=dialog] .diff-list")'), 'actual reviewed Diff');
    await click(window, '[role=dialog] button.primary', '确认保存');
    if (wait) {
      await until(() => state().lastSave?.status === 'saved' && state().phase === 'idle', 'actual Windows Save', 30000);
      await until(() => ui('!document.querySelector("[role=dialog]")'), 'Save acknowledgement'); await settled();
    }
  };
  const closeDialog = async (): Promise<void> => {
    await click(window, '[role=dialog] .dlg-close');
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'dialog closed');
  };
  const close = (): void => { receipt({ event: 'closing', versions: process.versions }); window.close(); };
  if (mode.startsWith('seed-') && mode !== 'seed-resolution') {
    await click(window, 'button', '打开 HTML');
    await until(() => state().current?.input.mappingStatus === 'ready', 'opened source');
    const count = mode === 'seed-compaction' ? 3 : 1;
    for (const [index, [selector, value]] of edits.slice(0, count).entries()) {
      await edit(selector, value, mode !== 'seed-compaction' || index < count - 1);
    }
    assert.deepEqual(await readFile(entry), Buffer.from(source));
    assert.deepEqual(await proofreadDocument(runtime.workspace.current!).preview.contents.executeJavaScript(
      '({desktop:typeof haeDesktop,workspace:typeof haeWorkspace,node:typeof require})'), { desktop: 'undefined', workspace: 'undefined', node: 'undefined' });
    if (mode !== 'seed-compaction') await save(false);
    await new Promise<void>(() => {}); return;
  }
  if (mode === 'empty') {
    const stale = await ui('haeDesktop.request({kind:"inspect-interruption",stateRevision:999999})');
    assert.equal(stale.code, 'STALE_WORKSPACE'); assert.equal(chooseCalls, 0);
    await menu('检查上次中断');
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] button.primary")'), 'initial keyboard focus');
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] .dlg-close")'), 'Tab wraps inside dialog');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
    await until(() => ui('document.activeElement === document.querySelector("[role=dialog] button.primary")'), 'Shift Tab wraps inside dialog');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await result('unavailable');
    assert.equal(chooseCalls, 0);
    await closeDialog();
    assert.equal(await ui('document.activeElement?.getAttribute("aria-label")'), '更多操作', 'dialog returns focus to its stable menu trigger');
    await click(window, 'button', '打开 HTML');
    await until(() => state().current?.input.mappingStatus === 'ready', 'active product document');
    await menu('检查上次中断');
    assert.equal(await ui('document.querySelector("[role=dialog] button.primary").disabled'), true);
    const blocked = await ui('haeDesktop.request({kind:"inspect-interruption",stateRevision:' + state().stateRevision + '})');
    assert.equal(blocked.code, 'INTERRUPTION_RESTART_REQUIRED'); assert.equal(chooseCalls, 0);
    assert.deepEqual(await readFile(entry), Buffer.from(source)); await closeDialog();
    receipt({ event: 'checked', kind: 'empty-and-active-exclusion' }); close(); return;
  }
  const initial = await readFile(entry);
  const before = await files(privateRoot);
  await menu('检查上次中断');
  window.setSize(960, 640);
  await until(() => ui('(()=>{const b=document.querySelector("[role=dialog]").getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})()'), '960x640 dialog');
  if (mode === 'unsupported') {
    await start(); await result('failed');
    assert.equal(reviewCalls, 0); assert.equal(status().requiresReview, false);
    assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
    receipt({ event: 'checked', kind: 'unsupported-complete-evidence-required', result: status().result });
    await closeDialog(); close(); return;
  }
  if (mode === 'basic') {
    await writeFile(join(project, '../interruption-start.png'), await captureReady(window.webContents));
    for (const choice of ['cancel', 'wrong'] as const) {
      sourceChoice = choice; const old = chooseCalls;
      await start(); await until(() => chooseCalls === old + 1, 'fresh native source choice');
      await result(choice === 'cancel' ? 'cancelled' : 'failed');
      assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial); assert.equal(reviewCalls, 0);
    }
    sourceChoice = 'normal';
    for (const choice of ['cancel', 'invalid'] as const) {
      reviewChoice = choice; const old = reviewCalls; await start();
      await until(() => reviewCalls === old + 1, 'separate exact native review');
      await result(choice === 'cancel' ? 'cancelled' : 'failed');
      assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
    }
    reviewChoice = 'confirm'; chooserHold = barrier(); sourceChoice = 'cancel';
    const old = chooseCalls;
    await ui('(()=>{const b=document.querySelector("[role=dialog] button.primary");b.click();b.click();'
      + 'document.querySelector("[role=dialog] .dlg-close").click();'
      + 'document.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
      + 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"o",ctrlKey:true,bubbles:true}));})()');
    await until(() => chooseCalls === old + 1 && status().phase === 'checking', 'one accepted native chooser');
    const duplicate = await ui('haeDesktop.request({kind:"inspect-interruption",stateRevision:' + state().stateRevision + '})');
    assert.equal(duplicate.code, 'INTERRUPTION_BUSY');
    const other = await ui('haeWorkspace.open(' + state().stateRevision + ')');
    assert.equal(other.code, 'INTERRUPTION_BUSY'); assert.equal(openCalls, 0);
    assert.equal(await ui('!!document.querySelector("[role=dialog] .dlg-close:disabled")'), true);
    const held = chooserHold; chooserHold = null; held.release(); await result('cancelled');
    assert.deepEqual(await files(privateRoot), before); sourceChoice = 'normal';
  }
  if (mode === 'stale-review') {
    reviewChoice = 'change-source'; await start(); await result('failed');
    assert.equal(status().requiresReview, false);
    assert.deepEqual(await files(privateRoot), before);
    assert.deepEqual(await readFile(entry), Buffer.from(source + '<!-- external review-time change -->\r\n'));
    reviewChoice = 'confirm';
  }
  if (mode === 'loss-before') {
    reviewHold = barrier(); await start();
    await until(() => status().phase === 'reviewing' && reviewCalls === 1, 'bound review before renderer loss');
    window.webContents.forcefullyCrashRenderer();
    await until(() => !runtime.connected, 'old renderer revoked');
    const held = reviewHold; reviewHold = null; held.release();
    await until(() => status().phase === 'idle' && status().result?.status === 'cancelled', 'old decision cancelled');
    assert.deepEqual(await files(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
    await runtime.reloadUI();
    await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'fresh renderer ready');
    await menu('检查上次中断');
  }
  if (mode === 'close-join' || mode === 'loss-after') commitHold = barrier();
  await start();
  if (mode === 'seed-resolution') { await new Promise<void>(() => {}); return; }
  if (commitHold) {
    await until(() => reachedCommit && status().phase === 'resolving', 'accepted durable resolution');
    const expectedBytes = await readFile(entry);
    let closing: Promise<unknown> | null = null;
    if (mode === 'close-join') {
      window.close(); closing = runtime.requestClose(); await delay(150);
      assert.equal(window.isDestroyed(), false); assert.equal(runtime.connected, true);
    } else {
      window.webContents.forcefullyCrashRenderer(); await until(() => !runtime.connected, 'renderer revoked after commitment');
    }
    assert.equal(reviewCalls, 1); assert.deepEqual(await readFile(entry), expectedBytes);
    const held = commitHold; commitHold = null; held.release();
    if (closing) {
      assert.equal(await closing, 'closed'); assert.equal(status().result?.status, 'resolved'); assert.equal(status().requiresReview, false);
      receipt({ event: 'checked', kind: 'close-joined', result: status().result }); return;
    }
    await until(() => status().phase === 'idle' && status().result?.status === 'resolved', 'exact transaction reconciled without renderer');
    await runtime.reloadUI();
    await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'new renderer snapshot');
    await menu('检查上次中断');
  }
  await result(mode === 'unknown' ? 'unknown' : 'resolved');
  const resolvedBytes = await readFile(entry);
  if (mode !== 'stale-review') assert.deepEqual(resolvedBytes, initial);
  assert.equal(runtime.workspace.current, null, 'resolution never installs or replays a document');
  assert.ok(lastSummary);
  assert.equal(lastSummary.kind === 'save' ? lastSummary.observed : 'compaction', observation);
  const desktopJson = JSON.stringify(status());
  assert.equal(desktopJson.includes(project), false); assert.equal(desktopJson.includes(profile), false);
  if (mode === 'unknown' || mode === 'warning') {
    assert.equal(status().requiresReview, true);
    const blocked = await ui('haeWorkspace.open(' + state().stateRevision + ')');
    assert.equal(blocked.code, 'INTERRUPTION_REVIEW_REQUIRED'); assert.equal(openCalls, 0);
    const retry = await ui('haeDesktop.request({kind:"inspect-interruption",stateRevision:' + state().stateRevision + '})');
    assert.equal(retry.code, 'INTERRUPTION_REVIEW_REQUIRED'); assert.equal(chooseCalls, 1); assert.equal(reviewCalls, 1);
    assert.equal(await runtime.requestClose(), 'cancelled'); assert.equal(window.isDestroyed(), false);
    await assert.rejects(runtime.dispose(), /EDITOR_RUNTIME_CLEANUP_REQUIRED/);
    assert.ok(app.hasSingleInstanceLock()); assert.equal(window.isDestroyed(), false);
    receipt({ event: 'retained', kind: mode, result: status().result, requiresReview: true });
    await new Promise<void>(() => {}); return;
  }
  const after = await files(privateRoot);
  assert.equal(after['active.lock'], undefined);
  if (lastSummary.kind === 'save') {
    for (const [name, digest] of Object.entries(before)) if (name !== 'active.lock') assert.equal(after[name], digest, 'original transaction ' + name);
    assert.equal(Object.keys(after).filter(name => /^save-resolution-.*\.complete\.json$/u.test(name)).length, 1);
  } else {
    const journal = JSON.parse(await readFile(join(project, '../seed-journal.json'), 'utf8'));
    assert.equal(after['compaction.json'], undefined);
    for (const [name, digest] of Object.entries(before)) {
      if (journal.retained.some((row: { checkpointId: string }) => name.startsWith(row.checkpointId + '/'))) assert.equal(after[name], digest);
    }
  }
  await writeFile(join(project, '../interruption-result.png'), await captureReady(window.webContents));
  await closeDialog(); window.setSize(1440, 900);
  await menu('恢复草稿记录');
  const catalog = await runtime.workspace.listRecovery();
  const index = catalog.entries.findIndex(row => row.sessionId === requestedSession);
  assert.ok(index >= 0); assert.equal(catalog.locked, false); assert.equal(catalog.reviewRequired, false);
  await until(() => ui('document.querySelectorAll("[role=dialog] .record-item").length>0'), 'post-resolution catalog');
  const restoreButton = '[role=dialog] .record-list > .record-item:nth-child(' + (index + 1) + ') button';
  await click(window, restoreButton, '恢复');
  if (observation === 'candidate-on-disk' || observation === 'conflict') {
    await until(async () => state().phase === 'idle' && await ui('!!document.querySelector("[role=dialog] [role=alert]")'), 'unverified old history refused');
    assert.equal(state().current, null); assert.deepEqual(await readFile(entry), resolvedBytes); await closeDialog();
    await click(window, 'button', '打开 HTML');
    await until(() => state().current?.input.mappingStatus === 'ready', 'explicit current-file open');
    assert.equal(state().current!.input.changes.length, 0); assert.equal(state().current!.input.history!.undoCount, 0);
  } else {
    await until(() => state().current?.input.mappingStatus === 'ready', 'fresh verified document recovery');
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'authoritative restore acknowledgement');
    await settled();
    const count = observation === 'compaction' ? 3 : 1;
    assert.equal(state().current!.input.history!.undoCount, count);
    assert.equal(state().current!.input.changes.length, observation === 'committed-matches' ? 0 : count);
    assert.deepEqual(await readFile(entry), resolvedBytes);
    for (const [selector, value] of edits.slice(0, count)) {
      assert.equal(await proofreadDocument(runtime.workspace.current!).preview.contents.executeJavaScript(
        'document.querySelector(' + JSON.stringify(selector) + ').textContent'), value);
    }
    if (observation !== 'committed-matches') await save();
  }
  assert.deepEqual(await readFile(join(project, 'keep.css')), Buffer.from(css));
  receipt({ event: 'checked', kind: mode, observation, result: status().result,
    htmlHash: hash(await readFile(entry)), changes: state().current!.input.changes.length,
    undoCount: state().current!.input.history!.undoCount, chooseCalls, reviewCalls });
  close();
}
void run().catch((error: unknown) => {
  receipt({ event: 'failed', error: String(error), stack: error instanceof Error ? error.stack : null,
    workspace: product?.runtime.workspace.snapshot(), interruption: snapshotStatus?.() });
  app.exit(1);
});
