import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { createPatchEngine } from '../../src/core/patch/engine.ts';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const [privateRoot, entry, sessionId, stage] = process.argv.slice(2);
const bytes = await readFile(entry); const source = await openSaveSource(entry, bytes);
const index = createSourceIndex(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
const target = index.nodes.find(node => node.decodedText === 'A & 😀');
const candidate = createPatchEngine(index, digest).apply({ identity: index.identity, baseHash: index.baseHash,
  nodeId: target.nodeId, expectedText: target.decodedText, newText: '进程终止前的新草稿 🧪' });
// Keep the actual writer alive at a private-file boundary until its parent kills it.
const keepAlive = setInterval(() => {}, 1000);
try {
  const store = await createDraftCheckpointStore(privateRoot, async step => {
    if (step === stage) { process.send({ stage }); await new Promise(() => {}); }
  });
  const result = await store.write(source, index, candidate, sessionId, 3);
  throw new Error(`Writer missed barrier: ${result.status} ${result.code}`);
} finally { clearInterval(keepAlive); }
