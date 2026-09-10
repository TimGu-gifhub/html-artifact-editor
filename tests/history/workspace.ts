import { proofreadSnapshot, proofreadDocument } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
import { prepareCompactionRecovery } from '../../src/main/storage/compaction-recovery.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';

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
  const control = { saveStep: async (_step: string): Promise<void> => {}, draftStep: async (_step: string): Promise<void> => {} };
  const connect = async (recoveryId?: string) => {
    const uiSession = session.fromPartition(`history-ui-${randomUUID()}`, { cache: false });
    await registerBundledContent(uiSession, 'editor', 'app', assets);
    const ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: {
      ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs'),
    } }); lockContents(ui.webContents);
    const saves = await createSavePreparationStore(privateRoot, step => control.saveStep(step), process.platform === 'win32'
      ? await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')) : undefined);
    const checkpoints = await createDraftCheckpointStore(privateRoot, step => control.draftStep(step), saves);
    const errors: string[] = [];
    const runtime = createWorkspaceSession(ui, outputRoot, {
      chooseOpen: async () => entry, chooseCopy: async () => undefined,
      projectChoices: { chooseDirectory: async () => project, chooseEntry: async () => entry },
      review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }), reportError: code => errors.push(code),
      bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; }, checkpoints,
      ...(process.platform === 'win32' ? { saveOriginal: createOriginalSaver(saves) } : {}),
    });
    const call = (expression: string): Promise<WorkspaceResult> => ui.webContents.executeJavaScript(expression);
    const read = async () => { const result = await call('haeWorkspace.read()'); assert.ok(result.ok, result.code ?? 'read'); return proofreadSnapshot(result.state!); };
    const current = () => proofreadDocument(runtime.workspace.current!);
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

    const saved = await fixture(outputRoot, results); let restored = await saved.connect(); let priorId: string;
    try {
      await restored.select('h1'); await restored.apply(''); await restored.settle();
      priorId = restored.current().checkpointSessionId;
      // End the process-owned session after the production saver commits, before
      // Workspace can create a clean point. The next window uses production IPC.
      const result = await createOriginalSaver(restored.saves)(restored.current().saveSource, restored.current().draft.candidate, new AbortController().signal);
      assert.equal(result.status, 'committed'); const baseline = await readFile(saved.entry);
      await restored.close(); restored = await saved.connect(priorId);
      assert.equal(await restored.text(), ''); assert.equal(restored.current().draft.candidate.patches.length, 0);
      assert.notEqual(restored.current().checkpointSessionId, priorId); await restored.settle();
      assert.equal(restored.checkpoints.isSessionActive(priorId), true);
      const continuation = restored.current().checkpointSessionId;
      await restored.close(); await assert.rejects(saved.connect(priorId), /DRAFT_SAVED_HISTORY_SUPERSEDED/);
      restored = await saved.connect(continuation); assert.ok((await restored.move('undo')).ok);
      assert.equal(await restored.text(), 'A & 😀'); assert.deepEqual(await readFile(saved.entry), baseline);
      assert.equal((await restored.save()).outcome, 'saved'); await restored.settle();
      assert.deepEqual(await readFile(saved.entry), Buffer.from(original.toString().replace('A &#38; 😀', 'A &amp; 😀')));
      pass('production Workspace restore rebuilds committed history as a sealed clean continuation; the old saved entry cannot bypass it, Undo is unsaved until another explicit Windows Save');
    } finally { await restored.close(); }

    const failed = await fixture(outputRoot, results); const old = await failed.connect(); let failedId: string; let disk: Buffer;
    try {
      await old.select('h1'); await old.apply('B'); await old.settle(); failedId = old.current().checkpointSessionId;
      assert.equal((await createOriginalSaver(old.saves)(old.current().saveSource, old.current().draft.candidate, new AbortController().signal)).status, 'committed');
      disk = await readFile(failed.entry);
    } finally { await old.close(); }
    failed.control.draftStep = async step => { if (step === 'baseline-written') throw Error('test failed clean continuation'); };
    await assert.rejects(failed.connect(failedId), /DRAFT_PERSISTENCE_REQUIRED/);
    failed.control.draftStep = async () => {};
    await assert.rejects(failed.connect(failedId), /DRAFT_SAVED_HISTORY_SUPERSEDED/);
    const evidence = await createDraftCheckpointStore(failed.privateRoot);
    assert.equal(evidence.isSessionActive(failedId), false); assert.equal((await evidence.catalog()).groups.length, 2);
    assert.deepEqual(await readFile(failed.entry), disk);
    pass('a failed clean continuation prevents window installation, retains the committed HTML and incomplete evidence, releases confirmed teardown ownership and refuses fallback through the old saved entry');
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

  const continuous = await fixture(outputRoot, results); let editing = await continuous.connect();
  try {
    await editing.select('h1');
    for (let index = 0; index < 24; index++) {
      await editing.apply(`校稿 ${index} <&> 🧪`); await editing.settle();
      assert.equal((await readdir(continuous.privateRoot)).length, Math.min(index + 1, 2));
    }
    const id = editing.current().checkpointSessionId; assert.equal(editing.current().history!.summary().undoCount, 24);
    await editing.close(); editing = await continuous.connect(id);
    assert.equal(await editing.text(), '校稿 23 <&> 🧪'); assert.ok((await editing.move('undo')).ok); await editing.settle();
    assert.equal(await editing.text(), '校稿 22 <&> 🧪'); assert.equal(editing.current().history!.summary().redoCount, 1);
    assert.deepEqual(await readFile(continuous.entry), original); assert.deepEqual(await readFile(join(continuous.project, 'keep.css')), css);
    if (process.platform === 'win32') {
      assert.equal((await editing.save()).outcome, 'saved'); await editing.settle();
      assert.deepEqual(await readFile(continuous.entry), Buffer.from(original.toString().replace('A &#38; 😀', '校稿 22 &lt;&amp;&gt; 🧪')));
      assert.equal(editing.current().history!.summary().redoCount, 1);
    }
    pass('24 separately durable production Workspace Applies retain only two complete checkpoints, reopen with all Undo/Redo history, preserve HTML until explicit Save and keep external CSS unchanged');
  } finally { await editing.close(); }

  const interrupted = await fixture(outputRoot, results); const writing = await interrupted.connect();
  try {
    await writing.select('h1'); await writing.apply('B'); await writing.settle(); await writing.apply('C'); await writing.settle();
    interrupted.control.draftStep = async step => { if (step === 'compaction-after-origin.bin') throw Error('test interrupted obsolete point removal'); };
    await writing.apply('D'); const before = writing.current().input.snapshot(); const warning = await writing.settle();
    assert.equal(warning.cleanupPending, true); assert.equal(warning.code, 'DRAFT_COMPACTION_UNKNOWN'); assert.equal(warning.canRetry, false);
    assert.equal(writing.current().input.snapshot().stateRevision, before.stateRevision);
    const names = await readdir(interrupted.privateRoot); const persisted = warning.persisted;
    await writing.apply('E'); const stopped = await writing.current().persistence!.settle();
    assert.equal(stopped.status, 'failed'); assert.deepEqual(stopped.persisted, persisted);
    assert.equal(stopped.queuedRevision, writing.current().draft.revision); assert.deepEqual(await readdir(interrupted.privateRoot), names);
    assert.equal(await writing.text(), 'E'); assert.deepEqual(await readFile(interrupted.entry), original);
    if (process.platform === 'win32') assert.equal((await writing.save()).code, 'SAVE_LOCKED');
    await assert.rejects(prepareCompactionRecovery(interrupted.privateRoot, writing.current().saveSource), /DRAFT_STORAGE_ACTIVE/);
    assert.deepEqual(await readFile(interrupted.entry), original);
    pass('a compaction failure reports the exact persisted revision with a cleanup warning, does not invalidate current input, keeps later edits only in memory and stops automatic writes and native Save at the retained lock');
  } finally { await writing.close(); }

  const authorized = await openSaveSource(interrupted.entry, original); const beforeRecovery = await readdir(interrupted.privateRoot);
  assert.throws(() => prepareCompactionRecovery(interrupted.project, authorized), /DRAFT_PROFILE_ROOT_MISMATCH/);
  const review = await prepareCompactionRecovery(interrupted.privateRoot, authorized);
  assert.deepEqual(await readdir(interrupted.privateRoot), beforeRecovery); assert.equal(review.cancel(), true);
  assert.deepEqual(await readdir(interrupted.privateRoot), beforeRecovery);
  const staleProfile = await prepareCompactionRecovery(interrupted.privateRoot, authorized); const originalProfile = app.getPath('userData');
  try {
    app.setPath('userData', interrupted.root);
    assert.deepEqual(await staleProfile.commit(), { status: 'failed', code: 'DRAFT_PROFILE_IN_USE' });
  } finally { app.setPath('userData', originalProfile); staleProfile.cancel(); }
  assert.deepEqual(await readdir(interrupted.privateRoot), beforeRecovery);
  const resolution = await prepareCompactionRecovery(interrupted.privateRoot, authorized);
  assert.equal((await resolution.commit()).status, 'resolved');
  interrupted.control.draftStep = async () => {};
  const recovered = await interrupted.connect(resolution.summary.sessionId);
  try {
    assert.equal(await recovered.text(), 'D'); assert.equal(recovered.current().history!.summary().undoCount, 3);
    assert.ok((await recovered.move('undo')).ok); await recovered.settle(); assert.equal(await recovered.text(), 'C');
    assert.deepEqual(await readFile(interrupted.entry), original);
    if (process.platform === 'win32') {
      assert.equal((await recovered.save()).outcome, 'saved'); await recovered.settle();
      assert.deepEqual(await readFile(interrupted.entry), Buffer.from(original.toString().replace('A &#38; 😀', 'C')));
    }
    assert.deepEqual(await readFile(join(interrupted.project, 'keep.css')), css);
    assert.deepEqual(await recovered.ui.webContents.executeJavaScript('[typeof haeWorkspace.unlock,typeof haeWorkspace.prepareCompactionRecovery]'), ['undefined', 'undefined']);
    pass('explicit profile-bound Main compaction recovery refuses an active document or foreign root, cancels without writes, then permits production Workspace restore/Undo and explicit native Save while preserving the latest actually durable text');
  } finally { await recovered.close(); }

  const processRoot = await mkdtemp(join(results, 'history-restart-')); const profile = join(processRoot, 'profile');
  const privateRoot = join(profile, 'private'); await mkdir(privateRoot, { recursive: true });
  const entry = join(processRoot, 'report.html'); await writeFile(entry, original); await writeFile(join(processRoot, 'keep.css'), css);
  const start = (mode: string, sessionId?: string, location = { profile, entry, privateRoot }) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [join(outputRoot, 'history-child/index.cjs'), mode, location.profile, location.entry, location.privateRoot, ...(sessionId ? [sessionId] : [])],
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
  if (process.platform === 'win32') {
    const committing = start('seed-saved'); let oldId: string;
    try { const message = await committing.ready(); assert.equal(message.state, 'saved'); oldId = message.sessionId!; }
    finally { await committing.stop(); }
    const baseline = await readFile(entry); assert.deepEqual(baseline, Buffer.from(original.toString().replace('A &#38; 😀', '')));
    const resuming = start('restore-saved', oldId);
    try {
      const message = await resuming.ready(); assert.equal(message.state, 'saved-restored'); assert.notEqual(message.sessionId, oldId);
      assert.equal(message.revision, 7); assert.equal(message.undoCount, 1); assert.equal(message.redoCount, 1);
      assert.equal(await resuming.exited, 0);
    } finally { await resuming.stop(); }
    assert.deepEqual(await readFile(entry), baseline);
    pass('a separate Electron process killed after native commit but before a clean checkpoint can restart into a newly sealed history, install an empty Text, confirm Undo/Redo and preserve the already saved HTML bytes');
  }

  const resolutionRoot = await mkdtemp(join(results, 'compaction-restart-'));
  const location = { profile: join(resolutionRoot, 'profile'), privateRoot: join(resolutionRoot, 'profile/private'), entry: join(resolutionRoot, 'report.html') };
  await mkdir(location.privateRoot, { recursive: true }); await writeFile(location.entry, original); await writeFile(join(resolutionRoot, 'keep.css'), css);
  const interruptedProcess = start('seed-compaction', undefined, location); let retainedId: string;
  try {
    const message = await interruptedProcess.ready(); assert.equal(message.state, 'compaction-seeded'); retainedId = message.sessionId!;
    const competitor = start('probe-compaction', undefined, location);
    try { assert.equal((await competitor.ready()).state, 'blocked'); assert.equal(await competitor.exited, 0); }
    finally { await competitor.stop(); }
  } finally { await interruptedProcess.stop(); }
  const restarted = start('restore-compaction', retainedId, location);
  try {
    const message = await restarted.ready(); assert.equal(message.state, 'compaction-restored');
    assert.equal(message.undoCount, 3); assert.equal(message.redoCount, 0); assert.equal(await restarted.exited, 0);
  } finally { await restarted.stop(); }
  assert.deepEqual(await readFile(location.entry), original); assert.deepEqual(await readFile(join(resolutionRoot, 'keep.css')), css);
  pass('a live Electron profile blocks a competing compaction resolver; after actual process termination a new Main explicitly resolves the interrupted cleanup and restores/undoes/redoes the latest full history without writing HTML');
  if (process.platform === 'win32') for (const committed of [true, false]) {
    const root = await mkdtemp(join(results, 'save-lock-restart-'));
    const location = { profile: join(root, 'profile'), privateRoot: join(root, 'profile/private'), entry: join(root, 'report.html') };
    await mkdir(location.privateRoot, { recursive: true }); await writeFile(location.entry, original); await writeFile(join(root, 'keep.css'), css);
    const seed = start(committed ? 'seed-save-lock' : 'seed-unknown-save', undefined, location); let sessionId: string;
    try {
      const message = await seed.ready(); assert.equal(message.state, 'save-interrupted'); sessionId = message.sessionId!;
      const competitor = start('probe-save-lock', undefined, location);
      try { assert.equal((await competitor.ready()).state, 'save-profile-blocked'); assert.equal(await competitor.exited, 0); }
      finally { await competitor.stop(); }
    } finally { await seed.stop(); }
    const baseline = Buffer.from(original.toString().replace('A &#38; 😀', '')); assert.deepEqual(await readFile(location.entry), baseline);
    const resumed = start(committed ? 'restore-save-lock' : 'restore-unknown-save', sessionId, location);
    try {
      const message = await resumed.ready(); assert.equal(message.state, committed ? 'save-lock-restored' : 'unknown-save-retained');
      assert.equal(await resumed.exited, 0);
    } finally { await resumed.stop(); }
    assert.deepEqual(await readFile(location.entry), committed ? baseline : original); assert.deepEqual(await readFile(join(root, 'keep.css')), css);
    pass(committed
      ? 'an actual process killed with a verified committed Save and retained lock is explicitly resolved under its reacquired profile, then production recovery rebuilds the clean empty Text and confirms durable Undo without writing HTML'
      : 'candidate bytes without a committed journal stay unconfirmed after an explicit keep-current decision; production recovery refuses old history replay, and a separate native backup restoration first protects the accepted current bytes');
  }
}
