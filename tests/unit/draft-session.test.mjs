import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createDraftSession } from '../../src/main/draft/session.ts';
import { freezeCandidate } from '../../src/main/draft/prepare.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceIdentity = { projectId: '00000000-0000-4000-8000-000000000001',
  documentId: '00000000-0000-4000-8000-000000000002', generation: 1 };
const baseline = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><p>B</p>');
const prepare = async (_out, source, current, change) => {
  const engine = createPatchEngine(source, hash, current.patches);
  assert.equal(engine.candidate.resultHash, current.resultHash);
  return freezeCandidate(engine.apply(change));
};
function setup(runPrepare = prepare) {
  const source = createSourceIndex(baseline, sourceIdentity, hash);
  const target = source.nodes.find((node) => node.decodedText === 'A & 😀');
  const identity = { preview: { version: 1, sessionId: sourceIdentity.projectId, generation: 1, mode: 'proofread' },
    documentId: sourceIdentity.documentId, baseHash: source.baseHash };
  let text = target.decodedText;
  let calls = 0;
  const mapping = { source, identity, status: 'ready', selection: { identity, revision: 2, nodeId: target.nodeId },
    applyText: async (selection, expected, next) => {
      calls++;
      if (mapping.status !== 'ready' || mapping.selection.revision !== selection.revision || mapping.selection.nodeId !== selection.nodeId) return 'rejected';
      assert.equal(text, expected);
      text = next;
      mapping.selection = { ...selection, revision: selection.revision + 1 };
      return 'applied';
    },
  };
  const session = createDraftSession('unused', mapping, runPrepare);
  const input = (newText) => ({ selection: mapping.selection, draftRevision: session.revision, newText });
  return { session, mapping, input, target, get text() { return text; }, get calls() { return calls; } };
}
test('drafts publish only after acknowledged mutation; no-op, merging, empty/refill and baseline restore preserve bytes', async () => {
  const f = setup();
  const initial = f.session.candidate;
  assert.deepEqual(await f.session.apply(f.input('A & 😀')), { changed: false, draftRevision: 1 });
  assert.equal(f.session.candidate, initial);
  const oldSelection = f.mapping.selection;
  await f.session.apply(f.input('<script>新😀</script>\r\n行二'));
  assert.equal(f.text, '<script>新😀</script>\n行二');
  assert.equal(f.session.revision, 2);
  assert.notEqual(f.mapping.selection.revision, oldSelection.revision);
  assert.equal(f.session.candidate.patches.length, 1);
  assert.ok(Buffer.from(f.session.candidate.bytes).includes(Buffer.from('&lt;script&gt;新😀&lt;/script&gt;\r\n行二')));
  await f.session.apply(f.input(''));
  assert.equal(f.text, '');
  await f.session.apply(f.input('再填'));
  await f.session.apply(f.input('A & 😀'));
  assert.equal(f.session.candidate.patches.length, 0);
  assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
  assert.deepEqual(Buffer.from(f.mapping.source.bytes), baseline);
});
test('invalid text, schema, identities and stale draft/selection reject without publishing or mutating', async () => {
  const f = setup();
  const initial = f.session.candidate;
  const input = f.input('C');
  for (const bad of [{ ...input, path: 'x' }, { ...input, draftRevision: 0 },
    { ...input, selection: { ...input.selection, revision: 1 } },
    { ...input, selection: { ...input.selection, nodeId: 'n99999' } },
    { ...input, selection: { ...input.selection, identity: { ...input.selection.identity, baseHash: 'b'.repeat(64) } } },
    f.input('\0'), f.input('\ud800'), f.input('x'.repeat(65537))]) {
    await assert.rejects(f.session.apply(bad));
    assert.equal(f.session.candidate, initial);
    assert.equal(f.session.phase, 'idle');
  }
  assert.equal(f.calls, 0);
});
test('preparation snapshots the request and blocks a second command; moved selection cannot receive stale input', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = setup(async (...args) => { await barrier; return prepare(...args); });
  const command = f.input('C');
  const promise = f.session.apply(command);
  await assert.rejects(f.session.apply(f.input('D')), /DRAFT_UNAVAILABLE/);
  command.newText = 'mutated after dispatch';
  f.mapping.selection = { ...f.mapping.selection, revision: 3 };
  release();
  await assert.rejects(promise, /STALE_SELECTION/);
  assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
  assert.equal(f.text, 'A & 😀');
  assert.equal(f.session.phase, 'idle');
});
test('caller mutation after dispatch cannot replace the prepared text', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = setup(async (...args) => { await barrier; return prepare(...args); });
  const command = f.input('C');
  const promise = f.session.apply(command);
  command.newText = 'unexpected'; command.selection = null;
  release(); await promise;
  assert.equal(f.text, 'C');
});
test('closing during preparation cancels before mutation and retains the previous candidate', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = setup(async (...args) => { await barrier; return prepare(...args); });
  const promise = f.session.apply(f.input('C'));
  f.session.close(); release();
  await assert.rejects(promise, /DRAFT_PREPARE_CANCELLED/);
  assert.equal(f.calls, 0);
  assert.equal(f.session.phase, 'closed');
  assert.deepEqual(Buffer.from(f.session.candidate.bytes), baseline);
});
test('unknown or thrown mutation outcomes retain both candidate versions and prohibit blind retry', async () => {
  for (const throws of [false, true]) {
    const f = setup();
    await f.session.apply(f.input('known draft'));
    const known = f.session.candidate;
    f.mapping.applyText = async () => { if (throws) throw new Error('lost renderer'); return 'unknown'; };
    await assert.rejects(f.session.apply(f.input('uncertain draft')), /DRAFT_OUTCOME_UNKNOWN/);
    assert.equal(f.session.phase, 'uncertain');
    assert.equal(f.session.candidate, known);
    assert.equal(f.session.uncertainCandidate.patches[0].newText, 'uncertain draft');
    await assert.rejects(f.session.apply(f.input('retry')), /DRAFT_UNAVAILABLE/);
    f.session.close();
    assert.equal(f.session.phase, 'uncertain');
    assert.equal(f.session.uncertainCandidate.patches[0].newText, 'uncertain draft');
  }
});
test('worker failures preserve prior drafts; externally mutable byte views cannot corrupt state', async () => {
  let fail = false;
  const f = setup((...args) => { if (fail) throw new Error('DRAFT_PREPARE_TIMEOUT'); return prepare(...args); });
  await f.session.apply(f.input('C'));
  const known = f.session.candidate;
  known.bytes.fill(0); known.patches[0].replacementBytes.fill(0);
  assert.notEqual(known.bytes[0], 0);
  assert.equal(Buffer.from(known.patches[0].replacementBytes).toString(), 'C');
  fail = true;
  await assert.rejects(f.session.apply(f.input('D')), /DRAFT_PREPARE_TIMEOUT/);
  assert.equal(f.session.candidate, known);
  assert.equal(f.text, 'C');
});
test('rehydrated engine validates prior patches before applying a new command', async () => {
  const f = setup();
  await f.session.apply(f.input('C'));
  const patch = f.session.candidate.patches[0];
  assert.throws(() => createPatchEngine(f.mapping.source, hash, [{ ...patch, startByte: patch.startByte - 1 }]), /PATCH_SOURCE_MISMATCH/);
  assert.throws(() => createPatchEngine(f.mapping.source, hash, [{ ...patch, replacementBytes: Buffer.from('<b>forged</b>') }]), /PATCH_ENCODING_MISMATCH/);
  assert.equal(createPatchEngine(f.mapping.source, hash, [patch]).candidate.resultHash, f.session.candidate.resultHash);
});
test('cancelled copy selection performs no write and retains drafts; successful copy keeps original baseline', async () => {
  const f = setup(); await f.session.apply(f.input('C'));
  const candidate = f.session.candidate; const revision = f.session.revision;
  let writes = 0;
  const writer = { directory: 'unused', write: async (path, value) => {
    writes++; assert.deepEqual(value, candidate.bytes);
    return Object.freeze({ status: 'created', path, expectedHash: hash(value), code: null });
  } };
  assert.equal(await f.session.saveCopy(async () => undefined, writer), null);
  assert.equal(writes, 0); assert.equal(f.session.phase, 'idle');
  assert.equal((await f.session.saveCopy(async () => 'new.html', writer)).status, 'created');
  assert.equal(writes, 1); assert.equal(f.session.candidate, candidate); assert.equal(f.session.revision, revision);
  assert.equal(f.session.candidate.patches.length, 1);
});
test('copy chooser/writer freeze editing and duplicate save; close during chooser cannot write', async () => {
  const f = setup(); let release; let writes = 0;
  const writer = { directory: 'unused', write: async () => { writes++; throw new Error('not reached'); } };
  const pending = f.session.saveCopy(() => new Promise((resolve) => { release = resolve; }), writer);
  assert.equal(f.session.phase, 'saving');
  await assert.rejects(f.session.apply(f.input('C')), /DRAFT_UNAVAILABLE/);
  await assert.rejects(f.session.saveCopy(async () => 'another.html', writer), /DRAFT_UNAVAILABLE/);
  f.session.close(); release('new.html'); assert.equal(await pending, null);
  assert.equal(writes, 0); assert.equal(f.session.phase, 'closed');
});
test('failed copy preserves drafts for another destination; unknown or thrown writes freeze evidence and retry', async () => {
  for (const status of ['failed', 'unknown', 'throw']) {
    const f = setup(); await f.session.apply(f.input('C'));
    const candidate = f.session.candidate;
    const writer = { directory: 'unused', write: async (path, value) => {
      if (status === 'throw') throw new Error('lost completion');
      return Object.freeze({ status, path, expectedHash: hash(value), code: 'NEW_FILE_WRITE_FAILED' });
    } };
    const outcome = await f.session.saveCopy(async () => 'new.html', writer);
    assert.equal(outcome.status, status === 'throw' ? 'unknown' : status);
    assert.equal(f.session.candidate, candidate);
    assert.equal(f.session.phase, status === 'failed' ? 'idle' : 'uncertain');
    if (status !== 'failed') {
      await assert.rejects(f.session.saveCopy(async () => 'retry.html', writer), /DRAFT_UNAVAILABLE/);
      await assert.rejects(f.session.apply(f.input('D')), /DRAFT_UNAVAILABLE/);
      f.session.close(); assert.equal(f.session.phase, 'uncertain'); assert.equal(f.session.lastCopy, outcome);
    }
  }
});

