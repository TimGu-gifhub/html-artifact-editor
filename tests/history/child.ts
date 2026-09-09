import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { prepareDocument } from '../../src/main/workspace/document.ts';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { requireEditorProfile } from '../../src/platform/editor-profile.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';

const [mode, profile, entry, privateRoot, recoveryId] = process.argv.slice(2);
if (!profile || !entry || !privateRoot || !['seed', 'restore'].includes(mode ?? '')) throw Error('Invalid history child arguments');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
app.on('before-quit', event => event.preventDefault());
void app.whenReady().then(async () => {
  requireEditorProfile(); const store = await createDraftCheckpointStore(privateRoot);
  const report = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  if (mode === 'seed') {
    const bytes = await readFile(entry); const source = await openSaveSource(entry, bytes); const sessionId = randomUUID();
    const history = createTextHistory(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
    const node = history.source.nodes.find(node => node.parentTag === 'h1')!;
    for (const text of ['B', 'C']) history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
      nodeId: node.nodeId, expectedText: history.textFor(node.nodeId)!, newText: text }));
    history.commit(history.prepareMove('undo'));
    const result = await store.write(source, history.source, history.candidate, sessionId, history.revision, history.capture());
    assert.equal(result.status, 'persisted'); report({ state: 'seeded', sessionId, revision: history.revision });
    setInterval(() => {}, 1000); // Parent kills this process after its sealed point.
  } else {
    const document = await prepareDocument(resolve(__dirname, '..'), entry, 1, new AbortController().signal, store, recoveryId);
    try {
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'B');
      assert.equal(document.history!.summary().redoCount, 1);
      const state = document.input.snapshot(); await document.input.history({ stateRevision: state.stateRevision, draftRevision: state.draftRevision, direction: 'redo' });
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'C');
      assert.equal((await document.persistence!.settle()).status, 'persisted');
      report({ state: 'restored', revision: document.draft.revision, ...document.history!.summary() });
    } finally { await document.close(); }
    app.exit(0);
  }
}).catch(error => { console.error(error); app.exit(1); });
