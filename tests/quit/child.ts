import { proofreadSnapshot } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { LeaveReview } from '../../src/contracts/workspace.ts';
import { registerSchemes } from '../../src/main/application.ts';
import { bindWorkspaceQuit } from '../../src/main/workspace/quit.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { fixture, editorWindow, original, css, barrier, until } from '../startup/fixture.ts';

const [mode, profile, root, entry, reportPath] = process.argv.slice(2);
if (!mode || !profile || !root || !entry || !reportPath) throw new Error('Invalid quit test arguments');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
const errors: string[] = []; let reviews = 0; let willQuit = 0;
const flags: string[] = []; let expected: Buffer = original;
let decide: (review: LeaveReview) => Promise<unknown> = async value => ({ reviewId: value.reviewId, decision: 'cancel' });
let chooseCopy = async (): Promise<string | undefined> => undefined;
let step = async (_kind: 'save' | 'checkpoint', _step: string): Promise<void> => {};
const fail = (error: unknown): void => {
  writeFileSync(reportPath, JSON.stringify({ status: 'failed', mode, error: String(error), flags, errors })); console.error(error); app.exit(1);
};
void app.whenReady().then(async () => {
  let quit!: ReturnType<typeof bindWorkspaceQuit>;
  const outputRoot = resolve(__dirname, '..');
  const f = await fixture(outputRoot, root, entry, {
    review: async value => { reviews++; return decide(value); }, chooseCopy: () => chooseCopy(),
    reportError: code => errors.push(code), onStorageStep: (kind, value) => step(kind, value),
  }, (window, runtime) => { quit = bindWorkspaceQuit(window, runtime, code => errors.push(code)); });
  const report = (exit: 'native' | 'harness-after-block'): void => {
    assert.deepEqual(readFileSync(entry), expected); assert.deepEqual(readFileSync(join(root, 'keep.css')), css);
    const state = proofreadSnapshot(f.runtime.workspace.snapshot());
    writeFileSync(reportPath, JSON.stringify({ status: 'passed', mode, exit, flags, errors, reviews, willQuit,
      destroyed: f.window.isDestroyed(), ready: quit.ready, departure: state.lastDeparture?.status ?? null,
      persistence: state.current?.persistence?.status ?? null, bytesHash: digest(readFileSync(entry)) }, null, 2));
  };
  app.on('will-quit', event => {
    if (event.defaultPrevented) return;
    try { willQuit++; assert.equal(quit.ready, true); assert.equal(f.window.isDestroyed(), true); report('native'); }
    catch (error) { event.preventDefault(); fail(error); }
  });
  const blocked = async (): Promise<void> => {
    assert.equal(willQuit, 0); assert.equal(quit.ready, false); assert.equal(f.window.isDestroyed(), false);
    report('harness-after-block'); app.exit(0);
  };
  const edit = async (text: string, apply = true) => {
    await f.select('h1'); assert.ok((await f.change(text)).ok);
    if (apply) { await f.apply(); await f.current().persistence!.settle(); }
  };
  await f.open();

  if (mode === 'clean-window') {
    flags.push('native-close-without-explicit-app-quit'); f.window.close(); return;
  }
  if (mode === 'cancel-ime') {
    await edit('保留尚未应用的输入 🧪', false); const hold = barrier(); let review: LeaveReview | undefined;
    decide = async value => { review = value; await hold.wait; return { reviewId: value.reviewId, decision: 'cancel' }; };
    f.window.close(); app.quit(); const request = quit.requestQuit(); assert.equal(request, quit.requestQuit());
    await until(() => !!review, 'one quit/close review'); assert.equal(reviews, 1); assert.equal(f.window.isDestroyed(), false);
    hold.release(); assert.equal(await request, 'cancelled'); await f.unchanged();
    assert.equal(f.current().input.snapshot().input!.text, '保留尚未应用的输入 🧪');
    assert.ok((await f.change('输入法正在组合', true)).ok); app.quit(); assert.equal(await quit.requestQuit(), 'blocked');
    assert.equal(reviews, 1); assert.ok(errors.includes('INPUT_COMPOSING')); assert.equal(f.window.isDestroyed(), false);
    assert.ok((await f.change('输入法已结束', false)).ok);
    flags.push('one-shared-review', 'cancel-preserves-input', 'composing-refuses-quit');
    decide = async value => ({ reviewId: value.reviewId, decision: 'discard' }); app.quit(); return;
  }
  if (mode === 'copy') {
    await edit('明确另存后退出 🧪', false); decide = async value => ({ reviewId: value.reviewId, decision: 'save-copy' });
    app.quit(); assert.equal(await quit.requestQuit(), 'cancelled'); await f.unchanged();
    assert.equal(f.current().input.snapshot().hasUnappliedInput, false); assert.equal(f.current().draft.candidate.patches.length, 1);
    flags.push('copy-chooser-cancel-keeps-applied-draft');
    chooseCopy = async () => join(root, 'copy.html'); app.quit(); return;
  }
  if (mode === 'save-success' || mode === 'save-conflict' || mode === 'save-unknown') {
    await edit('等待已有保存完成 🧪'); const hold = barrier(); let waiting = false; let preparations = 0;
    step = async (kind, value) => {
      if (kind === 'save' && value === 'prepared-synced') { preparations++; waiting = true; await hold.wait; }
      if (mode === 'save-unknown' && kind === 'save' && value === 'committed-created') throw new Error('self-made commit journal failure');
    };
    const saving = f.save(); void saving.catch(() => { /* A quitting renderer may lose its response. */ });
    await until(() => waiting, 'accepted Save preparation'); app.quit(); const request = quit.requestQuit(); f.window.close();
    assert.equal(quit.requestQuit(), request); assert.equal(f.window.isDestroyed(), false); await f.unchanged(); assert.equal(reviews, 0);
    if (mode === 'save-success') {
      expected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '等待已有保存完成 🧪'));
      flags.push('quit-waits-existing-save-without-retry'); hold.release(); return;
    }
    if (mode === 'save-unknown') {
      expected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '等待已有保存完成 🧪')); hold.release();
      assert.equal(await request, 'blocked'); assert.equal(proofreadSnapshot((await saving).state!).lastSave!.status, 'unknown');
      assert.equal(f.window.isDestroyed(), false); assert.equal(await quit.requestQuit(), 'blocked'); assert.equal(preparations, 1);
      flags.push('unknown-native-save-retains-window-and-journal-without-retry'); await blocked(); return;
    }
    expected = Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '外部程序的新版本'));
    await writeFile(entry, expected); hold.release(); assert.equal(await request, 'blocked');
    assert.equal((await saving).ok, false); assert.equal(f.window.isDestroyed(), false); assert.ok(errors.includes('WINDOW_SAVE_UNSETTLED'));
    flags.push('failed-save-preserves-window-and-external-version'); await blocked(); return;
  }
  if (mode === 'backup-success') {
    await edit('备份恢复前的已保存版本'); assert.equal((await f.save()).outcome, 'saved'); await f.current().persistence!.settle();
    const id = f.current().id; const list = await f.call(`haeWorkspace.listBackups(${JSON.stringify(id)})`);
    const backup = list.backups!.entries.find(value => value.hash === digest(original))!; assert.ok(backup);
    const hold = barrier(); let waiting = false;
    step = async (kind, value) => { if (kind === 'save' && value === 'prepared-synced') { waiting = true; await hold.wait; } };
    const restoring = f.call(`haeWorkspace.restoreBackup(${JSON.stringify(id)},${(await f.read()).stateRevision},${JSON.stringify(backup.reference)})`);
    void restoring.catch(() => { /* A quitting renderer may lose its response. */ });
    await until(() => waiting, 'accepted backup replacement'); app.quit(); const request = quit.requestQuit();
    assert.equal(request, quit.requestQuit()); assert.equal(f.window.isDestroyed(), false); assert.equal(willQuit, 0);
    flags.push('quit-waits-existing-backup-replacement'); hold.release(); return;
  }
  if (mode === 'draft-drain' || mode === 'forced-close') {
    const hold = barrier(); let waiting = false;
    step = async (kind, value) => { if (kind === 'checkpoint' && value === 'baseline-synced') { waiting = true; await hold.wait; } };
    await f.select('h1'); assert.ok((await f.change('已应用且正在持久化')).ok); await f.apply();
    await until(() => waiting, 'durable draft write');
    if (mode === 'forced-close') f.window.destroy();
    else { decide = async value => ({ reviewId: value.reviewId, decision: 'discard' }); app.quit(); }
    const request = quit.requestQuit(); assert.equal(request, quit.requestQuit());
    await until(() => mode === 'forced-close' ? quit.busy : reviews === 1, 'quit waiting for durability');
    assert.equal(willQuit, 0); assert.equal(quit.ready, false); await f.unchanged();
    flags.push(mode === 'forced-close' ? 'forced-destruction-drains-without-discard' : 'explicit-discard-drains-and-retires');
    hold.release(); return;
  }
  if (mode === 'retirement-failure') {
    await edit('保留失败的离开证据'); let attempts = 0;
    step = async (kind, value) => { if (kind === 'checkpoint' && value === 'retirement-created') { attempts++; throw new Error('self-made retirement failure'); } };
    decide = async value => ({ reviewId: value.reviewId, decision: 'discard' }); app.quit();
    assert.equal(await quit.requestQuit(), 'blocked'); assert.equal(attempts, 1); assert.equal(f.window.isDestroyed(), false);
    assert.equal(proofreadSnapshot(f.runtime.workspace.snapshot()).lastDeparture!.requiresReview, true);
    assert.equal(await quit.requestQuit(), 'blocked'); assert.equal(attempts, 1);
    flags.push('failed-retirement-keeps-process-window-and-evidence'); await blocked(); return;
  }
  if (mode === 'storage-active') {
    // A real Main ownership claim outside the departing document must still
    // prevent runtime cleanup; do not release it to make exit appear successful.
    f.runtime.storage.checkpoints.claimSession(randomUUID()); app.quit(); assert.equal(await quit.requestQuit(), 'blocked');
    assert.equal(f.window.isDestroyed(), false); assert.ok(errors.includes('DRAFT_STORAGE_ACTIVE'));
    f.window.close(); await delay(50); assert.equal(f.window.isDestroyed(), false); assert.equal(await quit.requestQuit(), 'blocked');
    flags.push('native-window-survives-unconfirmed-storage-cleanup'); await blocked(); return;
  }
  if (mode === 'foreign-window') {
    const other = await editorWindow(outputRoot, root);
    assert.throws(() => bindWorkspaceQuit(f.window, f.runtime, code => errors.push(code)), /APP_QUIT_ALREADY_BOUND/);
    app.quit(); assert.equal(await quit.requestQuit(), 'blocked'); assert.equal(reviews, 0);
    assert.equal(f.window.isDestroyed(), false); assert.equal(other.isDestroyed(), false); assert.ok(errors.includes('APP_QUIT_OTHER_WINDOWS'));
    other.destroy(); flags.push('unmanaged-window-and-duplicate-binder-refused'); app.quit(); return;
  }
  if (mode === 'renderer-loss') {
    await edit('确认期间保留的输入', false); const hold = barrier(); let waiting = false;
    decide = async value => { waiting = true; await hold.wait; return { reviewId: value.reviewId, decision: 'discard' }; };
    app.quit(); const request = quit.requestQuit(); await until(() => waiting, 'quit review before crash');
    f.window.webContents.forcefullyCrashRenderer(); assert.equal(await request, 'blocked');
    assert.equal(f.window.isDestroyed(), false); assert.equal(f.current().input.snapshot().input!.text, '确认期间保留的输入');
    hold.release(); await f.runtime.reloadUI(); await f.unchanged();
    flags.push('renderer-loss-revokes-old-review-and-retains-input');
    decide = async value => ({ reviewId: value.reviewId, decision: 'discard' }); app.quit(); return;
  }
  throw new Error('Unknown quit test mode');
}).catch(fail);
