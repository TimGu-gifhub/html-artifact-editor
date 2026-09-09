import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import type { Fixture } from './main.ts';

type Checks = Readonly<{
  use: (run: (f: Fixture) => Promise<void>, persistDrafts?: boolean) => Promise<void>;
  until: (check: () => boolean, label: string) => Promise<void>;
  barrier: () => { wait: Promise<void>; release: () => void };
  pass: (label: string) => void; original: Buffer; expected: Buffer; css: Buffer;
}>;
export async function checkDeparture({ use, until, barrier, pass, original, expected, css }: Checks): Promise<void> {
  const open = async (f: Fixture) => f.call(`haeWorkspace.open(${(await f.read()).stateRevision})`);
  const unchanged = async (f: Fixture) => {
    assert.deepEqual(await readFile(f.entry), original); assert.deepEqual(await readFile(join(f.project, 'keep.css')), css);
  };
  await use(async f => {
    const writing = barrier(); const retiring = barrier(); let heldWrite = false; let heldRetirement = false; let reviews = 0;
    f.control.review = async value => { reviews++; return { reviewId: value.reviewId, decision: 'discard' }; };
    f.control.draftStep = async step => {
      if (step === 'baseline-synced') { heldWrite = true; await writing.wait; }
      if (step === 'retirement-synced') { heldRetirement = true; await retiring.wait; }
    };
    try {
      await f.dirty(); await until(() => heldWrite, 'checkpoint before native departure'); const old = f.current();
      f.ui.close(); await until(() => old.input.snapshot().phase === 'leaving', 'held departure input');
      f.ui.close(); assert.equal(f.ui.isDestroyed(), false); assert.equal((await f.change('late input')).code, 'WORKSPACE_BUSY');
      assert.equal(old.input.snapshot().canApply, false); assert.equal(old.input.snapshot().canSaveCopy, false);
      assert.equal(f.runtime.host.current, old.preview.view);
      writing.release(); await until(() => heldRetirement, 'retirement before native destruction');
      assert.equal(f.runtime.workspace.current, old); assert.equal(f.ui.isDestroyed(), false); assert.equal(old.input.snapshot().phase, 'leaving');
      retiring.release(); await until(() => f.ui.isDestroyed(), 'native destruction after verified retirement');
      const reopened = await createDraftCheckpointStore(f.privateRoot); const group = (await reopened.catalog()).groups[0]!;
      assert.equal(group.status, 'retired'); assert.equal(group.retirement, 'discarded'); assert.equal(reviews, 1);
      await assert.rejects(reopened.restoreLatest(old.id, old.saveSource, old.mapping.source)); await unchanged(f);
    } finally { writing.release(); retiring.release(); }
    pass('native discard-close drains persistence, freezes all late input, deduplicates close requests and waits for a verified retirement marker before destroying the window');
  }, true);

  await use(async f => {
    await f.dirty(); const old = f.current(); await old.persistence!.settle();
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'discard' });
    for (const step of ['attached', 'sized', 'detached'] as const) {
      f.control.hostFault = step; const result = await open(f);
      assert.equal(result.code, 'DOCUMENT_ACTIVATION_FAILED'); assert.equal(f.current(), old); assert.equal(f.runtime.host.current, old.preview.view);
      assert.equal(old.input.snapshot().phase, 'idle'); assert.equal(old.input.snapshot().canApply, true);
      assert.equal((await f.checkpoints.catalog(old.saveSource.current)).groups[0]!.status, 'dirty');
      assert.equal((await f.read()).lastDeparture, null); assert.deepEqual(Buffer.from(old.draft.candidate.bytes), expected);
    }
    await unchanged(f);
    pass('real native attach, bounds and detach failures after discard approval retain the editable original draft and never retire its records');
  }, true);

  await use(async f => {
    await f.dirty(); const old = f.current(); await old.persistence!.settle();
    assert.equal((await open(f)).outcome, 'cancelled');
    f.control.review = async value => { assert.equal((await f.change('确认期间的新输入')).ok, true); return { reviewId: value.reviewId, decision: 'discard' }; };
    assert.equal((await open(f)).code, 'STALE_DOCUMENT_REVIEW'); assert.equal(old.input.snapshot().input!.text, '确认期间的新输入');
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'save-copy' });
    assert.equal((await open(f)).outcome, 'cancelled'); await old.persistence!.settle();
    assert.equal(old.input.snapshot().hasUnappliedInput, false); assert.equal(old.draft.revision, 3);
    assert.equal((await f.checkpoints.catalog()).groups[0]!.status, 'dirty');
    f.control.copyPath = join(f.project, 'pages', '离开副本.html');
    const copied = await open(f); assert.equal(copied.ok, true); assert.equal(copied.outcome, 'opened');
    assert.notEqual(f.current().id, old.id); assert.equal(copied.state!.lastDeparture!.status, 'retired');
    const group = (await f.checkpoints.catalog()).groups[0]!; assert.equal(group.retirement, 'copied'); assert.equal(group.draftRevision, 3);
    assert.deepEqual(await readFile(f.control.copyPath), Buffer.from(original.toString().replace('A &amp; 😀', '确认期间的新输入')));
    await unchanged(f);
    pass('cancelled/stale leave reviews and a cancelled copy chooser retain recovery records; only a verified explicit copy retires the exact applied revision before opening the next document');
  }, true);

  for (const stage of ['lock-created', 'retirement-created', 'retirement-synced']) await use(async f => {
    await f.dirty(); const old = f.current(); await old.persistence!.settle();
    assert.equal((await f.change('还未应用的输入也须保留')).ok, true);
    const record = (await f.checkpoints.scan()).records[0]!; const baseline = await readFile(join(f.privateRoot, record.checkpointId, 'baseline.bin'));
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'discard' });
    f.control.draftStep = async step => { if (step === stage) throw Object.assign(new Error('injected retirement failure'), { code: 'ENOSPC' }); };
    f.ui.close(); await until(() => !f.runtime.closing && f.errors.length > 0, 'failed native departure');
    assert.equal(f.errors.at(-1), stage === 'lock-created' ? 'DRAFT_RETIREMENT_FAILED' : 'DRAFT_RETIREMENT_UNKNOWN');
    assert.equal(f.ui.isDestroyed(), false); assert.equal(f.current(), old); assert.equal(f.runtime.host.current, old.preview.view);
    const state = await f.read(); assert.equal(state.lastDeparture!.requiresReview, true); assert.equal(state.current!.input.phase, 'leaving');
    assert.equal(state.current!.input.hasUnappliedInput, true); assert.equal(state.current!.input.input!.text, '还未应用的输入也须保留');
    assert.equal(state.current!.input.input!.appliedText, '已修订 <&> 🧪');
    assert.deepEqual(Buffer.from(old.draft.candidate.bytes), expected); assert.equal((await f.change('blocked input')).code, 'DOCUMENT_RECOVERY_REQUIRED');
    assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(old.id)},2)`)).code, 'DOCUMENT_RECOVERY_REQUIRED');
    f.control.draftStep = async () => {}; f.ui.close(); await until(() => !f.runtime.closing && f.errors.at(-1) === 'DOCUMENT_RECOVERY_REQUIRED', 'no repeated retirement');
    assert.equal(f.ui.isDestroyed(), false); assert.deepEqual(await readFile(join(f.privateRoot, record.checkpointId, 'baseline.bin')), baseline);
    const catalog = await f.checkpoints.catalog(); assert.equal(catalog.groups[0]!.status,
      stage === 'lock-created' ? 'dirty' : stage === 'retirement-created' ? 'invalid' : 'retired');
    await unchanged(f);
    pass(`${stage}: retirement failure keeps the native window, raw input, candidate and source evidence; rollback restores the old Preview and repeated requests cannot blindly continue`);
  }, true);

  for (const stage of ['baseline-synced', 'retirement-synced']) await use(async f => {
    const hold = barrier(); let waiting = false;
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'discard' });
    f.control.draftStep = async step => { if (step === stage) { waiting = true; await hold.wait; } };
    try {
      await f.dirty(); const old = f.current();
      if (stage === 'baseline-synced') await until(() => waiting, 'checkpoint before renderer revocation');
      else await old.persistence!.settle();
      void open(f).catch(() => null);
      await until(() => old.input.snapshot().phase === 'leaving' && waiting, 'departure before renderer revocation');
      f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'revoked departure renderer'); hold.release();
      await until(() => f.runtime.workspace.snapshot().phase === 'idle', 'Main departure settlement');
      const catalog = await f.checkpoints.catalog();
      if (stage === 'baseline-synced') {
        assert.equal(f.current(), old); assert.equal(old.input.snapshot().phase, 'idle'); assert.equal(catalog.groups[0]!.status, 'dirty');
      } else {
        assert.notEqual(f.current().id, old.id); assert.equal(catalog.groups[0]!.status, 'retired');
        assert.equal(f.runtime.workspace.snapshot().lastDeparture!.requiresReview, false);
      }
      await f.runtime.reloadUI(); assert.equal((await f.read()).current!.id, f.current().id); await unchanged(f);
      assert.equal(f.current().mapping.status, 'ready');
      // Publication must preserve a live mapping after the old operation signal
      // was revoked; document identity alone does not prove a usable session.
      f.control.draftStep = async () => {};
      await f.select('#date'); assert.equal((await f.change('2026-09-09')).ok, true); await f.apply();
      await f.current().persistence!.settle(); assert.equal(f.current().draft.textFor(f.current().mapping.selection!.nodeId), '2026-09-09');
      await unchanged(f);
    } finally { hold.release(); }
    pass(`${stage}: actual renderer crash cancels departure before retirement starts or lets Main finish an already authorized marker; production preload reconnects to the settled document`);
  }, true);

  await use(async f => {
    await f.dirty(); const old = f.current(); await old.persistence!.settle();
    f.control.draftStep = async step => { if (step === 'baseline-created') throw new Error('incomplete return to baseline'); };
    await f.change('A & 😀'); await f.apply(); await old.persistence!.settle(); assert.equal(old.draft.candidate.patches.length, 0);
    f.ui.close(); await until(() => !f.runtime.closing && f.errors.at(-1) === 'DRAFT_PERSISTENCE_REQUIRED', 'clean departure refused');
    assert.equal(f.ui.isDestroyed(), false); assert.equal(f.current(), old); assert.equal(old.input.snapshot().phase, 'idle');
    assert.equal((await f.read()).lastDeparture!.requiresReview, false);
    f.control.draftStep = async () => {};
    assert.equal((await f.call(`haeWorkspace.retryPersistence(${JSON.stringify(old.id)},3)`)).ok, true); await old.persistence!.settle();
    f.ui.close(); await until(() => f.ui.isDestroyed(), 'clean departure after explicit retry');
    const catalog = await f.checkpoints.catalog(); assert.equal(catalog.groups[0]!.status, 'clean'); assert.equal(catalog.groups[0]!.retirement, null);
    await assert.rejects(f.checkpoints.restoreLatest(old.id, old.saveSource, old.mapping.source)); await unchanged(f);
    pass('a failed return-to-baseline checkpoint blocks native clean close without discarding older evidence; explicit retry confirms the latest clean point and allows closure');
  }, true);

  await use(async f => {
    await f.dirty(); const old = f.current(); await old.persistence!.settle();
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'discard' });
    f.control.draftStep = async step => { if (step === 'release-lock') throw new Error('retirement cleanup failed'); };
    const result = await open(f); assert.equal(result.ok, true); assert.equal(result.outcome, 'opened'); assert.notEqual(f.current().id, old.id);
    assert.equal(result.state!.lastDeparture!.status, 'retired'); assert.equal(result.state!.lastDeparture!.cleanupPending, true);
    assert.equal((await f.checkpoints.catalog()).locked, true); assert.equal((await open(f)).code, 'DOCUMENT_RECOVERY_REQUIRED'); await unchanged(f);
    pass('confirmed retirement with failed lock cleanup still completes the document change and reports the cleanup warning while retaining all evidence');
  }, true);
}
