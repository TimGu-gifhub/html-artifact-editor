import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, webContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createWorkspace } from '../../src/main/workspace/controller.ts';
import type { Workspace } from '../../src/main/workspace/controller.ts';
import { prepareDocument } from '../../src/main/workspace/document.ts';
import type { OpenDocument } from '../../src/main/workspace/document.ts';
import { bindWorkspaceWindow } from '../../src/main/workspace/window.ts';
import { createNewFileWriter } from '../../src/platform/new-file.ts';
import type { LeaveReview } from '../../src/contracts/workspace.ts';

registerSchemes(); app.enableSandbox();
app.on('before-quit', (event) => event.preventDefault());
const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'workspace-profile'));
const passed: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let workspace: Workspace;
let window: BaseWindow;
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!check()) { if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`); await delay(10); }
}
async function selectTitle(value: OpenDocument): Promise<void> {
  window.contentView.addChildView(value.preview.view); value.preview.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
  window.showInactive();
  const point = await value.preview.contents.executeJavaScript(`(() => {
    const r=document.createRange();r.selectNodeContents(document.querySelector('h1'));const b=r.getBoundingClientRect();
    return {x:Math.round(b.x+5),y:Math.round(b.y+b.height/2)};
  })()`);
  value.preview.contents.focus();
  value.preview.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  value.preview.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until(() => value.mapping.selection !== null, 'native title selection');
  await value.input.begin({ selection: value.mapping.selection, draftRevision: value.draft.revision });
}
function pendingText(value: OpenDocument, text: string, composing = false): void {
  const input = value.input.snapshot().input!;
  value.input.change({ editToken: input.editToken, inputRevision: input.revision + 1, newText: text, composing });
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await app.whenReady();
  const directory = await mkdtemp(join(results, 'workspace-case-'));
  const firstPath = join(directory, '第一份 报告 🧪.html');
  const secondPath = join(directory, 'second.html');
  const badPath = join(directory, 'too-deep.html');
  const copyPath = join(directory, '另存后关闭.html');
  const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>自制</title><link rel="stylesheet" href="keep.css"></head><body><h1>A &amp; 😀</h1><!-- keep --></body></html>');
  const secondBytes = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Second</title></head><body><h1>第二份</h1></body></html>');
  const css = Buffer.from('body{font:24px sans-serif;padding:20px}');
  await writeFile(firstPath, original); await writeFile(secondPath, secondBytes); await writeFile(join(directory, 'keep.css'), css);
  await writeFile(badPath, '<!doctype html><html><head><title>too deep</title></head><body>' + '<div>'.repeat(270) + 'deep' + '</div>'.repeat(270) + '</body></html>');
  const originals = { [firstPath]: original, [secondPath]: secondBytes, [join(directory, 'keep.css')]: css };
  let reviewCalls = 0; let chooseCalls = 0;
  let review: (value: LeaveReview) => Promise<unknown> = async (value) => ({ reviewId: value.reviewId, decision: 'cancel' });
  let chooseCopy: () => Promise<string | undefined> = async () => undefined;
  let failAfterCreate = false;
  const injectedWriter = await createNewFileWriter(directory, async (step) => {
    if (failAfterCreate && step === 'created') throw new Error('injected disk failure after creation');
  });
  workspace = createWorkspace(outputRoot, {
    review: async (value) => { reviewCalls++; return review(value); }, chooseCopy: () => chooseCopy(),
  }, async (...args) => Object.freeze({ ...await prepareDocument(...args), writer: injectedWriter }));
  const open = (path: string | undefined) => workspace.open(workspace.snapshot().stateRevision, async () => { chooseCalls++; return path; });
  const close = () => workspace.requestClose(workspace.snapshot().stateRevision);
  const errors: string[] = [];
  window = new BaseWindow({ show: false, width: 960, height: 640 });
  const guard = bindWorkspaceWindow(window, workspace, (code) => errors.push(code));
  try {
    assert.equal((await open(undefined)).status, 'cancelled'); assert.equal(workspace.current, null);
    const firstOpen = await open(firstPath); assert.equal(firstOpen.status, 'opened'); assert.equal(firstOpen.state.phase, 'idle');
    const first = workspace.current!;
    assert.equal(first.name, '第一份 报告 🧪.html'); assert.equal(first.mapping.status, 'ready');
    await selectTitle(first); pendingText(first, '未应用的标题 <&> 😀');
    const retainedInput = first.input.snapshot().input;
    const retainedCandidate = first.draft.candidate;
    const count = webContents.getAllWebContents().length;
    await assert.rejects(open(badPath));
    assert.equal(workspace.current, first); assert.equal(first.preview.isActive(), true);
    assert.equal(first.input.snapshot().input, retainedInput); assert.equal(first.draft.candidate, retainedCandidate);
    assert.equal(webContents.getAllWebContents().length, count); assert.equal(reviewCalls, 0);
    pass('a real Chromium preview whose later source parsing exceeds depth limits is retired; the old live preview, exact pending input and candidate survive');

    let simultaneous = 0;
    review = async (value) => {
      simultaneous = webContents.getAllWebContents().length;
      assert.equal(first.preview.isActive(), true);
      return { reviewId: value.reviewId, decision: 'cancel' };
    };
    assert.equal((await open(secondPath)).status, 'cancelled'); assert.equal(simultaneous, count + 1);
    assert.equal(webContents.getAllWebContents().length, count); assert.equal(workspace.current, first);
    assert.equal(first.input.snapshot().input, retainedInput);
    assert.equal((await open(undefined)).status, 'cancelled'); assert.equal(first.draft.candidate, retainedCandidate);
    pass('new document is fully prepared beside the old view before review; cancelled review/chooser retires only the candidate and performs no HTML write');

    review = async (value) => {
      pendingText(first, '确认期间的新文字 & 😀');
      return { reviewId: value.reviewId, decision: 'discard' };
    };
    await assert.rejects(open(secondPath), /STALE_DOCUMENT_REVIEW/);
    assert.equal(first.input.snapshot().input!.text, '确认期间的新文字 & 😀'); assert.equal(workspace.current, first);
    assert.equal(await first.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'A & 😀');
    pendingText(first, '确认期间的新文字 & 😀', true);
    const chosen = chooseCalls;
    await assert.rejects(open(secondPath), /INPUT_COMPOSING/); assert.equal(chooseCalls, chosen);
    window.close(); await until(() => errors.length > 0, 'composing native close rejected');
    assert.equal(errors.at(-1), 'INPUT_COMPOSING'); assert.equal(window.isDestroyed(), false);
    pendingText(first, '确认期间的新文字 & 😀', false);
    pass('newer input invalidates a previous leave confirmation; composing blocks the open chooser and actual window close event while keeping the source untouched');

    review = async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' });
    chooseCopy = async () => undefined;
    assert.equal((await close()).status, 'cancelled'); assert.equal(workspace.current, first);
    assert.equal(first.input.snapshot().hasUnappliedInput, false); assert.equal(first.draft.candidate.patches.length, 1);
    const expected = Buffer.from(original.toString('utf8').replace('A &amp; 😀', '确认期间的新文字 &amp; 😀'));
    assert.deepEqual(Buffer.from(first.draft.candidate.bytes), expected); assert.deepEqual(await readFile(firstPath), original);
    chooseCopy = async () => firstPath;
    window.close(); await until(() => errors.at(-1) === 'COPY_FAILED' && !guard.closing, 'refused overwrite close');
    assert.equal(window.isDestroyed(), false); assert.equal(workspace.current, first);
    assert.deepEqual(Buffer.from(first.draft.candidate.bytes), expected); assert.deepEqual(await readFile(firstPath), original);
    pass('apply-and-save-before-close with a cancelled chooser keeps the applied draft; actual window close cannot bypass refused overwrite or destroy the current session');

    const reviewGate: { release?: () => void } = {};
    review = async (value) => {
      await new Promise<void>((resolveReview) => { reviewGate.release = resolveReview; });
      return { reviewId: value.reviewId, decision: 'cancel' };
    };
    const reviewsBefore = reviewCalls;
    window.close(); await until(() => reviewCalls > reviewsBefore, 'native close awaiting leave decision');
    window.close(); assert.equal(reviewCalls, reviewsBefore + 1); assert.equal(guard.closing, true);
    reviewGate.release!(); await until(() => !guard.closing, 'cancelled native close');
    assert.equal(window.isDestroyed(), false); assert.equal(workspace.current, first);
    review = async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' }); chooseCopy = async () => copyPath;
    window.close(); await until(() => window.isDestroyed(), 'verified copy then native close');
    assert.equal(workspace.current, null); assert.equal(first.preview.contents.isDestroyed(), true);
    assert.deepEqual(await readFile(copyPath), expected); assert.deepEqual(await readFile(firstPath), original);
    pass('repeated native close requests share one review; cancellation stays open, and only a verified exclusive copy allows the native window to close');

    // A fresh workspace reopens the actual copy; the previous disposed workspace
    // cannot be resumed accidentally by a late callback.
    const disposed = workspace;
    await until(() => disposed.snapshot().phase === 'disposed', 'closed window disposes coordinator');
    workspace = createWorkspace(outputRoot, { review: async (value) => ({ reviewId: value.reviewId, decision: 'discard' }),
      chooseCopy: async () => undefined }, prepareDocument);
    await workspace.open(workspace.snapshot().stateRevision, async () => copyPath);
    assert.equal(workspace.current!.mapping.status, 'ready');
    assert.equal(await workspace.current!.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '确认期间的新文字 & 😀');
    const reopened = workspace.current!;
    await workspace.open(workspace.snapshot().stateRevision, async () => secondPath);
    assert.equal(reopened.preview.contents.isDestroyed(), true); assert.equal(workspace.current!.name, 'second.html');
    assert.ok(workspace.current!.preview.identity.generation > reopened.preview.identity.generation);
    await workspace.dispose();
    pass('the saved copy reopens with correct text and a fresh verified mapping; a clean replacement revokes the old view and advances generation');

    workspace = createWorkspace(outputRoot, { review: async (value) => ({ reviewId: value.reviewId, decision: 'save-copy' }),
      chooseCopy: async () => join(directory, 'unknown-copy.html') },
    async (...args) => Object.freeze({ ...await prepareDocument(...args), writer: injectedWriter }));
    await workspace.open(workspace.snapshot().stateRevision, async () => firstPath);
    window = new BaseWindow({ show: false, width: 960, height: 640 });
    const unknownErrors: string[] = [];
    const unknownGuard = bindWorkspaceWindow(window, workspace, (code) => unknownErrors.push(code));
    const unknownDoc = workspace.current!;
    await selectTitle(unknownDoc); pendingText(unknownDoc, '需要保留的草稿'); failAfterCreate = true;
    window.close();
    await until(() => unknownErrors.at(-1) === 'COPY_OUTCOME_UNKNOWN' && !unknownGuard.closing, 'unknown copy blocks native close');
    assert.equal(window.isDestroyed(), false);
    assert.equal(workspace.current, unknownDoc); assert.equal(unknownDoc.preview.isActive(), true);
    assert.equal(unknownDoc.input.snapshot().draftPhase, 'uncertain');
    assert.equal(unknownDoc.draft.candidate.patches[0]!.newText, '需要保留的草稿');
    let forbiddenChooser = 0;
    await assert.rejects(workspace.open(workspace.snapshot().stateRevision, async () => { forbiddenChooser++; return secondPath; }), /DOCUMENT_RECOVERY_REQUIRED/);
    assert.equal(forbiddenChooser, 0); assert.equal((await readFile(join(directory, 'unknown-copy.html'))).length, 0);
    for (const [path, before] of Object.entries(originals)) assert.deepEqual(await readFile(path), before, path);
    pass('real failure after exclusive file creation preserves the partial file and current draft, blocks leaving/reopening until recovery, and leaves all original HTML/CSS bytes identical');

    await writeFile(join(results, 'workspace.json'), JSON.stringify({ status: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      platform: { os: type(), release: release(), arch: arch() }, versions: process.versions, passed,
      fileHashes: { original: hash(original), second: hash(secondBytes), css: hash(css), copy: hash(expected) } }, null, 2));
  } finally { await workspace.dispose(); if (!window.isDestroyed()) window.destroy(); }
}
void run().then(() => app.exit(0)).catch(async (error: unknown) => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'workspace.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2));
  await workspace?.dispose(); if (window && !window.isDestroyed()) window.destroy(); app.exit(1);
});
