import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import { MAPPING_HISTORY_RESULT } from '../../src/contracts/mapping-history.ts';
import type { DocumentCommand, WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createWorkspaceSession } from '../../src/main/workspace/session.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createOriginalSaver } from '../../src/main/storage/original.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';

const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="keep.css"></head><body><h1>A &#38; 😀</h1><p>重复</p><p id="target">重复</p><!-- keep --><script>window.existing=41</script></body></html>');
const css = Buffer.from('body{font:24px sans-serif;padding:20px;color:rgb(12,34,56)}');
const version = (value: InputSnapshot) => ({ editToken: value.input!.editToken, inputRevision: value.input!.revision });
const until = async (check: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + 7000;
  while (!check()) { if (Date.now() > end) throw Error(`TIMEOUT: ${label}`); await delay(10); }
};
async function fixture(outputRoot: string, results: string) {
  const root = await mkdtemp(join(results, 'history-workspace-')); const project = join(root, 'project'); await mkdir(project);
  const entry = join(project, 'report.html'); await writeFile(entry, original); await writeFile(join(project, 'keep.css'), css);
  await mkdir(app.getPath('userData'), { recursive: true });
  const privateRoot = join(app.getPath('userData'), randomUUID()); await mkdir(privateRoot);
  const assets = join(root, 'bundled'); await mkdir(assets);
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>History transport fixture</title>');
  const control = { saveStep: async (_step: string): Promise<void> => {} };
  const connect = async (recoveryId?: string) => {
    const uiSession = session.fromPartition(`history-ui-${randomUUID()}`, { cache: false });
    await registerBundledContent(uiSession, 'editor', 'app', assets);
    const ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: {
      ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs'),
    } }); lockContents(ui.webContents);
    const saves = await createSavePreparationStore(privateRoot, step => control.saveStep(step), process.platform === 'win32'
      ? await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')) : undefined);
    const checkpoints = await createDraftCheckpointStore(privateRoot, undefined, saves);
    const errors: string[] = [];
    const runtime = createWorkspaceSession(ui, outputRoot, {
      chooseOpen: async () => entry, chooseCopy: async () => undefined,
      projectChoices: { chooseDirectory: async () => project, chooseEntry: async () => entry },
      review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }), reportError: code => errors.push(code),
      bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; }, checkpoints,
      ...(process.platform === 'win32' ? { saveOriginal: createOriginalSaver(saves) } : {}),
    });
    const call = (expression: string): Promise<WorkspaceResult> => ui.webContents.executeJavaScript(expression);
    const read = async () => { const result = await call('haeWorkspace.read()'); assert.ok(result.ok, result.code ?? 'read'); return result.state!; };
    const current = () => runtime.workspace.current!;
    const edit = (value: DocumentCommand, id = current().id) => call(`haeWorkspace.edit(${JSON.stringify(id)},${JSON.stringify(value)})`);
    const click = async (selector: string) => {
      const preview = current().preview;
      const point = await preview.contents.executeJavaScript(`(() => {const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const b=r.getBoundingClientRect();return{x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)}})()`);
      preview.contents.focus(); preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    };
    const select = async (selector: string) => {
      const input = current().input.snapshot();
      if (input.input) assert.ok((await edit({ kind: 'resolve', value: { ...version(input), decision: 'discard', intentSequence: input.intent?.sequence ?? null } })).ok);
      const before = current().mapping.selection; await click(selector);
      await until(() => !!current().mapping.selection && current().mapping.selection !== before, 'native selection');
      const state = (await read()).current!.input;
      assert.ok((await edit({ kind: 'begin', value: { selection: state.selection!.reference, draftRevision: state.draftRevision } })).ok);
    };
    const change = async (text: string, composing = false) => {
      const state = (await read()).current!.input;
      return edit({ kind: 'change', value: { ...version(state), inputRevision: state.input!.revision + 1, newText: text, composing } });
    };
    const apply = async (text: string) => {
      assert.ok((await change(text)).ok); const result = await edit({ kind: 'apply', value: version((await read()).current!.input) });
      assert.ok(result.ok, result.code ?? 'apply');
    };
    const move = async (direction: 'undo' | 'redo') => {
      const input = (await read()).current!.input;
      return edit({ kind: 'history', value: { stateRevision: input.stateRevision, draftRevision: input.draftRevision, direction } });
    };
    const save = async () => { const state = await read(); return call(`haeWorkspace.save(${JSON.stringify(state.current!.id)},${state.stateRevision})`); };
    const settle = async () => {
      const state = await current().persistence!.settle(); assert.equal(state.status, 'persisted', state.code ?? 'persistence');
      assert.equal(state.persisted!.draftRevision, current().draft.revision); return state;
    };
    const text = () => current().preview.contents.executeJavaScript('document.querySelector("h1").textContent') as Promise<string>;
    const close = async () => { await runtime.dispose(); if (!ui.isDestroyed()) ui.destroy(); };
    try {
      await ui.loadURL(EDITOR_URL); const state = await read();
      const result = await call(recoveryId ? `haeWorkspace.restore(${JSON.stringify(recoveryId)},${state.stateRevision},"directory")`
        : `haeWorkspace.openDirectory(${state.stateRevision})`);
      assert.ok(result.ok, result.code ?? 'open'); assert.equal(result.outcome, recoveryId ? 'restored' : 'opened'); ui.showInactive();
      return { ui, runtime, checkpoints, saves, call, read, current, edit, click, select, change, apply, move, save, settle, text, close, errors };
    } catch (error) { await close(); throw error; }
  };
  return { root, project, entry, privateRoot, control, connect };
}

