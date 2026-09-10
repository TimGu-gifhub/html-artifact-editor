import { proofreadSnapshot } from '../helpers/proofread.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import type { WorkspaceDiff } from '../../src/contracts/source-diff.ts';
import { fixture, until, version } from '../draft-restore/fixture.ts';
import type { Fixture } from '../draft-restore/fixture.ts';
import { original, expected } from '../draft-restore/seed.ts';

registerSchemes(); app.enableSandbox(); app.on('before-quit', event => event.preventDefault());
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, 'source-diff-profile'));
const passed: string[] = []; const pending: string[] = [];
const pass = (value: string): void => { passed.push(value); console.log(`PASS: ${value}`); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const review = (diff: WorkspaceDiff) => ({ draftRevision: diff.draftRevision, candidateHash: diff.candidateHash });
async function readDiff(f: Fixture) {
  const value = (await f.read()).current!;
  return f.call(`haeWorkspace.readDiff(${JSON.stringify(value.id)},${value.input.draftRevision},${JSON.stringify(value.input.candidateHash)})`);
}
async function reviewedSave(f: Fixture, diff: WorkspaceDiff) {
  const state = await f.read();
  return f.call(`haeWorkspace.save(${JSON.stringify(state.current!.id)},${state.stateRevision},${JSON.stringify(review(diff))})`);
}
function rebuild(base: Uint8Array, diff: WorkspaceDiff): Buffer {
  const parts: Uint8Array[] = []; let end = 0;
  for (const change of diff.changes) {
    assert.deepEqual(Buffer.from(change.before.text), Buffer.from(base.subarray(change.before.startByte, change.before.endByte)));
    parts.push(base.subarray(end, change.before.startByte), Buffer.from(change.after.text)); end = change.before.endByte;
  }
  parts.push(base.subarray(end)); const candidate = Buffer.concat(parts); assert.equal(hash(candidate), diff.candidateHash); return candidate;
}
async function use(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(outputRoot, results); try { await run(f); } finally { await f.close(); }
}
async function run(): Promise<void> {
  await mkdir(results, { recursive: true }); await mkdir(app.getPath('userData'), { recursive: true }); await app.whenReady();
  await use(async f => {
    await f.open(); const before = f.current().input.snapshot(); const entries = await readdir(f.privateRoot); const chooses = f.control.chooses;
    const result = await readDiff(f); assert.equal(result.ok, true); assert.equal(result.documentId, f.current().id);
    assert.equal(result.diff!.candidateHash, hash(original)); assert.equal(result.diff!.baseHash, hash(original));
    assert.equal(result.diff!.unchangedBytes, original.length); assert.equal(result.diff!.changes.length, 0);
    assert.equal(f.current().input.snapshot().stateRevision, before.stateRevision); assert.equal(f.control.chooses, chooses);
    assert.deepEqual(await readdir(f.privateRoot), entries); await f.unchanged();
    assert.equal(await f.ui.webContents.executeJavaScript('haeWorkspace.readDiff("bad",1,"x").then(r=>r.code)'), 'INVALID_WORKSPACE_REQUEST');
    assert.deepEqual(await f.current().preview.contents.executeJavaScript('[typeof haeWorkspace,typeof ipcRenderer,typeof require]'), ['undefined', 'undefined', 'undefined']);
    pass('production IPC returns a clean Diff without changing revisions, invoking choosers, writing checkpoints or exposing authority to Preview');
  });

  await use(async f => {
    await f.restore(); const before = f.current().input.snapshot(); const entries = await readdir(f.privateRoot);
    const requests = await Promise.all([readDiff(f), readDiff(f)]); assert.ok(requests.every(value => value.ok));
    const diff = requests[0]!.diff!; assert.equal(diff.documentId, f.current().id); assert.equal(diff.draftRevision, 7);
    assert.deepEqual(diff, requests[1]!.diff); assert.equal(diff.changes.length, 2);
    assert.equal(diff.changes[0]!.before.text, 'A &amp; 😀'); assert.equal(diff.changes[0]!.after.text, '恢复 &lt;&amp;&gt; 🧪');
    assert.deepEqual(rebuild(original, diff), expected); assert.deepEqual(Buffer.from(f.current().draft.candidate.bytes), expected);
    assert.equal(f.current().input.snapshot().stateRevision, before.stateRevision); assert.deepEqual(await readdir(f.privateRoot), entries); await f.unchanged();
    pass('restored drafts expose both complete raw UTF-8 replacements and reconstruct the exact frozen candidate, including entity encoding, BOM and CRLF');
  });

  await use(async f => {
    await f.restore(); await f.select('h1'); await f.change('not yet applied');
    const result = await readDiff(f); assert.equal(result.ok, true); const diff = result.diff!;
    assert.equal(proofreadSnapshot(result.state!).current!.input.hasUnappliedInput, true); assert.deepEqual(rebuild(original, diff), expected);
    if (process.platform === 'win32') assert.equal((await reviewedSave(f, diff)).code, 'UNAPPLIED_INPUT');
    const value = (await f.read()).current!;
    assert.equal((await f.edit(value.id, { kind: 'change', value: { ...version(value.input), inputRevision: value.input.input!.revision + 1, newText: '组合输入', composing: true } })).ok, true);
    assert.equal((await readDiff(f)).diff!.candidateHash, diff.candidateHash);
    if (process.platform === 'win32') assert.equal((await reviewedSave(f, diff)).code, 'INPUT_COMPOSING');
    await f.unchanged();
    pass('Diff shows applied bytes while keeping pending/composing input explicit; reviewed Save still rejects unapplied or composing input (flags, not real IME acceptance)');
  });

  await use(async f => {
    await f.open(); await f.select('h1'); await f.change('first draft'); await f.apply(); const prior = (await readDiff(f)).diff!;
    await f.change('second draft <&> 🧪'); await f.apply(); const state = await f.read(); const entries = await readdir(f.privateRoot);
    assert.equal((await f.call(`haeWorkspace.readDiff(${JSON.stringify(state.current!.id)},${prior.draftRevision},${JSON.stringify(prior.candidateHash)})`)).code, 'STALE_SOURCE_DIFF');
    assert.equal((await reviewedSave(f, prior)).code, 'STALE_SOURCE_DIFF');
    assert.deepEqual(await readdir(f.privateRoot), entries); const fresh = (await readDiff(f)).diff!;
    assert.equal(fresh.changes.length, 1); assert.equal(fresh.changes[0]!.before.text, 'A &amp; 😀'); assert.equal(fresh.changes[0]!.after.text, 'second draft &lt;&amp;&gt; 🧪');
    assert.deepEqual(rebuild(original, fresh), Buffer.from(f.current().draft.candidate.bytes)); await f.unchanged();
    pass('new Apply invalidates an earlier Diff and Save review before any save transaction, while a new Diff shows the net original-to-latest replacement');
  });

  await use(async f => {
    await f.open(); const initial = (await readDiff(f)).diff!; await f.select('h1'); await f.change('temporary'); await f.apply();
    await f.change('A & 😀'); await f.apply(); const clean = (await readDiff(f)).diff!;
    assert.equal(clean.candidateHash, initial.candidateHash); assert.notEqual(clean.draftRevision, initial.draftRevision);
    assert.equal(clean.changes.length, 0); assert.deepEqual(rebuild(original, clean), original);
    assert.equal((await reviewedSave(f, initial)).code, 'STALE_SOURCE_DIFF'); await f.unchanged();
    pass('returning to the original text preserves exact source spelling and produces an empty Diff; an older review cannot bypass the new draft revision even with the same hash');
  });

  await use(async f => {
    await f.restore(); const diff = (await readDiff(f)).diff!; const id = f.current().id;
    f.ui.webContents.forcefullyCrashRenderer(); await until(() => !f.runtime.connected, 'Diff renderer revocation');
    await f.runtime.reloadUI(); assert.equal((await f.read()).current!.id, id); assert.deepEqual((await readDiff(f)).diff, diff); await f.unchanged();
    f.control.review = async value => ({ reviewId: value.reviewId, decision: 'discard' }); await f.open();
    assert.equal((await f.call(`haeWorkspace.readDiff(${JSON.stringify(id)},${diff.draftRevision},${JSON.stringify(diff.candidateHash)})`)).code, 'STALE_DOCUMENT');
    pass('renderer reconnection reads the retained document Diff, while replacing the document rejects its old Diff identity without misattributing it to the new window state');
  });

  if (process.platform === 'win32') {
    await use(async f => {
      await f.restore(); const old = f.current(); const diff = (await readDiff(f)).diff!; const bytes = rebuild(original, diff);
      const result = await reviewedSave(f, diff); assert.equal(result.ok, true, result.code ?? 'save failed'); assert.equal(result.outcome, 'saved');
      assert.deepEqual(await readFile(f.entry), bytes); assert.deepEqual(bytes, expected); assert.notEqual(f.current().id, old.id);
      const clean = (await readDiff(f)).diff!; assert.equal(clean.changes.length, 0); assert.equal(clean.baseHash, diff.candidateHash);
      await f.select('#date'); await f.change('post-save date'); await f.apply(); const next = (await readDiff(f)).diff!;
      assert.equal(next.changes[0]!.before.text, '2026-09-09'); assert.equal(next.baseHash, hash(expected));
      assert.deepEqual(rebuild(expected, next), Buffer.from(f.current().draft.candidate.bytes)); assert.deepEqual(await readFile(f.entry), expected);
      pass('reviewed Windows Save writes exactly the bytes reconstructed from that Diff, builds a clean new baseline, and later Diff uses fresh ranges in the saved source');
    });
    await use(async f => {
      await f.restore(); const diff = (await readDiff(f)).diff!; const old = f.current(); await writeFile(f.entry, 'external current contents');
      const result = await reviewedSave(f, diff); assert.equal(result.ok, false); assert.equal(proofreadSnapshot(result.state!).lastSave!.status, 'failed');
      assert.equal(f.current(), old); assert.equal(await readFile(f.entry, 'utf8'), 'external current contents');
      assert.equal((await readDiff(f)).diff!.candidateHash, diff.candidateHash); assert.deepEqual(Buffer.from(old.draft.candidate.bytes), expected);
      pass('a matching Diff review does not bypass the original-file conflict check; external bytes and the applied draft remain intact on failed Save');
    });
  } else pending.push('Windows reviewed Save and external-file conflict');

  await writeFile(join(results, 'source-diff.json'), JSON.stringify({ status: 'passed', passed, pending,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions }, null, 2));
}
void run().then(() => app.exit(0)).catch(async error => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'source-diff.json'), JSON.stringify({ status: 'failed', passed, error: String(error) }, null, 2)); app.exit(1);
});
