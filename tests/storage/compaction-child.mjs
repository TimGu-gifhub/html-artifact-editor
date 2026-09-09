import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const [privateRoot, entry, stage] = process.argv.slice(2);
const bytes = await readFile(entry); const source = await openSaveSource(entry, bytes); const sessionId = randomUUID();
const h = createTextHistory(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
const store = await createDraftCheckpointStore(privateRoot, async step => {
  if (step === stage) { process.send({ stage, sessionId }); await new Promise(() => {}); }
});
store.claimSession(sessionId);
const node = h.source.nodes.find(node => node.parentTag === 'h1');
for (const text of ['B', 'C', 'D']) {
  h.commit(h.prepareEdit({ identity: h.source.identity, baseHash: h.source.baseHash, nodeId: node.nodeId,
    expectedText: h.textFor(node.nodeId), newText: text }));
  const result = await store.write(source, h.source, h.candidate, sessionId, h.revision, h.capture());
  if (result.status !== 'persisted') throw Error(result.code);
}
throw Error('Expected compaction hook was not reached');