export async function runHistoryWorkspace(outputRoot: string, results: string, pass: (value: string) => void) {
  const f = await fixture(outputRoot, results); let view = await f.connect();
  try {
    await view.select('h1'); await view.apply('B <&> 🧪'); await view.apply('C');
    assert.ok((await view.move('undo')).ok); assert.equal(await view.text(), 'B <&> 🧪'); assert.equal(view.current().draft.candidate.patches.length, 1);
    assert.equal(view.current().input.snapshot().input, null); assert.ok((await view.move('redo')).ok); assert.equal(await view.text(), 'C');
    assert.ok((await view.move('undo')).ok); const revision = view.current().draft.revision;
    await view.select('h1'); await view.apply('B <&> 🧪'); assert.equal(view.current().draft.revision, revision);
    assert.equal(view.current().input.snapshot().history!.redoCount, 1);
    await view.apply('D'); assert.equal(view.current().input.snapshot().history!.redoCount, 0);
    assert.ok((await view.move('undo')).ok); assert.equal(await view.text(), 'B <&> 🧪'); assert.ok((await view.move('redo')).ok);
    const state = (await view.read()).current!; const reviewed = await view.call(`haeWorkspace.readDiff(${JSON.stringify(state.id)},${state.input.draftRevision},${JSON.stringify(state.input.candidateHash)})`);
    assert.ok(reviewed.ok, reviewed.code ?? 'diff'); assert.equal(reviewed.diff!.candidateHash, state.input.candidateHash);
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);
    assert.deepEqual(Object.keys(state.input.history!).sort(), ['canRedo', 'canUndo', 'redoCount', 'undoCount']);
    assert.equal(/originBytes|savedValues|operations|targetKey/u.test(JSON.stringify(state.input)), false);
    pass('production Workspace IPC applies A→B→C, logical Undo/Redo, unchanged Apply and confirmed branching; source Diff uses the same frozen candidate and HTML remains unchanged');

    await view.select('h1'); await view.change('尚未应用', true);
    assert.equal((await view.move('undo')).code, 'INPUT_COMPOSING'); await view.change('尚未应用');
    assert.equal((await view.move('undo')).code, 'UNAPPLIED_INPUT'); assert.equal(await view.text(), 'D');
    const retained = view.current().history!.capture(); const stale = view.current().input.snapshot();
    await view.change('D'); assert.equal((await view.edit({ kind: 'history', value: { stateRevision: stale.stateRevision, draftRevision: stale.draftRevision, direction: 'undo' } })).code, 'STALE_INPUT_STATE');
    await view.click('#target'); await until(() => !!view.current().input.snapshot().intent, 'native pending edit intent');
    assert.equal((await view.move('undo')).code, 'STALE_EDIT_INTENT'); assert.equal(view.current().history!.capture(), retained);
    const pending = view.current().input.snapshot();
    assert.ok((await view.edit({ kind: 'resolve', value: { ...version(pending), decision: 'discard', intentSequence: pending.intent!.sequence } })).ok);
    const bad = await view.call(`haeWorkspace.edit(${JSON.stringify(view.current().id)},{kind:"history",value:{stateRevision:1,draftRevision:1,direction:"undo",nodeId:"n0"}})`);
    assert.equal(bad.ok, false); assert.equal((await view.edit({ kind: 'history', value: { stateRevision: 1, draftRevision: 1, direction: 'undo' } }, randomUUID())).code, 'STALE_DOCUMENT');
    pass('trusted history commands reject composing, unapplied input, stale input revisions, pending native selection intents, extra authority fields and foreign document identities');

    await view.settle(); const sessionId = view.current().checkpointSessionId; const oldId = view.current().id;
    await view.close(); view = await f.connect(sessionId);
    assert.notEqual(view.current().id, oldId); assert.equal(await view.text(), 'D'); assert.equal(view.current().history!.summary().undoCount, 2);
    assert.ok((await view.move('undo')).ok); assert.equal(await view.text(), 'B <&> 🧪'); await view.settle();
    assert.deepEqual(await readFile(f.entry), original);
    assert.deepEqual(await view.current().preview.contents.executeJavaScript('[typeof require,typeof haeWorkspace,typeof ipcRenderer,typeof existing]'), ['undefined', 'undefined', 'undefined', 'undefined']);
    pass('a closed window and reopened private store recover the latest complete operation chain under a new UI document identity; Undo remains available and Preview receives no privileged API');
  } finally { await view.close(); }

  if (process.platform === 'win32') {
    const g = await fixture(outputRoot, results); let w = await g.connect();
    try {
      await w.select('h1'); await w.apply(''); const empty = w.current().draft.candidate.bytes; await w.settle();
      assert.equal((await w.save()).outcome, 'saved'); await w.settle();
      assert.deepEqual(await readFile(g.entry), Buffer.from(empty)); assert.equal(w.current().draft.candidate.patches.length, 0);
      assert.equal(await w.current().preview.contents.executeJavaScript('document.querySelector("h1").childNodes.length'), 1);
      const sessionId = w.current().checkpointSessionId; const savedRevision = w.current().draft.revision;
      const group = (await w.checkpoints.catalog(w.current().saveSource.current)).groups.find(group => group.sessionId === sessionId)!;
      assert.equal(group.status, 'clean'); assert.equal(group.historyAvailable, true);
      await w.close(); w = await g.connect(sessionId); assert.equal(w.current().draft.revision, savedRevision);
      assert.equal(await w.text(), ''); assert.ok((await w.move('undo')).ok); assert.equal(await w.text(), 'A & 😀');
      assert.deepEqual(await readFile(g.entry), Buffer.from(empty)); assert.equal(w.current().draft.candidate.patches[0]!.expectedText, '');
      assert.equal((await w.save()).outcome, 'saved'); await w.settle();
      assert.equal(w.current().history!.summary().redoCount, 1); const restored = await readFile(g.entry);
      assert.deepEqual(restored, Buffer.from(original.toString().replace('A &#38; 😀', 'A &amp; 😀')));
      assert.ok((await w.move('redo')).ok); assert.equal(await w.text(), ''); assert.deepEqual(await readFile(g.entry), restored);
      await w.settle(); const dirtySession = w.current().checkpointSessionId; await w.close(); w = await g.connect(dirtySession);
      assert.equal(await w.text(), ''); assert.ok((await w.move('undo')).ok); assert.deepEqual(Buffer.from(w.current().draft.candidate.bytes), restored);
      pass('verified Windows Save retains a complete clean history checkpoint; window/store reopening restores a proven empty Text, Undo requires a second explicit Save, and Redo survives both savepoints and recovery');
    } finally { await w.close(); }
  }

  const lost = await fixture(outputRoot, results); const w = await lost.connect();
  try {
    await w.select('h1'); await w.apply('B'); await w.settle(); const document = w.current(); const history = document.history!.capture();
    const persisted = document.persistence!.snapshot().persisted;
    const callbacks = ipcMain.listeners(MAPPING_HISTORY_RESULT) as Array<Parameters<typeof ipcMain.on>[1]>;
    assert.equal(callbacks.length, 1); callbacks.forEach(callback => ipcMain.removeListener(MAPPING_HISTORY_RESULT, callback));
    try {
      const result = await w.move('undo'); assert.equal(result.code, 'DRAFT_OUTCOME_UNKNOWN');
      assert.equal(await w.text(), 'A & 😀'); assert.equal(document.draft.phase, 'uncertain'); assert.equal(document.history!.capture(), history);
      assert.equal(document.draft.uncertainHistory!.checkpoint.record.cursor, 0); assert.deepEqual(document.persistence!.snapshot().persisted, persisted);
      assert.equal((await w.move('undo')).ok, false); assert.deepEqual(await readFile(lost.entry), original);
    } finally { callbacks.forEach(callback => ipcMain.on(MAPPING_HISTORY_RESULT, callback)); }
    pass('an actual Preview Undo with its acknowledgement suppressed retains the old confirmed history and prepared candidate, blocks further editing, and never persists or automatically retries the uncertain transition');
  } finally { await w.close(); }

  const processRoot = await mkdtemp(join(results, 'history-restart-')); const profile = join(processRoot, 'profile');
  const privateRoot = join(profile, 'private'); await mkdir(privateRoot, { recursive: true });
  const entry = join(processRoot, 'report.html'); await writeFile(entry, original); await writeFile(join(processRoot, 'keep.css'), css);
  const start = (mode: string, sessionId?: string) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [join(outputRoot, 'history-child/index.cjs'), mode, profile, entry, privateRoot, ...(sessionId ? [sessionId] : [])],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; let diagnostic = ''; let message: { state: string; sessionId?: string; revision: number; undoCount?: number; redoCount?: number } | null = null;
    child.stdout.on('data', value => {
      text += String(value); const lines = text.split('\n'); text = lines.pop()!;
      for (const line of lines) { try { const value = JSON.parse(line); if (typeof value.state === 'string') message = value; } catch { /* Ignore runtime diagnostics. */ } }
    });
    child.stderr.on('data', value => { diagnostic = (diagnostic + String(value)).slice(-4096); });
    const exited = new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
    return { ready: async () => { await until(() => !!message, `history child ${mode}: ${diagnostic}`); return message!; }, exited,
      stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; } };
  };
  const seed = start('seed'); let sessionId: string;
  try { const message = await seed.ready(); assert.equal(message.state, 'seeded'); sessionId = message.sessionId!; }
  finally { await seed.stop(); }
  const restored = start('restore', sessionId);
  try {
    const message = await restored.ready(); assert.equal(message.state, 'restored'); assert.equal(message.revision, 5);
    assert.equal(message.undoCount, 2); assert.equal(message.redoCount, 0); assert.equal(await restored.exited, 0);
  } finally { await restored.stop(); }
  assert.deepEqual(await readFile(entry), original);
  pass('after a separate Electron process is forcibly terminated, a new process reacquires the profile and restores the sealed full history through prepareDocument, confirms Preview Redo and durably records it without writing HTML');
}
