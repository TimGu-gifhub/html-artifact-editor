import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { createTextHistory } from '../../src/core/history/timeline.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { createDraftCheckpointStore } from '../../src/main/storage/checkpoints.ts';
import { prepareSaveRecovery } from '../../src/main/storage/save-recovery.ts';
import { prepareDocument } from '../../src/main/workspace/document.ts';
import { requireEditorProfile } from '../../src/platform/editor-profile.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';
import { digest } from '../../src/platform/storage-files.ts';
import { createWindowsReplacer } from '../../src/platform/windows-replacement.ts';

export async function runSaveRecoveryChild(mode: string, outputRoot: string, entry: string, privateRoot: string, recoveryId?: string): Promise<boolean> {
  if (!['seed-save-lock', 'probe-save-lock', 'restore-save-lock', 'seed-unknown-save', 'restore-unknown-save'].includes(mode)) return false;
  const helper = join(outputRoot, 'native/ReplaceHelper.exe'); const report = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const initial = await readFile(entry); const source = await openSaveSource(entry, initial);
  if (mode === 'probe-save-lock') {
    await assert.rejects(prepareSaveRecovery(privateRoot, source, helper), /DRAFT_PROFILE_IN_USE/);
    report({ state: 'save-profile-blocked' }); app.exit(0); return true;
  }
  requireEditorProfile(); const sessionId = recoveryId ?? randomUUID();
  const saves = await createSavePreparationStore(privateRoot, async step => {
    if (step === (mode === 'seed-save-lock' ? 'committed-synced' : mode === 'seed-unknown-save' ? 'native-replaced' : 'never')) {
      report({ state: 'save-interrupted', sessionId }); await new Promise(() => {});
    }
  }, await createWindowsReplacer(helper));
  const drafts = await createDraftCheckpointStore(privateRoot, undefined, saves);
  if (mode.startsWith('seed-')) {
    const history = createTextHistory(initial, { projectId: sessionId, documentId: randomUUID(), generation: 1 }, digest);
    const node = history.source.nodes.find(node => node.parentTag === 'h1')!;
    history.commit(history.prepareEdit({ identity: history.source.identity, baseHash: history.source.baseHash, nodeId: node.nodeId,
      expectedText: node.decodedText, newText: '' }));
    assert.equal((await drafts.write(source, history.source, history.candidate, sessionId, history.revision, history.capture())).status, 'persisted');
    const prepared = await saves.prepare(source, history.candidate); assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') throw Error('PREPARE_FAILED');
    throw Error(`Expected interruption not reached: ${JSON.stringify(await prepared.commit())}`);
  }
  const before = await readdir(privateRoot);
  await assert.rejects(prepareSaveRecovery(dirname(privateRoot), source, helper), /SAVE_RECOVERY_PROFILE_ROOT_MISMATCH/);
  const release = drafts.claimSession(sessionId);
  await assert.rejects(prepareSaveRecovery(privateRoot, source, helper), /DRAFT_STORAGE_ACTIVE/); release();
  const cancelled = await prepareSaveRecovery(privateRoot, source, helper); assert.equal(cancelled.cancel(), true);
  assert.deepEqual(await readdir(privateRoot), before);
  const stale = await prepareSaveRecovery(privateRoot, source, helper); const profile = app.getPath('userData');
  try {
    app.setPath('userData', dirname(profile));
    assert.equal((await stale.commit('keep-current')).code, 'SAVE_RECOVERY_PROFILE_IN_USE');
  } finally { app.setPath('userData', profile); }
  assert.deepEqual(await readdir(privateRoot), before); assert.deepEqual(await readFile(entry), initial);
  const plan = await prepareSaveRecovery(privateRoot, source, helper); const decision = await plan.commit('keep-current');
  assert.equal(decision.status, 'resolved', decision.code ?? 'save resolution'); assert.deepEqual(await readFile(entry), initial);
  if (mode === 'restore-unknown-save') {
    assert.equal(decision.observed, 'candidate-on-disk');
    await assert.rejects(prepareDocument(outputRoot, entry, 1, new AbortController().signal, drafts, sessionId), /DRAFT_RECOVERY_UNAVAILABLE/);
    const record = (await saves.scan()).records.find(row => row.transactionId === plan.summary.transactionId)!;
    assert.equal(record.phase, 'replacing');
    const backup = await saves.prepareRestore(source, record.transactionId); assert.equal(backup.status, 'prepared');
    if (backup.status !== 'prepared') throw Error('RESTORE_FAILED');
    assert.deepEqual(await readFile(join(privateRoot, backup.transactionId, 'backup.bin')), initial);
    assert.equal((await backup.commit()).status, 'committed'); report({ state: 'unknown-save-retained', sessionId });
  } else {
    assert.equal(decision.observed, 'committed-matches');
    const document = await prepareDocument(outputRoot, entry, 1, new AbortController().signal, drafts, sessionId);
    try {
      assert.notEqual(document.checkpointSessionId, sessionId);
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), '');
      assert.equal(document.draft.candidate.patches.length, 0); assert.equal(document.history!.summary().undoCount, 1);
      const state = document.input.snapshot();
      await document.input.history({ stateRevision: state.stateRevision, draftRevision: state.draftRevision, direction: 'undo' });
      assert.equal(await document.preview.contents.executeJavaScript('document.querySelector("h1").textContent'), 'A & 😀');
      assert.equal((await document.persistence!.settle()).status, 'persisted'); assert.deepEqual(await readFile(entry), initial);
      assert.equal(await document.preview.contents.executeJavaScript('typeof haeWorkspace'), 'undefined');
      report({ state: 'save-lock-restored', sessionId: document.checkpointSessionId, ...document.history!.summary() });
    } finally { await document.close(); }
  }
  app.exit(0); return true;
}
