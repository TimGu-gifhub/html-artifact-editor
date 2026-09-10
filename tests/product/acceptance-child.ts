import { proofreadSnapshot, proofreadDocument } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { captureReady } from '../helpers/capture.ts';
import { edits, source, css } from './acceptance-fixture.ts';

const [mode, profile, projectArg, requestedSession, projectLayout] = process.argv.slice(2);
if (!profile || !projectArg || !['seed', 'restore-save', 'saved-backup', 'conflict', 'file-limited'].includes(mode ?? '')
  || (projectLayout !== undefined && !['file', 'directory'].includes(projectLayout))) throw Error('Invalid acceptance arguments');
const project = projectArg;
const directoryProject = projectLayout === 'directory';
const documentSource = directoryProject ? source.replace('href="keep.css"', 'href="../assets/keep.css"') : source;
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
const outputRoot = resolve(__dirname, '..');
const entry = join(project, directoryProject ? 'pages/报告.html' : '报告.html');
const cssPath = join(project, directoryProject ? 'assets/keep.css' : 'keep.css');
const receipt = (value: unknown) => process.stdout.write('HAE_ACCEPTANCE:' + JSON.stringify(value) + '\n');
let chooseMode: 'file' | 'cancel' | 'wrong' = 'file';
let choices = 0;
let directoryChoice: 'normal' | 'root-cancel' | 'entry-cancel' | 'wrong-root' | 'outside' | 'wrong-file' = 'normal';
let rootCalls = 0, entryCalls = 0;
let rootGate: Promise<string | undefined> | null = null;
let leave: 'cancel' | 'discard' = 'cancel';
let backupDecision: 'cancel' | 'restore' = 'cancel';
let backupCalls = 0;
let runtime: Awaited<ReturnType<typeof createProductApplication>> | undefined;

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('TIMEOUT: ' + label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label = ''): Promise<void> {
  const hit: { point: { x: number; y: number } | null } = { point: null };
  await until(async () => { hit.point = await window.webContents.executeJavaScript('(() => {const el=[...document.querySelectorAll(' + JSON.stringify(selector)
    + ')].find(x=>x.getBoundingClientRect().width>0&&!x.disabled&&x.textContent.includes(' + JSON.stringify(label)
    + '));if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
    return hit.point !== null;
  }, 'enabled product control ' + selector + ' ' + label);
  assert.ok(hit.point, 'missing enabled product control ' + selector + ' ' + label);
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
async function run(): Promise<void> {
  await app.whenReady();
  const product = runtime = await createProductApplication(outputRoot, { visible: false, choices: {
    open: async () => { choices++; return chooseMode === 'cancel' ? undefined : chooseMode === 'wrong' ? join(dirname(entry), 'wrong.html') : entry; },
    project: {
      chooseDirectory: async () => {
        rootCalls++;
        return rootGate ?? (directoryChoice === 'root-cancel' ? undefined : directoryChoice === 'wrong-root' ? join(project, 'assets') : project);
      },
      chooseEntry: async directory => {
        entryCalls++;
        assert.equal(directory, directoryChoice === 'wrong-root' ? join(project, 'assets') : project);
        return directoryChoice === 'entry-cancel' ? undefined : directoryChoice === 'outside' ? join(project, '../outside.html')
          : directoryChoice === 'wrong-file' ? join(dirname(entry), 'wrong.html') : entry;
      },
    },
    copy: async () => join(project, '冲突草稿.html'),
    review: async value => ({ reviewId: value.reviewId, decision: leave }),
    backup: async value => { backupCalls++; return { reviewId: value.reviewId, decision: backupDecision }; },
  } });
  const { window, runtime: session, desktop } = product;
  // Visible, unfocused test windows keep Chromium frames current for capture.
  window.showInactive();
  const state = () => proofreadSnapshot(session.workspace.snapshot());
  const ui = (script: string) => window.webContents.executeJavaScript(script);
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await until(() => ui('[...document.querySelectorAll("button")].some(x=>x.textContent.includes("打开 HTML"))'), 'product UI ready');
  const settled = async (): Promise<void> => {
    await until(() => {
      const value = state().current;
      return !!value && state().phase === 'idle' && !value.input.hasUnappliedInput && !value.input.input?.composing
        && value.persistence?.status === 'persisted' && !value.persistence.cleanupPending
        && value.persistence.persisted?.draftRevision === value.input.draftRevision
        && value.persistence.persisted.resultHash === value.input.candidateHash;
    }, 'latest confirmed product draft is durable', 30000);
  };
  const edit = async (selector: string, value: string): Promise<void> => {
    await until(() => session.host.current!.getBounds().width > 0, 'native Preview visible');
    const preview = proofreadDocument(session.workspace.current!).preview.contents;
    const before = await preview.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').textContent');
    await select(preview, selector);
    await until(async () => state().current?.input.input?.appliedText === before
      && await ui('!!document.querySelector("textarea.draft-input:not(:disabled)")'), 'selected Text editing binding');
    await ui('(()=>{const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
    window.webContents.focus(); await window.webContents.insertText(value);
    await until(() => state().current?.input.input?.appliedText === value && !state().current?.input.hasUnappliedInput, 'live text update');
    await settled();
    assert.equal(await preview.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').textContent'), value);
  };
  const openMenu = async (label: string): Promise<void> => {
    await click(window, '.toolbar button[aria-label="更多操作"]');
    await click(window, '[role=menuitem]', label);
  };
  const openRecovery = async (id: string): Promise<string> => {
    await openMenu('恢复草稿记录');
    await until(() => ui('!!document.querySelector("[role=dialog] .record-item")'), 'actual recovery catalog');
    const catalog = await session.workspace.listRecovery();
    assert.equal(catalog.locked, false); assert.equal(catalog.reviewRequired, false);
    const index = catalog.entries.findIndex(value => value.sessionId === id);
    assert.ok(index >= 0, 'expected durable session in catalog');
    assert.equal(catalog.entries[index]!.active, false);
    const selector = '[role=dialog] .record-list > .record-item:nth-child(' + (index + 1) + ') button';
    return selector;
  };
  const recoveryMode = () => ui('[...document.querySelectorAll("[role=dialog] input[name=recovery-source]")].find(x=>x.checked)?.closest("label")?.textContent.trim()');
  const chooseDirectoryMode = async (): Promise<void> => {
    await ui('document.querySelector("[role=dialog] input[name=recovery-source]").focus()');
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await until(async () => await recoveryMode() === '项目目录', 'keyboard directory source choice');
  };
  const directoryRecoveryChoices = async (id: string, initialButton: string): Promise<string> => {
    assert.equal(await recoveryMode(), 'HTML 文件', 'a new recovery dialog defaults to the file grant');
    await chooseDirectoryMode();
    await click(window, '[role=dialog] .dlg-close');
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'recovery dialog closed');
    const button = await openRecovery(id);
    assert.equal(await recoveryMode(), 'HTML 文件', 'reopening resets an unaccepted source choice');
    assert.equal(button, initialButton);
    window.setSize(960, 640);
    await chooseDirectoryMode();
    assert.equal(await ui('(()=>{const d=document.querySelector("[role=dialog]").getBoundingClientRect();return d.left>=0&&d.top>=0&&d.right<=innerWidth&&d.bottom<=innerHeight;})()'), true);
    await writeFile(join(project, '../directory-recovery-chooser.png'), await captureReady(window.webContents));
    for (const selection of ['root-cancel', 'entry-cancel', 'wrong-root', 'outside', 'wrong-file'] as const) {
      directoryChoice = selection; const oldRoots = rootCalls, oldEntries = entryCalls;
      await click(window, button, '恢复');
      await until(async () => rootCalls === oldRoots + 1 && state().phase === 'idle'
        && await ui('document.querySelector(' + JSON.stringify(button) + ')?.disabled === false'), 'directory reauthorization ' + selection);
      assert.equal(entryCalls, oldEntries + (selection === 'root-cancel' ? 0 : 1));
      assert.equal(choices, 0, 'directory cancellation/failure never falls back to a file chooser');
      assert.equal(state().current, null);
      assert.equal(await recoveryMode(), '项目目录', 'selection survives cancellation/failure');
      assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
      assert.deepEqual(await readFile(cssPath), Buffer.from(css));
      assert.deepEqual(await readFile(join(project, 'pages/wrong.html')), Buffer.from(documentSource));
      assert.deepEqual(await readFile(join(project, '../outside.html')), Buffer.from(documentSource));
      assert.equal(await ui('!!document.querySelector("[role=dialog] [role=alert]")'), !selection.endsWith('cancel'));
      assert.equal((await session.workspace.listRecovery()).entries.find(row => row.sessionId === id)?.active, false);
    }
    let releaseRoot!: (value: string | undefined) => void;
    rootGate = new Promise(done => { releaseRoot = done; });
    const oldRoots = rootCalls, oldEntries = entryCalls, oldFiles = choices;
    // One JS turn deliberately competes before React can paint disabled controls.
    await ui('(()=>{const b=document.querySelector(' + JSON.stringify(button) + ');b.click();b.click();'
      + 'document.querySelector("[role=dialog] .dlg-close").click();'
      + 'document.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
      + 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"o",ctrlKey:true,bubbles:true}));})()');
    await until(async () => rootCalls === oldRoots + 1 && await ui('!!document.querySelector("[role=dialog] .dlg-close:disabled")'), 'single accepted chooser and locked recovery dialog');
    assert.equal(await ui('[...document.querySelectorAll("[role=dialog] input,[role=dialog] button")].every(e=>e.disabled)'), true);
    await ui('document.querySelector(".scrim").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await delay(100);
    assert.equal(rootCalls, oldRoots + 1); assert.equal(entryCalls, oldEntries); assert.equal(choices, oldFiles);
    assert.equal(await recoveryMode(), '项目目录'); assert.equal(state().current, null);
    rootGate = null; releaseRoot(undefined);
    await until(async () => state().phase === 'idle' && await ui('document.querySelector(' + JSON.stringify(button) + ')?.disabled === false'), 'cancelled chooser releases UI latch');
    assert.equal(await ui('!!document.querySelector("[role=dialog] [role=alert]")'), false);
    assert.equal(await recoveryMode(), '项目目录');
    assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
    directoryChoice = 'normal';
    window.setSize(1440, 900);
    return button;
  };
  const review = async (): Promise<void> => {
    const count = state().current!.input.changes.length;
    if (desktop.extension(window.webContents).snapshot().reviewed.length !== count) {
      await click(window, '.check-all input');
      await until(() => desktop.extension(window.webContents).snapshot().reviewed.length === count, 'all visible changes reviewed');
    }
    await click(window, '.toolbar button', '复核并保存');
    await until(async () => await ui('document.querySelectorAll("[role=dialog] .diff-list .ci-diff").length === ' + count)
      && session.host.current!.getBounds().width === 0, 'frozen source Diff and native layout');
  };
  const save = async (): Promise<void> => {
    await review(); await click(window, '[role=dialog] button.primary', '确认保存');
    await until(() => state().lastSave?.status === 'saved' && state().phase === 'idle', 'verified Windows Save', 30000);
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'product acknowledges Save');
    await settled();
    assert.equal(state().current!.input.changes.length, 0);
  };
  if (mode === 'seed' || mode === 'conflict') {
    await click(window, 'button', directoryProject ? '打开目录' : '打开 HTML');
    await until(() => state().current?.input.mappingStatus === 'ready' && session.host.current!.getBounds().width > 0, 'original product document');
    if (directoryProject) {
      assert.equal(proofreadDocument(session.workspace.current!).preview.grant.root, project);
      assert.equal(state().current!.project.entry, 'pages/报告.html');
      assert.equal(await proofreadDocument(session.workspace.current!).preview.contents.executeJavaScript('getComputedStyle(document.querySelector("h1")).color'), 'rgb(12, 34, 56)');
    }
    for (const [selector, value] of mode === 'seed' ? edits : edits.slice(0, 1)) await edit(selector, value);
    assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
    assert.deepEqual(await readFile(cssPath), Buffer.from(css));
    assert.equal(await proofreadDocument(session.workspace.current!).preview.contents.executeJavaScript('document.documentElement.dataset.scriptRan'), undefined);
    assert.deepEqual(await proofreadDocument(session.workspace.current!).preview.contents.executeJavaScript('({require:typeof require,workspace:typeof haeWorkspace})'), {require:'undefined',workspace:'undefined'});
    if (mode === 'seed') {
      assert.equal(state().current!.input.changes.length, 5);
      assert.equal((await session.workspace.listRecovery()).locked, false);
      receipt({ event: 'seeded', sessionId: proofreadDocument(session.workspace.current!).checkpointSessionId, revision: state().current!.input.draftRevision,
        candidateHash: state().current!.input.candidateHash, history: state().current!.input.history, pid: process.pid });
      await new Promise<void>(() => {}); throw Error('Seed must be terminated by the parent after durability proof');
    }
    receipt({ event: 'await-conflict', pid: process.pid });
    await until(async () => !Buffer.from(documentSource).equals(await readFile(entry)), 'external parent process mutation');
    const externalBytes = await readFile(entry);
    assert.notDeepEqual(externalBytes, Buffer.from(documentSource));
    await review(); await click(window, '[role=dialog] button.primary', '确认保存');
    await until(() => state().lastSave?.status === 'failed' && state().phase === 'idle', 'conflict refuses native commit');
    await until(() => ui('!!document.querySelector("[role=dialog] [role=alert]")'), 'visible Save failure');
    assert.deepEqual(await readFile(entry), externalBytes);
    assert.equal(state().current!.input.changes.length, 1);
    assert.equal(state().current!.input.input?.appliedText, edits[0][1]);
    await click(window, '[role=dialog] .dlg-actions button', '另存草稿');
    await until(() => state().current?.input.lastCopy?.status === 'created', 'product preserves draft as an exclusive copy');
    assert.deepEqual(await readFile(entry), externalBytes);
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'copy action returns to the retained draft');
    receipt({ event: 'conflict-copied', code: state().lastSave?.code, changes: state().current!.input.changes.length });
    leave = 'discard';
  } else {
    assert.ok(requestedSession);
    let restoreButton = await openRecovery(requestedSession);
    if (mode === 'restore-save' && directoryProject) {
      restoreButton = await directoryRecoveryChoices(requestedSession, restoreButton);
    } else if (mode === 'restore-save') {
      for (const selection of ['cancel', 'wrong'] as const) {
        chooseMode = selection; const oldChoices = choices;
        await click(window, restoreButton, '恢复');
        await until(async () => choices === oldChoices + 1 && state().phase === 'idle'
          && await ui('document.querySelector(' + JSON.stringify(restoreButton) + ')?.disabled === false'), 'reauthorization ' + selection);
        assert.equal(state().current, null);
        assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
        if (selection === 'wrong') assert.equal(await ui('!!document.querySelector("[role=dialog] [role=alert]")'), true);
      }
    }
    chooseMode = 'file'; await click(window, restoreButton, '恢复');
    await until(() => state().current?.input.mappingStatus === 'ready', 'fresh recovered product document');
    await until(() => ui('!document.querySelector("[role=dialog]")'), 'recovery UI acknowledgement');
    await settled();
    if (mode === 'file-limited') {
      assert.equal(directoryProject, true);
      const current = proofreadDocument(session.workspace.current!);
      assert.equal(current.preview.grant.root, dirname(entry));
      assert.equal(current.checkpointSessionId, requestedSession);
      assert.equal(state().current!.project.entry, '报告.html');
      assert.equal(state().current!.input.changes.length, 5);
      const parentResourceLoaded = await current.preview.contents.executeJavaScript('getComputedStyle(document.querySelector("h1")).color === "rgb(12, 34, 56)"');
      assert.equal(parentResourceLoaded, false);
      await until(() => state().current!.project.resources.items.some(row => row.target.endsWith('assets/keep.css')), 'resource outside the file grant remains unavailable');
      assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
      assert.deepEqual(await readFile(cssPath), Buffer.from(css));
      assert.deepEqual(errors, []);
      receipt({ event: 'file-limited', parentResourceLoaded, sessionId: current.checkpointSessionId,
        changes: state().current!.input.changes.length, diagnostics: state().current!.project.resources.items });
      await new Promise<void>(() => {}); throw Error('Limited grant process must be terminated by the parent');
    }
    if (mode === 'restore-save') {
      assert.equal(proofreadDocument(session.workspace.current!).checkpointSessionId, requestedSession);
      assert.equal(state().current!.input.changes.length, 5);
      assert.notEqual(state().current!.id, requestedSession);
      for (const [selector, value] of edits) assert.equal(await proofreadDocument(session.workspace.current!).preview.contents.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').textContent'), value);
      assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
      if (directoryProject) {
        assert.equal(proofreadDocument(session.workspace.current!).preview.grant.root, project);
        assert.equal(state().current!.project.entry, 'pages/报告.html');
        const parentResourceLoaded = await proofreadDocument(session.workspace.current!).preview.contents.executeJavaScript('getComputedStyle(document.querySelector("h1")).color === "rgb(12, 34, 56)"');
        assert.equal(parentResourceLoaded, true);
        assert.equal(state().current!.input.history!.undoCount, 5);
        receipt({ event: 'directory-reauthorized', rootChoices: rootCalls, entryChoices: entryCalls, fileChoices: choices,
          projectEntry: state().current!.project.entry, parentResourceLoaded });
      }
      await until(() => ui('document.querySelector(".doc-name")?.textContent === "报告.html" && document.querySelectorAll(".changes-list .change-item").length === 5'), 'five restored changes rendered in the product UI');
      await delay(200); // Allow Chromium to composite the acknowledged React state.
      await writeFile(join(project, '../acceptance-recovered-ui.png'), await captureReady(window.webContents));
      await writeFile(join(project, '../acceptance-recovered-preview.png'), await captureReady(proofreadDocument(session.workspace.current!).preview.contents));
      await review(); await click(window, '[role=dialog] .dlg-actions button', '取消');
      await until(() => ui('!document.querySelector("[role=dialog]")'), 'cancel Diff preserves restored draft');
      assert.equal(state().current!.input.changes.length, 5); assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
      await save();
      receipt({ event: 'saved', sessionId: proofreadDocument(session.workspace.current!).checkpointSessionId,
        revision: state().current!.input.draftRevision, history: state().current!.input.history });
    } else {
      const saved = await readFile(entry);
      assert.equal(state().current!.input.changes.length, 0);
      assert.ok(state().current!.input.history!.canUndo);
      await click(window, '.toolbar button[aria-label^="撤销"]');
      await until(() => state().current!.input.changes.length === 1, 'restored saved history Undo');
      assert.deepEqual(await readFile(entry), saved); await settled();
      await save();
      const undoSaved = Buffer.from(saved.toString('utf8').replace(edits[4][1], '原摘要'));
      assert.deepEqual(await readFile(entry), undoSaved);
      receipt({ event: 'undo-saved', hash: createHash('sha256').update(await readFile(entry)).digest('hex') });
      await click(window, '.toolbar button[aria-label^="重做"]');
      await until(() => state().current!.input.changes.length === 1, 'Redo remains available across the second Save');
      assert.deepEqual(await readFile(entry), undoSaved); await settled();
      await click(window, '.toolbar button[aria-label^="撤销"]');
      await until(() => state().current!.input.changes.length === 0, 'Undo returns to the second savepoint');
      assert.deepEqual(await readFile(entry), undoSaved); await settled();
      await openMenu('备份与恢复');
      await until(() => ui('document.querySelectorAll("[role=dialog] .record-item").length === 2'), 'both native saves have visible backups');
      const backups = await session.workspace.listBackups(state().current!.id);
      const originalHash = createHash('sha256').update(Buffer.from(documentSource)).digest('hex');
      const originalIndex = backups.entries.findIndex(value => value.hash === originalHash);
      assert.ok(originalIndex >= 0);
      const backupButton = '[role=dialog] .record-list > .record-item:nth-child(' + (originalIndex + 1) + ') button';
      await click(window, backupButton, '恢复此备份');
      await until(async () => backupCalls === 1 && state().phase === 'idle'
        && await ui('document.querySelector(' + JSON.stringify(backupButton) + ')?.disabled === false'), 'separate backup confirmation cancel');
      assert.deepEqual(await readFile(entry), undoSaved);
      backupDecision = 'restore';
      await click(window, backupButton, '恢复此备份');
      await until(() => { const last = state().lastSave; return last?.status === 'backup-restored' && last.operation === 'backup-restore' && state().phase === 'idle'; }, 'confirmed whole-backup restoration', 30000);
      await until(() => ui('!document.querySelector("[role=dialog]")'), 'backup restoration UI acknowledgement');
      assert.equal(backupCalls, 2);
      assert.deepEqual(await readFile(entry), Buffer.from(documentSource));
      assert.equal(state().current!.input.history!.canUndo, false);
      assert.equal(state().current!.input.changes.length, 0);
      receipt({ event: 'backup-restored', changes: 0 });
    }
  }
  assert.deepEqual(await readFile(cssPath), Buffer.from(css));
  assert.deepEqual(errors, []);
  receipt({ event: 'closing', versions: process.versions });
  window.close();
  // The actual application quit coordinator must finish; parent verifies exit 0.
}
void run().catch(async (error: unknown) => {
  receipt({ event: 'failed', error: String(error), stack: error instanceof Error ? error.stack : null,
    state: runtime?.runtime.workspace.snapshot() ?? null });
  process.exitCode = 1; app.exit(1);
});
