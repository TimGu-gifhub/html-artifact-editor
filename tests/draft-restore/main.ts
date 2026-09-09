import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { prepareDocument } from '../../src/main/workspace/document.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { fixture, until } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import { original, expected, restoredTitle, restoredDate } from './seed.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', event => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'recovery-profile'));
const passed: string[] = []; const pending: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
type ChildMessage = { state: string; sessionId?: string; checkpointId?: string; resultHash?: string };
function startChild(mode: string, profile: string, ...args: string[]) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [join(outputRoot, 'recovery-child/index.cjs'), mode, profile, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = ''; let diagnostic = ''; let message: ChildMessage | null = null;
  child.stdout.on('data', data => {
    buffer += String(data); const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) { try { const value = JSON.parse(line); if (typeof value.state === 'string') message = value; } catch { /* Electron diagnostics are not the ready message. */ } }
  });
  child.stderr.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-8192); });
  const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  const ready = async () => { await until(() => message !== null, `child ${mode}: ${diagnostic}`); return message!; };
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  return { ready, exited, stop };
}
async function use(run: (f: Fixture) => Promise<void>, seed?: Parameters<typeof fixture>[2]): Promise<void> {
  const f = await fixture(outputRoot, results, seed); try { await run(f); } finally { await f.close(); }
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await mkdir(app.getPath('userData'), { recursive: true }); await app.whenReady();
  const profile = await mkdtemp(join(results, 'ownership-profile-'));
  const holder = startChild('hold', profile);
  try {
    assert.equal((await holder.ready()).state, 'acquired');
    const competitor = startChild('probe', profile);
    try { assert.equal((await competitor.ready()).state, 'blocked'); assert.equal(await competitor.exited, 0); }
    finally { await competitor.stop(); }
  } finally { await holder.stop(); }
  const successor = startChild('probe', profile);
  try { assert.equal((await successor.ready()).state, 'acquired'); assert.equal(await successor.exited, 0); }
  finally { await successor.stop(); }
  pass('real Electron processes exclude a second persistent editor in the same profile and release ownership on process termination without deleting locks');

  await use(async f => {
    const names = await readdir(f.privateRoot); const listing = await f.call('haeWorkspace.listRecovery()'); assert.equal(listing.ok, true);
    assert.deepEqual(listing.recovery, { entries: [{ sessionId: f.record.sessionId, name: '报告 😀.html', draftRevision: 7, status: 'dirty', active: false }], locked: false, reviewRequired: false });
    const result = await f.restore(); assert.equal(result.ok, true, result.code ?? 'restore failed'); assert.equal(result.outcome, 'restored');
    const value = f.current(); assert.notEqual(value.id, f.record.sessionId); assert.equal(value.checkpointSessionId, f.record.sessionId);
    assert.equal(value.draft.revision, 7); assert.equal(value.mapping.selection, null); assert.equal(value.mapping.status, 'ready');
    assert.deepEqual(Buffer.from(value.draft.candidate.bytes), expected); assert.deepEqual(Buffer.from(value.mapping.source.bytes), original);
    assert.equal(value.persistence!.snapshot().persisted!.draftRevision, 7); assert.deepEqual(await readdir(f.privateRoot), names);
    assert.deepEqual(await value.preview.contents.executeJavaScript('[document.querySelector("h1").textContent,document.querySelector("#date").textContent,getComputedStyle(document.body).color]'), [restoredTitle, restoredDate, 'rgb(12, 34, 56)']);
    assert.deepEqual(await value.preview.contents.executeJavaScript('[typeof haeWorkspace,typeof require,typeof ipcRenderer]'), ['undefined', 'undefined', 'undefined']);
    const chooses = f.control.chooses; assert.equal((await f.restore()).code, 'DRAFT_SESSION_ACTIVE'); assert.equal(f.control.chooses, chooses);
    const peerStore = await createDraftCheckpointStore(f.privateRoot);
    await assert.rejects(prepareDocument(outputRoot, value.preview.grant, 100, new AbortController().signal, peerStore, f.record.sessionId), /DRAFT_SESSION_ACTIVE/);
    assert.equal((await f.call('haeWorkspace.listRecovery()')).recovery!.entries[0]!.active, true);
    assert.equal((await f.edit(f.record.sessionId, { kind: 'save-copy', stateRevision: 1 })).code, 'STALE_DOCUMENT');
    await f.select('h1'); assert.equal((await f.change('再次修改 <&> 😀')).ok, true); await f.apply();
    assert.equal(value.draft.revision, 8); const catalog = await f.checkpoints.catalog(value.saveSource.current);
    assert.equal(catalog.groups.length, 1); assert.equal(catalog.groups[0]!.sessionId, f.record.sessionId); assert.equal(catalog.groups[0]!.draftRevision, 8);
    await f.unchanged(); f.control.review = async review => ({ reviewId: review.reviewId, decision: 'discard' });
    assert.equal((await f.runtime.workspace.requestClose((await f.read()).stateRevision)).status, 'closed');
    assert.equal(peerStore.isSessionActive(f.record.sessionId), false); assert.equal((await f.checkpoints.catalog()).groups[0]!.status, 'retired');
    assert.equal((await f.restore()).code, 'DRAFT_RECOVERY_UNAVAILABLE'); await f.unchanged();
    pass('after forcibly terminating the previous checkpoint writer, production IPC restores exact two-Text drafts with fresh identity, continues revision 8 in the same sequence, and discards without resurrecting old points');
  }, async (entry, privateRoot) => {
    const child = startChild('seed', app.getPath('userData'), entry, privateRoot);
    try { const value = await child.ready(); assert.equal(value.state, 'seeded'); return { sessionId: value.sessionId!, checkpointId: value.checkpointId!, resultHash: value.resultHash! }; }
    finally { await child.stop(); }
  });

  await use(async f => {
    f.control.path = undefined; assert.equal((await f.restore('file')).outcome, 'cancelled'); assert.equal(f.runtime.workspace.current, null);
    const wrong = join(f.project, 'copy.html'); await writeFile(wrong, original); f.control.path = wrong;
    assert.equal((await f.restore('file')).code, 'DRAFT_RECOVERY_UNAVAILABLE'); assert.equal(f.runtime.workspace.current, null);
    f.control.path = f.entry; assert.equal((await f.restore('file')).outcome, 'restored');
    assert.equal(f.current().preview.grant.root, join(f.project, 'pages')); await f.unchanged();
    assert.deepEqual(await readFile(wrong), original); assert.equal((await f.checkpoints.scan()).records.length, 1);
    pass('cancelled authorization writes nothing; an identical different file is rejected; single-file restore does not expand the grant to its parent project');
  });

  await use(async f => {
    await writeFile(f.entry, Buffer.from(original.toString().replace('2025-01-01', 'external version')));
    const external = await readFile(f.entry); assert.equal((await f.restore()).code, 'DRAFT_RECOVERY_UNAVAILABLE');
    assert.equal(f.runtime.workspace.current, null); assert.deepEqual(await readFile(f.entry), external);
    assert.equal((await f.checkpoints.scan()).records.length, 1); assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false);
    pass('an externally changed source is refused without installing Preview or overwriting external bytes and the original checkpoint remains available for review');
  });

  await use(async f => {
    const other = join(f.project, 'other.html'); await writeFile(other, original); f.control.path = other;
    assert.equal((await f.open()).outcome, 'opened'); const old = f.current();
    await f.select('h1'); await f.change('existing draft'); await f.apply(); const oldCandidate = old.draft.candidate;
    f.control.path = f.entry; assert.equal((await f.restore()).outcome, 'cancelled');
    assert.equal(f.current(), old); assert.equal(old.draft.candidate.resultHash, oldCandidate.resultHash); assert.equal(old.mapping.status, 'ready');
    assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false);
    f.control.review = async review => ({ reviewId: review.reviewId, decision: 'discard' });
    for (const fault of ['attached', 'sized', 'detached'] as const) {
      f.control.host = step => { if (step === fault) { f.control.host = () => {}; throw Error('test host failure'); } };
      assert.equal((await f.restore()).code, 'DOCUMENT_ACTIVATION_FAILED'); assert.equal(f.current(), old);
      assert.equal(old.input.snapshot().phase, 'idle'); assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false);
      assert.equal((await f.checkpoints.catalog()).groups.find(row => row.sessionId === old.checkpointSessionId)!.status, 'dirty');
    }
    f.control.host = () => {}; assert.equal((await f.restore()).outcome, 'restored'); assert.notEqual(f.current(), old);
    assert.equal((await f.checkpoints.catalog()).groups.find(row => row.sessionId === old.checkpointSessionId)!.status, 'retired');
    assert.deepEqual(Buffer.from(f.current().draft.candidate.bytes), expected); await f.unchanged(); assert.deepEqual(await readFile(other), original);
    pass('cancelled departure and native attachment/size/detachment failures retain the prior editable draft; successful retry retires only that old session before installing recovery');
  });

  await use(async f => {
    // Main prepares and checks the whole batch, including DOM-only restrictions,
    // before writing the first node. A pseudo-bearing second target rejects both.
    await writeFile(join(f.project, 'keep.css'), 'body{font:24px sans-serif}#date::before{content:"generated"}');
    assert.equal((await f.restore()).code, 'DRAFT_RESTORE_REJECTED'); assert.equal(f.runtime.workspace.current, null);
    assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false); assert.equal((await f.checkpoints.scan()).records.length, 1);
    assert.deepEqual(await readFile(f.entry), original);
    pass('a newly unsupported generated-content target rejects restoration before publishing a partial document, retaining the source and complete recovery evidence');
  });

  await use(async f => {
    let changed = false;
    f.control.host = step => { if (step === 'attached' && !changed) { changed = true; writeFileSync(f.entry, 'external after preparation'); } };
    const result = await f.restore(); assert.equal(result.code, 'DRAFT_RECOVERY_CONFLICT'); assert.equal(f.runtime.workspace.current, null);
    assert.equal(f.runtime.host.current, null); assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false);
    assert.equal((await readFile(f.entry, 'utf8')), 'external after preparation'); assert.equal((await f.checkpoints.scan()).records.length, 1);
    pass('source changes between candidate preparation and native installation are rechecked and the unpublished view is rolled back without writing HTML');
  });

  await use(async f => {
    const other = join(f.project, 'other.html'); await writeFile(other, original); f.control.path = other;
    await f.open(); const old = f.current(); await f.select('h1'); await f.change('retain old draft'); await f.apply();
    f.control.path = f.entry;
    f.control.review = async review => {
      // Deliberate low-level competing writer simulates evidence advancing while
      // a chooser/review is pending; normal documents also have an ownership gate.
      const source = await prepareDocument(outputRoot, f.entry, 100, new AbortController().signal);
      try {
        const candidate = await f.checkpoints.restoreLatest(f.record.sessionId, source.saveSource, source.mapping.source);
        const engine = createPatchEngine(source.mapping.source, digest, candidate.patches);
        const target = source.mapping.source.nodes.find(node => node.editable && node.decodedText === 'A & 😀')!;
        engine.apply({ identity: source.mapping.source.identity, baseHash: source.mapping.source.baseHash,
          nodeId: target.nodeId, expectedText: restoredTitle, newText: 'newer checkpoint' });
        assert.equal((await f.checkpoints.write(source.saveSource, source.mapping.source, engine.candidate, f.record.sessionId, 8)).status, 'persisted');
      } finally { await source.close(); }
      return { reviewId: review.reviewId, decision: 'discard' };
    };
    assert.equal((await f.restore()).code, 'DRAFT_CHECKPOINT_CHANGED'); assert.equal(f.current(), old); assert.equal(old.input.snapshot().phase, 'idle');
    const catalog = await f.checkpoints.catalog(); assert.equal(catalog.groups.find(row => row.sessionId === f.record.sessionId)!.draftRevision, 8);
    assert.equal(catalog.groups.find(row => row.sessionId === old.checkpointSessionId)!.status, 'dirty');
    assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false); await f.unchanged();
    pass('a newer checkpoint arriving during departure review cancels installation of the older candidate before retiring the active old draft');
  });

  await use(async f => {
    const other = join(f.project, 'other.html'); await writeFile(other, original); f.control.path = other;
    await f.open(); const old = f.current(); await f.select('h1'); await f.change('retained evidence'); await f.apply();
    const oldHash = old.draft.candidate.resultHash; f.control.path = f.entry;
    f.control.review = async review => ({ reviewId: review.reviewId, decision: 'discard' });
    let changed = false;
    f.control.host = step => { if (step === 'attached' && !changed) { changed = true; writeFileSync(f.entry, 'external before retirement settles'); } };
    const result = await f.restore(); assert.equal(result.code, 'DRAFT_RECOVERY_CONFLICT'); assert.equal(f.current(), old);
    assert.equal(f.runtime.host.current, old.preview.view); assert.equal(old.input.snapshot().phase, 'leaving');
    assert.equal(old.draft.candidate.resultHash, oldHash); assert.equal(result.state!.lastDeparture!.status, 'retired');
    assert.equal(result.state!.lastDeparture!.code, 'DRAFT_RECOVERY_CONFLICT'); assert.equal(result.state!.lastDeparture!.requiresReview, true);
    assert.equal((await f.open()).code, 'DOCUMENT_RECOVERY_REQUIRED'); assert.equal(f.checkpoints.isSessionActive(f.record.sessionId), false);
    assert.equal(await readFile(f.entry, 'utf8'), 'external before retirement settles'); assert.deepEqual(await readFile(other), original);
    pass('if recovery verification fails after the old retirement is confirmed, Main rolls back and retains that frozen old draft with the accurate retired status and recovery-conflict evidence');
  });

  if (process.platform === 'win32') await use(async f => {
    assert.equal((await f.restore()).outcome, 'restored'); const restored = f.current();
    const state = await f.read(); assert.equal(state.canSave, true);
    const result = await f.call(`haeWorkspace.save(${JSON.stringify(restored.id)},${state.stateRevision})`);
    assert.equal(result.outcome, 'saved'); assert.equal(result.ok, true); assert.deepEqual(await readFile(f.entry), expected);
    assert.notEqual(f.current().id, restored.id); assert.equal(f.current().draft.candidate.patches.length, 0);
    assert.equal(f.current().mapping.status, 'ready'); assert.equal((await f.checkpoints.catalog(f.current().saveSource.current)).groups[0]!.status, 'saved');
    f.control.review = async review => ({ reviewId: review.reviewId, decision: 'discard' });
    assert.equal((await f.restore()).code, 'DRAFT_RECOVERY_UNAVAILABLE'); assert.deepEqual(await readFile(f.entry), expected);
    await f.select('h1'); await f.change('post-save draft'); await f.apply(); assert.equal(f.current().draft.revision, 2);
    assert.deepEqual(await readFile(f.entry), expected);
    pass('explicit Windows Save writes the restored frozen bytes with backup and commit proof, rebuilds an editable baseline and prevents replay of the committed checkpoint');
  });
  else pending.push('Windows native Save after restoration');

  await writeFile(join(results, 'recovery.json'), JSON.stringify({ status: 'passed', passed, pending,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions }, null, 2));
}
void run().then(() => app.exit(0)).catch(async error => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'recovery.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