test('original Save exclusively freezes the current byte candidate and blocks Apply or duplicate Save', async () => {
  const f = setup(); await f.session.apply(f.input('保存 🧪'));
  const candidate = f.session.candidate; let release;
  const pending = f.session.saveOriginal(async value => {
    assert.equal(value, candidate); const bytes = value.bytes; bytes.fill(0); assert.notDeepEqual(value.bytes, bytes);
    await new Promise(done => { release = done; });
    return { status: 'failed', code: 'FILE_CHANGED', requiresReview: false };
  });
  assert.equal(f.session.phase, 'saving');
  await assert.rejects(f.session.apply(f.input('late edit')), /DRAFT_UNAVAILABLE/);
  await assert.rejects(f.session.saveOriginal(async () => { assert.fail('duplicate writer'); }), /DRAFT_UNAVAILABLE/);
  release(); await pending; assert.equal(f.session.phase, 'idle'); assert.equal(f.session.candidate, candidate);
});

test('committed or uncertain original Save retains old baseline/candidate and forbids editing against obsolete offsets', async () => {
  for (const [status, requiresReview, expectedPhase] of [['committed', false, 'uncertain'], ['unknown', false, 'uncertain'],
    ['failed', true, 'uncertain'], ['failed', false, 'idle'], ['cancelled', false, 'idle']]) {
    const f = setup(); await f.session.apply(f.input('保存 🧪')); const candidate = f.session.candidate;
    const value = await f.session.saveOriginal(async () => ({ status, code: null, requiresReview }));
    assert.equal(value.status, status); assert.equal(f.session.phase, expectedPhase); assert.equal(f.session.candidate, candidate);
    assert.deepEqual(Buffer.from(f.mapping.source.bytes), baseline);
    if (expectedPhase === 'uncertain') {
      assert.equal(f.session.uncertainCandidate, candidate);
      await assert.rejects(f.session.apply(f.input('late edit')), /DRAFT_UNAVAILABLE/);
      f.session.close(); assert.equal(f.session.phase, 'uncertain');
    }
  }
});

test('an unexpected original-save exception is uncertain and cannot authorize a retry', async () => {
  const f = setup(); await f.session.apply(f.input('保存 🧪')); const candidate = f.session.candidate;
  const result = await f.session.saveOriginal(async () => { throw new Error('lost completion'); });
  assert.equal(result.status, 'unknown'); assert.equal(result.requiresReview, true); assert.equal(f.session.candidate, candidate);
  await assert.rejects(f.session.saveOriginal(async () => { assert.fail('blind retry'); }), /DRAFT_UNAVAILABLE/);
});
