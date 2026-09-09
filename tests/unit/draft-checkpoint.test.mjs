import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isDraftCheckpoint, isStoredTextIntent } from '../../src/contracts/draft-checkpoint.ts';
import { captureTextIntents, rebuildCheckpoint } from '../../src/core/history/checkpoint.ts';
import { buildTextIntentCandidate, createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { digest } from '../../src/platform/storage-files.ts';

const bytes = Buffer.from('\ufeff<!doctype html>\r\n<h1>A &amp; 😀</h1><p>重复</p><p>重复</p><pre>\r\n行一\r\n行二</pre><!-- keep --><script>const n=41</script>');
const expected = Buffer.from('\ufeff<!doctype html>\r\n<h1>新 &lt;&amp;&gt; 🧪</h1><p>修改第一处</p><p>重复</p><pre>\r\n\r\n新行\r\n&lt;字&gt; &amp; 😀</pre><!-- keep --><script>const n=41</script>');
function fixture() {
  const source = createSourceIndex(bytes, { projectId: 'original', documentId: 'first', generation: 1 }, digest);
  const engine = createPatchEngine(source, digest);
  for (const [oldText, newText] of [['A & 😀', '新 <&> 🧪'], ['重复', '修改第一处'], ['行一\n行二', '\n新行\n<字> & 😀']]) {
    const node = source.nodes.find(node => node.decodedText === oldText);
    engine.apply({ identity: source.identity, baseHash: source.baseHash, nodeId: node.nodeId, expectedText: oldText, newText });
  }
  const intents = captureTextIntents(source, engine.candidate, digest);
  const checkpoint = { version: 1, checkpointId: randomUUID(), sessionId: randomUUID(), draftRevision: 4, createdAt: 1,
    targetKey: 'a'.repeat(64), name: '自制报告.html', identity: { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' },
    baseHash: source.baseHash, baseSize: bytes.length, resultHash: engine.candidate.resultHash, intents };
  return { source, engine, intents, checkpoint };
}

test('logical draft checkpoints rebuild identical bytes under a fresh source identity, including entities, duplicate text and pre leading LF', () => {
  const { source, engine, intents, checkpoint } = fixture(); assert.deepEqual(Buffer.from(engine.candidate.bytes), expected);
  assert.ok(Object.isFrozen(intents) && intents.every(Object.isFrozen));
  for (const intent of intents) assert.deepEqual(Object.keys(intent).sort(), ['contextFingerprint', 'expectedText', 'newText', 'nodeId', 'rawSliceHash']);
  const fresh = createSourceIndex(bytes, { projectId: 'reopened', documentId: 'second', generation: 9 }, digest);
  const rebuilt = rebuildCheckpoint(fresh, JSON.parse(JSON.stringify(checkpoint)), digest);
  assert.deepEqual(Buffer.from(rebuilt.bytes), expected); assert.deepEqual(rebuilt.identity, fresh.identity);
  assert.notDeepEqual(rebuilt.identity, source.identity); assert.deepEqual(Buffer.from(source.bytes), bytes);
  for (const patch of rebuilt.patches) assert.deepEqual(patch.identity, fresh.identity);
  const copy = rebuilt.bytes; copy.fill(0); assert.deepEqual(Buffer.from(rebuilt.bytes), expected);
});

test('recovery rejects forged locations, contexts, old text, duplicate targets, unsupported script and changed baselines', () => {
  const { source, intents, checkpoint } = fixture(); const one = intents[0];
  const script = source.nodes.find(node => node.parentTag === 'script');
  const bad = [[{ ...one, startByte: 1 }], [{ ...one, rawSliceHash: 'b'.repeat(64) }], [{ ...one, contextFingerprint: 'b'.repeat(64) }],
    [{ ...one, expectedText: 'wrong' }], [one, one], [{ ...one, nodeId: script.nodeId, expectedText: script.decodedText,
      rawSliceHash: script.rawSliceHash, contextFingerprint: script.contextFingerprint }]];
  for (const value of bad) assert.throws(() => buildTextIntentCandidate(source, value, digest));
  const changed = createSourceIndex(Buffer.from(bytes.toString().replace('const n=41', 'const n=42')),
    { projectId: 'p2', documentId: 'd2', generation: 2 }, digest);
  assert.throws(() => rebuildCheckpoint(changed, checkpoint, digest), /DRAFT_CHECKPOINT_MISMATCH/);
  assert.throws(() => rebuildCheckpoint(source, { ...checkpoint, resultHash: 'c'.repeat(64) }, digest), /DRAFT_CHECKPOINT_MISMATCH/);
});

test('recovery enforces canonical Unicode/text budgets and preserves a clean snapshot when all edits return to baseline', () => {
  const { source, intents } = fixture(); const one = intents[0];
  for (const newText of ['\0', '\ud800', 'x\ry', 'x'.repeat(128 * 1024 + 1), one.expectedText]) {
    assert.throws(() => buildTextIntentCandidate(source, [{ ...one, newText }], digest));
  }
  const engine = createPatchEngine(source, digest); const target = source.nodes.find(node => node.decodedText === 'A & 😀');
  for (const [expectedText, newText] of [['A & 😀', 'B'], ['B', 'C'], ['C', 'A & 😀']]) {
    engine.apply({ identity: source.identity, baseHash: source.baseHash, nodeId: target.nodeId, expectedText, newText });
  }
  assert.deepEqual(captureTextIntents(source, engine.candidate, digest), []);
  assert.deepEqual(Buffer.from(buildTextIntentCandidate(source, [], digest).bytes), bytes);
});

test('checkpoint schema is exact and does not admit paths, offsets, unknown versions, duplicate targets or oversized intent arrays', () => {
  const { checkpoint, intents } = fixture(); assert.ok(isDraftCheckpoint(checkpoint));
  for (const value of [{ ...checkpoint, version: 2 }, { ...checkpoint, path: 'report.html' }, { ...checkpoint, draftRevision: 0 },
    { ...checkpoint, identity: { ...checkpoint.identity, path: 'report.html' } }, { ...checkpoint, sessionId: '../outside' },
    { ...checkpoint, intents: [intents[0], intents[0]] }, { ...checkpoint, intents: Array(1001).fill(intents[0]) },
    { ...checkpoint, intents: [{ ...intents[0], offset: 1 }] }]) assert.equal(isDraftCheckpoint(value), false);
  assert.equal(isStoredTextIntent({ ...intents[0], nodeId: 'n100000' }), false);
});
