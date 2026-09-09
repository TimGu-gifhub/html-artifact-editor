import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, session } from 'electron';
import { EDITOR_URL } from '../../src/contracts/editor.ts';
import type { DocumentCommand, WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import type { InputSnapshot } from '../../src/contracts/input.ts';
import { registerBundledContent } from '../../src/main/bundled-content.ts';
import { lockContents, securePreferences } from '../../src/main/preview/security.ts';
import { createPersistentWorkspaceSession } from '../../src/main/workspace/persistent-session.ts';
import type { PersistentSessionPorts } from '../../src/main/workspace/persistent-session.ts';

export const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="keep.css"><title>自制校稿报告</title></head><body>'
  + '<h1>2025 年度报告 &amp; 😀</h1><p id="date">2025-01-01</p><table><tbody><tr><td id="one">一</td><td id="two">二</td><td id="three">三</td></tr></tbody></table><!-- 原样 --></body></html>\r\n');
export const corrected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '2026 年度报告 🧪').replace('2025-01-01', '2026-09-10')
  .replace('id="one">一', 'id="one">一 &lt;&amp;&gt;').replace('id="two">二', 'id="two">二 😀').replace('id="three">三', 'id="three">三 已核对'));
export const css = Buffer.from('body{font:24px sans-serif;padding:20px;color:rgb(12,34,56)}td{padding:12px}');
export const version = (state: InputSnapshot) => ({ editToken: state.input!.editToken, inputRevision: state.input!.revision });
export async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw Error(`TIMEOUT: ${label}`); await delay(10); }
}
export function barrier() { let release!: () => void; const wait = new Promise<void>(done => { release = done; }); return { wait, release }; }
export async function project(results: string) {
  const root = await mkdtemp(join(results, 'startup-project-')); const entry = join(root, '报告 😀.html');
  await writeFile(entry, original); await writeFile(join(root, 'keep.css'), css); return { root, entry };
}
export async function editorWindow(outputRoot: string, root: string) {
  const assets = join(root, `bundled-${randomUUID()}`); await mkdir(assets);
  // Inert transport fixture; the product visual target and UI are unchanged.
  await writeFile(join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Persistent startup transport test</title>');
  const uiSession = session.fromPartition(`startup-ui-${randomUUID()}`, { cache: false });
  await registerBundledContent(uiSession, 'editor', 'app', assets);
  const window = new BrowserWindow({ show: false, width: 960, height: 640,
    webPreferences: { ...securePreferences, session: uiSession, preload: join(outputRoot, 'preload/ui/index.cjs') } });
  lockContents(window.webContents); return window;
}
export function ports(window: BrowserWindow, root: string, entry: string, overrides: Partial<PersistentSessionPorts> = {}): PersistentSessionPorts {
  return { chooseOpen: async () => entry, chooseCopy: async () => undefined,
    projectChoices: { chooseDirectory: async () => root, chooseEntry: async () => entry },
    review: async value => ({ reviewId: value.reviewId, decision: 'cancel' }),
    reviewBackup: async value => ({ reviewId: value.reviewId, decision: 'restore' }), reportError: () => {},
    bounds: () => { const { width, height } = window.getContentBounds(); return { x: 0, y: 0, width, height }; }, ...overrides };
}
export async function fixture(outputRoot: string, root: string, entry: string, overrides: Partial<PersistentSessionPorts> = {}) {
  const window = await editorWindow(outputRoot, root);
  const runtime = await createPersistentWorkspaceSession(window, outputRoot, ports(window, root, entry, overrides));
  try {
    await window.loadURL(EDITOR_URL);
    const call = (expression: string): Promise<WorkspaceResult> => window.webContents.executeJavaScript(expression);
    const read = async () => { const r = await call('haeWorkspace.read()'); assert.ok(r.ok, r.code ?? 'read failed'); return r.state!; };
    const current = () => runtime.workspace.current!;
    const edit = (command: DocumentCommand) => call(`haeWorkspace.edit(${JSON.stringify(current().id)},${JSON.stringify(command)})`);
    const change = async (text: string, composing = false) => {
      const state = (await read()).current!.input;
      return edit({ kind: 'change', value: { ...version(state), inputRevision: state.input!.revision + 1, newText: text, composing } });
    };
    const apply = async () => { const r = await edit({ kind: 'apply', value: version((await read()).current!.input) }); assert.ok(r.ok, r.code ?? 'apply failed'); };
    const select = async (selector: string) => {
      const value = current(); const input = value.input.snapshot();
      if (input.input) assert.ok((await edit({ kind: 'resolve', value: { ...version(input), decision: 'discard', intentSequence: input.intent?.sequence ?? null } })).ok);
      const previous = value.mapping.selection;
      const point = await value.preview.contents.executeJavaScript(`(() => { const range=document.createRange();range.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const r=range.getBoundingClientRect();return {x:Math.round(r.x+5),y:Math.round(r.y+r.height/2)}; })()`);
      value.preview.contents.focus(); value.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      value.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await until(() => value.mapping.selection !== null && value.mapping.selection !== previous, 'native selection');
      const state = (await read()).current!.input;
      assert.ok((await edit({ kind: 'begin', value: { selection: state.selection!.reference, draftRevision: state.draftRevision } })).ok);
    };
    const save = async () => {
      const state = await read(); return call(`haeWorkspace.save(${JSON.stringify(state.current!.id)},${state.stateRevision})`);
    };
    const open = async () => {
      const state = await read(); const result = await call(`haeWorkspace.openDirectory(${state.stateRevision})`);
      assert.equal(result.outcome, 'opened', result.code ?? 'open failed'); window.showInactive();
    };
    const restore = async (sessionId: string) => {
      const result = await call(`haeWorkspace.restore(${JSON.stringify(sessionId)},${(await read()).stateRevision},'directory')`);
      assert.equal(result.outcome, 'restored', result.code ?? 'recovery failed'); window.showInactive();
    };
    const close = async () => { try { await runtime.dispose(); } finally { if (!window.isDestroyed()) window.destroy(); } };
    const unchanged = async () => { assert.deepEqual(await readFile(entry), original); assert.deepEqual(await readFile(join(root, 'keep.css')), css); };
    return { window, runtime, root, entry, call, read, current, edit, change, apply, select, save, open, restore, close, unchanged };
  } catch (error) { await runtime.dispose(); if (!window.isDestroyed()) window.destroy(); throw error; }
}
