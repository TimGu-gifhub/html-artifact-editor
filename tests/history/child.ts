import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { prepareDocument } from '../../src/main/workspace/document.ts';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { requireEditorProfile } from '../../src/platform/editor-profile.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';

const [mode, profile, entry, privateRoot, recoveryId] = process.argv.slice(2);
if (!profile || !entry || !privateRoot || !['seed', 'restore', 'seed-saved', 'restore-saved'].includes(mode ?? '')) throw Error('Invalid history child arguments');
registerSchemes(); app.enableSandbox(); app.setPath('userData', profile);
app.on('before-quit', event => event.preventDefault());
void app.whenReady().then(async () => {
  requireEditorProfile(); const outputRoot = resolve(__dirname, '..');
  const saves = await createSavePreparationStore(privateRoot, undefined, mode === 'seed-saved'
    ? await createWindowsReplacer(join(outputRoot, 'native/ReplaceHelper.exe')) : undefined);
  const store = await createDraftCheckpointStore(privateRoot, undefined, saves);
  const report = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  if (mode === 'seed' || mode === 'seed-saved') {
    const bytes = await readFile(entry); const source = await openSaveSource(entry, bytes); const sessionId = randomUUID();
    const history = createTextHistory(bytes, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
    const node = history.source.nodes.find(node => node.parentTag === 'h1')!;
    for (const text of [mode === 'seed-saved' ? '' : 'B', 'C']) history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash,
      nodeId: node.nodeId, expectedText: history.textFor(node.nodeId)!, newText: text }));
    history.commit(history.prepareMove('undo'));
    const result = await store.write(source, history.source, history.candidate, sessionId, history.revision, history.capture());
    assert.equal(result.status, 'persisted');
    if (mode === 'seed-saved') {
      const transaction = await saves.prepare(source, history.candidate); assert.equal(transaction.status, 'prepared');
      assert.equal((await transaction.commit!()).status, 'committed');
    }
    report({ state: mode === 'seed-saved' ? 'saved' : 'seeded', sessionId, revision: history.revision });
    setInterval(() => {}, 1000); // Parent kills this process after its sealed point.
  } else {
    const document = await prepareDocument(outputRoot, entry, 1, new AbortController().signal, store, recoveryId);
    try {
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), mode === 'restore-saved' ? '' : 'B');
      assert.equal(document.history!.summary().redoCount, 1);
      if (mode === 'restore-saved') {
        assert.equal(document.draft.candidate.patches.length, 0); assert.equal(document.draft.revision, 5);
        assert.notEqual(document.checkpointSessionId, recoveryId); assert.equal(store.isSessionActive(recoveryId!), true);
        assert.equal(store.isSessionActive(document.checkpointSessionId), true);
        assert.equal(document.persistence!.snapshot().persisted!.draftRevision, 5);
        assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").childNodes.length'), 1);
        const before = document.input.snapshot();
        await document.input.history({ stateRevision: before.stateRevision, draftRevision: before.draftRevision, direction: 'undo' });
        assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'A & 😀');
      }
      const state = document.input.snapshot(); await document.input.history({ stateRevision: state.stateRevision, draftRevision: state.draftRevision, direction: 'redo' });
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), mode === 'restore-saved' ? '' : 'C');
      assert.equal((await document.persistence!.settle()).status, 'persisted');
      report({ state: mode === 'restore-saved' ? 'saved-restored' : 'restored', sessionId: document.checkpointSessionId,
        revision: document.draft.revision, ...document.history!.summary() });
    } finally { await document.close(); }
    app.exit(0);
  }
}).catch(error => { console.error(error); app.exit(1); });
