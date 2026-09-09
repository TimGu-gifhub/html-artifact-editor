import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

export const original = Buffer.from('\ufeff<!doctype html>\r\n<html><head><meta charset="utf-8"><title>Recovery fixture</title><link rel="stylesheet" href="../keep.css"></head><body><h1>A &amp; 😀</h1><p id="date">2025-01-01</p><!-- keep exact bytes --></body></html>');
export const css = Buffer.from('body{font:24px sans-serif;padding:20px;color:rgb(12,34,56)}');
export const restoredTitle = '恢复 <&> 🧪';
export const restoredDate = '2026-09-09';
export const expected = Buffer.from(original.toString().replace('A &amp; 😀', '恢复 &lt;&amp;&gt; 🧪').replace('2025-01-01', restoredDate));
export async function seedCheckpoint(entry: string, privateRoot: string): Promise<{ sessionId: string; checkpointId: string; resultHash: string }> {
  const sessionId = randomUUID(); const bytes = await readFile(entry);
  const index = createSourceIndex(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
  const engine = createPatchEngine(index, digest);
  for (const [expectedText, newText] of [['A & 😀', restoredTitle], ['2025-01-01', restoredDate]] as const) {
    const node = index.nodes.find(value => value.editable && value.decodedText === expectedText)!;
    engine.apply({ identity: index.identity, baseHash: index.baseHash, nodeId: node.nodeId, expectedText, newText });
  }
  const source = await openSaveSource(entry, bytes); const checkpoints = await createDraftCheckpointStore(privateRoot);
  const result = await checkpoints.write(source, index, engine.candidate, sessionId, 7);
  assert.equal(result.status, 'persisted'); assert.deepEqual(Buffer.from(engine.candidate.bytes), expected);
  return { sessionId, checkpointId: result.checkpointId!, resultHash: result.resultHash };
}
