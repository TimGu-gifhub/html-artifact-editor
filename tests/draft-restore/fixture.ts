import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import type { WorkspaceResult, DocumentCommand } from '../../src/contracts/workspace-editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';
import type { LeaveDecision, LeaveReview } from '../../src/contracts/workspace.ts';
import type { PreviewHostStep } from '../../src/platform/preview-host.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createOriginalSaver } from '../../src/main/storage/original.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { createWorkspaceSession } from '../../src/main/workspace/session.ts';
import { original, css, seedCheckpoint } from './seed.ts';

export async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6500;
  while (!check()) { if (Date.now() > deadline) throw Error(`TIMEOUT: ${label}`); await delay(10); }
}
export const version = (value: InputSnapshot) => ({ editToken: value.input!.editToken, inputRevision: value.input!.revision });
export async function fixture(outputRoot: string, results: string,
  seed: typeof seedCheckpoint = seedCheckpoint) {
  const root = await mkdtemp(join(results, 'recovery-window-')); const project = join(root, '项目 🧪');
  await mkdir(project); await mkdir(join(project, 'pages')); const entry = join(project, 'pages', '报告 😀.html');
  await writeFile(entry, original); await writeFile(join(project, 'keep.css'), css);
  const privateRoot = join(app.getPath('userData'), randomUUID()); await mkdir(privateRoot);
  const record = await seed(entry, privateRoot);
  const assets = join(root, 'bundled'); await mkdir(assets);
  // Blank trusted transport fixture. This is not product UI/design code.
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Recovery transport fixture</title>');
  const uiSession = session.fromPartition(`recovery-ui-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', assets);
  const ui = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: {
    ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs'),
  } }); lockContents(ui.webContents);
  const store = await createSavePreparationStore(privateRoot, undefined, process.platform === 'win32'
    ? await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')) : undefined);
  const checkpoints = await createDraftCheckpointStore(privateRoot, undefined, store);
  const control: { path: string | undefined; chooses: number; host: (step: PreviewHostStep) => void;
    review: (value: LeaveReview) => Promise<LeaveDecision> } = {
    path: entry, chooses: 0, host: () => {}, review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }),
  };
  const choose = async () => { control.chooses++; return control.path; };
  const errors: string[] = [];
  const runtime = createWorkspaceSession(ui, outputRoot, {
    chooseOpen: choose, chooseCopy: async () => undefined,
    projectChoices: { chooseDirectory: async () => project, chooseEntry: choose },
    review: value => control.review(value), reportError: code => errors.push(code),
    bounds: () => { const { width, height } = ui.getContentBounds(); return { x: 0, y: 0, width, height }; },
    onHostStep: step => control.host(step), checkpoints,
    ...(process.platform === 'win32' ? { saveOriginal: createOriginalSaver(store) } : {}),
  });
  const call = (expression: string): Promise<WorkspaceResult> => ui.webContents.executeJavaScript(expression);
  const read = async () => { const value = await call('haeWorkspace.read()'); assert.equal(value.ok, true); return value.state!; };
  const current = () => runtime.workspace.current!;
  const restore = async (mode: 'file' | 'directory' = 'directory') => call(`haeWorkspace.restore(${JSON.stringify(record.sessionId)},${(await read()).stateRevision},${JSON.stringify(mode)})`);
  const open = async () => call(`haeWorkspace.open(${(await read()).stateRevision})`);
  const edit = (id: string, value: DocumentCommand) => call(`haeWorkspace.edit(${JSON.stringify(id)},${JSON.stringify(value)})`);
  const select = async (selector: string) => {
    const value = current(); const input = value.input.snapshot();
    if (input.input) assert.equal((await edit(value.id, { kind: 'resolve', value: { ...version(input), decision: 'discard', intentSequence: input.intent?.sequence ?? null } })).ok, true);
    const previous = value.mapping.selection;
    const point = await value.preview.contents.executeJavaScript(`(() => {const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const b=r.getBoundingClientRect();return{x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)}})()`);
    value.preview.contents.focus();
    value.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    value.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => value.mapping.selection !== null && value.mapping.selection !== previous, 'restored native Text selection');
    const state = (await read()).current!.input;
    assert.equal((await edit(value.id, { kind: 'begin', value: { selection: state.selection!.reference, draftRevision: state.draftRevision } })).ok, true);
  };
  const change = async (text: string) => {
    const value = (await read()).current!;
    return edit(value.id, { kind: 'change', value: { ...version(value.input), inputRevision: value.input.input!.revision + 1, newText: text, composing: false } });
  };
  const apply = async () => {
    const value = (await read()).current!; const result = await edit(value.id, { kind: 'apply', value: version(value.input) });
    assert.equal(result.ok, true, result.code ?? 'apply failed'); await current().persistence!.settle();
  };
  const unchanged = async () => { assert.deepEqual(await readFile(entry), original); assert.deepEqual(await readFile(join(project, 'keep.css')), css); };
  const close = async () => { await runtime.dispose(); if (!ui.isDestroyed()) ui.destroy(); };
  try {
    await ui.loadURL(EDITOR_URL); await read(); ui.showInactive();
    return { root, project, entry, privateRoot, record, store, checkpoints, ui, control, runtime, errors, call, read, current, restore, open, edit, select, change, apply, unchanged, close };
  } catch (error) { await close(); throw error; }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
