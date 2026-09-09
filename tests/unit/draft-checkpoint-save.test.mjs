import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';
import { digest } from '../../src/platform/storage-files.ts';

const win = { skip: process.platform !== 'win32', timeout: 15000 };
const original = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><!-- preserve -->');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>已保存 &lt;&amp;&gt; 🧪</h1><!-- preserve -->');
async function fixture(step = async () => {}) {
  const base = resolve('test-results'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'checkpoint-save-'));
  const project = join(root, 'project'); const draftRoot = join(root, 'recovery'); const saveRoot = draftRoot;
  await mkdir(project); await mkdir(draftRoot); const entry = join(project, 'report.html'); await writeFile(entry, original);
  const source = await openSaveSource(entry, original); const sessionId = randomUUID();
  const index = createSourceIndex(original, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const node = index.nodes.find(node => node.decodedText === 'A & 😀');
  const candidate = createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash,
    nodeId: node.nodeId, expectedText: node.decodedText, newText: '已保存 <&> 🧪' });
  assert.deepEqual(Buffer.from(candidate.bytes), expected);
  const saves = await createSavePreparationStore(saveRoot, step, await createWindowsReplacer(resolve('out/native/ReplaceHelper.exe')));
  const drafts = await createDraftCheckpointStore(draftRoot, undefined, saves);
  return { root, entry, source, index, candidate, sessionId, saves, drafts, draftRoot, saveRoot };
}

test('a checkpoint persisted before or after actual Save is identified by the exact committed version and cannot be replayed after restart', win, async () => {
  for (const timing of ['before', 'after']) {
    const f = await fixture(); let checkpoint;
    const write = () => f.drafts.write(f.source, f.index, f.candidate, f.sessionId, 2);
    if (timing === 'before') checkpoint = await write();
    const prepared = await f.saves.prepare(f.source, f.candidate); assert.equal(prepared.status, 'prepared');
    assert.equal((await prepared.commit()).status, 'committed');
    if (timing === 'after') checkpoint = await write(); assert.equal(checkpoint.status, 'persisted');
    const source = await openSaveSource(f.entry, expected);
    const saves = await createSavePreparationStore(f.saveRoot); const drafts = await createDraftCheckpointStore(f.draftRoot, undefined, saves);
    assert.equal((await drafts.inspect(checkpoint.checkpointId, source.current)).state, 'committed-matches');
    const index = createSourceIndex(expected, { projectId: 'new', documentId: 'saved', generation: 3 }, digest);
    await assert.rejects(drafts.restoreCandidate(checkpoint.checkpointId, source, index), /DRAFT_ALREADY_SAVED/);
    await writeFile(f.entry, expected); const rewritten = await openSaveSource(f.entry, expected);
    assert.equal((await drafts.inspect(checkpoint.checkpointId, rewritten.current)).state, 'candidate-on-disk');
    await assert.rejects(drafts.restoreCandidate(checkpoint.checkpointId, rewritten, index), /DRAFT_RECOVERY_CONFLICT/);
    assert.deepEqual(await readFile(f.entry), expected);
  }
});

test('a replacement without committed evidence never retires a checkpoint merely because candidate bytes are on disk', win, async () => {
  const f = await fixture(async step => { if (step === 'native-replaced') throw new Error('lost commit acknowledgement'); });
  const checkpoint = await f.drafts.write(f.source, f.index, f.candidate, f.sessionId, 2); assert.equal(checkpoint.status, 'persisted');
  const prepared = await f.saves.prepare(f.source, f.candidate); assert.equal(prepared.status, 'prepared');
  assert.equal((await prepared.commit()).status, 'unknown'); const source = await openSaveSource(f.entry, expected);
  assert.equal((await f.drafts.inspect(checkpoint.checkpointId, source.current)).state, 'candidate-on-disk');
  await assert.rejects(f.drafts.restoreCandidate(checkpoint.checkpointId, source, f.index), /DRAFT_RECOVERY_CONFLICT/);
  assert.equal((await f.saves.scan()).locked, true); assert.deepEqual(await readFile(f.entry), expected);
});
