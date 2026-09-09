import { basename, dirname, join, resolve } from 'node:path';
import { createNewFileWriter } from '../../platform/new-file.ts';
import { createDraftSession } from '../draft/session.ts';
import { createInputController } from '../draft/input.ts';
import { createProjectPreview } from '../preview/project-preview.ts';
import { createPreviewMapping } from '../preview/source-mapping.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { ProjectSummary } from '../../contracts/resources.ts';
import { openSaveSource } from '../../platform/save-source.ts';
import { createDraftPersistence } from '../draft/persistence.ts';
import type { createDraftCheckpointStore } from '../storage/checkpoints.ts';
import { requireEditorProfile } from '../../platform/editor-profile.ts';
import type { DraftPersistence } from '../draft/persistence.ts';
import { isTransactionId } from '../../contracts/save-record.ts';

export type DraftStore = Awaited<ReturnType<typeof createDraftCheckpointStore>>;

// The Main-native chooser supplies the path. Nothing is exposed to the UI until
// preview, mapping, draft and the authorized new-file writer have all succeeded.
export async function prepareDocument(outputRoot: string, source: ProjectSource, generation: number, signal: AbortSignal,
  checkpoints?: DraftStore, recoverySessionId?: string) {
  if (recoverySessionId !== undefined && !isTransactionId(recoverySessionId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
  if (checkpoints) requireEditorProfile();
  if (recoverySessionId !== undefined && !checkpoints) throw new Error('DRAFT_PERSISTENCE_UNAVAILABLE');
  const preview = await createProjectPreview(outputRoot, typeof source === 'string' ? resolve(source) : source, 'proofread', generation, signal);
  // Cancellation belongs to preparation until ownership transfers to Workspace.
  // A later chooser/UI revocation cannot destroy an installed mapping while Main
  // reconciles an already authorized departure. close owns the document lifetime.
  const lifetime = new AbortController();
  const abortPreparation = (): void => lifetime.abort();
  signal.addEventListener('abort', abortPreparation, { once: true });
  if (signal.aborted) lifetime.abort();
  const entry = join(preview.grant.root, ...preview.grant.entry.split('/'));
  let mapping: Awaited<ReturnType<typeof createPreviewMapping>> | undefined;
  let input: ReturnType<typeof createInputController> | undefined;
  let releaseOwnership: (() => void) | undefined;
  let persistence: DraftPersistence | null = null;
  try {
    const checkpointSessionId = recoverySessionId ?? preview.identity.sessionId;
    releaseOwnership = checkpoints?.claimSession(checkpointSessionId);
    mapping = await createPreviewMapping(outputRoot, preview, lifetime.signal);
    const saveSource = await openSaveSource(entry, mapping.source.bytes);
    const writer = await createNewFileWriter(dirname(entry));
    await saveSource.verify();
    signal.throwIfAborted();
    const index = mapping.source;
    const recovery = recoverySessionId ? await checkpoints!.resolveLatest(recoverySessionId, saveSource, index) : null;
    const draft = createDraftSession(outputRoot, mapping, undefined, checkpoints ? {
      enqueue: (candidate, revision) => persistence!.enqueue(candidate, revision),
    } : undefined);
    if (recovery) { await draft.restore(recovery.candidate, recovery.draftRevision); await recovery.verify(); signal.throwIfAborted(); }
    persistence = checkpoints ? createDraftPersistence((candidate, revision) =>
      checkpoints.write(saveSource, index, candidate, checkpointSessionId, revision), recovery ? {
      candidate: draft.candidate, revision: recovery.draftRevision, checkpointId: recovery.checkpointId,
    } : undefined) : null;
    input = createInputController(mapping, draft);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        lifetime.abort();
        input!.close();
        closing = (async () => { await persistence?.close(); await preview.close(); releaseOwnership?.(); })();
      }
      return closing;
    };
    const ownedInput = input;
    const checkRecovery = (): void => {
      if (closing || lifetime.signal.aborted) throw new Error('DRAFT_RECOVERY_UNAVAILABLE');
      if (mapping!.status !== 'ready' || draft.phase !== 'idle' || draft.candidate.resultHash !== recovery!.candidate.resultHash) throw new Error('DRAFT_RESTORE_OUTCOME_UNKNOWN');
    };
    const verifyRecovery = recovery ? async (): Promise<void> => {
      checkRecovery(); await recovery.verify(); checkRecovery();
    } : null;
    const project = (): ProjectSummary => Object.freeze({ name: basename(preview.grant.root), entry: preview.grant.entry,
      resources: preview.diagnosticState() });
    const onState = (listener: () => void): (() => void) => {
      const stopInput = ownedInput.onState(listener);
      const stopResources = preview.onDiagnostics(listener);
      const stopPersistence = persistence?.onState(listener);
      return () => { stopInput(); stopResources(); stopPersistence?.(); };
    };
    signal.throwIfAborted(); signal.removeEventListener('abort', abortPreparation);
    return Object.freeze({ id: preview.identity.sessionId, name: basename(entry), entry, project, onState,
      preview, mapping, draft, input, writer, saveSource, persistence, checkpointSessionId, verifyRecovery, close });
  } catch (error) {
    signal.removeEventListener('abort', abortPreparation); lifetime.abort();
    input?.close(); mapping?.close();
    await persistence?.close(); await preview.close(); releaseOwnership?.();
    throw error;
  }
}
export type OpenDocument = Awaited<ReturnType<typeof prepareDocument>>;
