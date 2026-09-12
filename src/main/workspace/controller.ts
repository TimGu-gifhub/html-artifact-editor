import { randomUUID } from 'node:crypto';
import { isLeaveDecision } from '../../contracts/workspace.ts';
import type { LeaveReview, WorkspaceDepartureReport, WorkspaceOutcome, WorkspacePhase, WorkspaceSaveReport, WorkspaceSnapshot } from '../../contracts/workspace.ts';
import type { InputSnapshot } from '../../contracts/input.ts';
import type { DraftStore, OpenDocument, ProofreadDocument, prepareDocument } from './document.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { OriginalSaver, OriginalSaveResult } from '../storage/original.ts';
import { isRestoreReference, isTransactionId } from '../../contracts/save-record.ts';
import type { WorkspaceRecoveryCatalog } from '../../contracts/recovery.ts';
import { isDiffReview } from '../../contracts/source-diff.ts';
import type { DiffReview, WorkspaceDiff } from '../../contracts/source-diff.ts';
import { openSaveSource } from '../../platform/save-source.ts';
import { isBackupDecision } from '../../contracts/backup.ts';
import type { BackupReview, WorkspaceBackupCatalog } from '../../contracts/backup.ts';
import type { RestoreReference } from '../../contracts/save-record.ts';
import type { BackupRestorer } from '../storage/backups.ts';
import type { PreviewMode } from '../../contracts/preview.ts';
import type { prepareInteractiveDocument } from './interactive-document.ts';

export type WorkspaceDecisions = Readonly<{
  review: (value: LeaveReview) => Promise<unknown>;
  chooseCopy: (name: string) => Promise<string | undefined>;
  reviewBackup?: (value: BackupReview) => Promise<unknown>;
}>;
export type ActivateDocument = (next: OpenDocument | null, previous: OpenDocument | null) => () => void;
export type TransferPresentation = (previous: OpenDocument, next: OpenDocument, signal: AbortSignal) => Promise<void>;
type DepartureProof = Readonly<{ input: InputSnapshot | null; reason: 'discarded' | 'copied' | null }>;
// Private Main coordinator. It has no renderer/path IPC or implicit HTML Save.
// The synchronous activation port must restore its prior state before throwing.
// A successful activation returns a rollback for a failed final authority check.
export function createWorkspace(outputRoot: string, decisions: WorkspaceDecisions, prepare: typeof prepareDocument,
  activate: ActivateDocument = () => () => {}, saveOriginal?: OriginalSaver, checkpoints?: DraftStore, backups?: BackupRestorer,
  prepareInteractive?: typeof prepareInteractiveDocument, transferPresentation?: TransferPresentation) {
  let current: OpenDocument | null = null;
  let phase: WorkspacePhase = 'idle';
  let revision = 1;
  let generation = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let review: LeaveReview | null = null;
  let pending: AbortController | null = null;
  let operationDone: Promise<WorkspaceSaveReport | null> | undefined;
  let finishOperation: ((report: WorkspaceSaveReport | null) => void) | undefined;
  let savingOperation = false;
  let operationSave: WorkspaceSaveReport | null = null;
  let rebuilding: AbortController | null = null;
  let lastSave: WorkspaceSaveReport | null = null;
  let lastDeparture: WorkspaceDepartureReport | null = null;
  let retainedSave: OriginalSaveResult | null = null;
  let listing: Promise<WorkspaceRecoveryCatalog> | null = null;
  let backupListing: Readonly<{ document: OpenDocument; promise: Promise<WorkspaceBackupCatalog> }> | null = null;
  let backupReview: BackupReview | null = null;
  const listeners = new Set<() => void>();
  // Keep objects whose teardown failed as evidence; block further opens instead
  // of accumulating unbounded views or pretending cleanup succeeded.
  const failedCleanup = new Set<OpenDocument>();
  let activationUncertain = false;
  let unsubscribe = (): void => {};
  const notify = (): void => {
    ++revision;
    for (const listener of listeners) { try { listener(); } catch { /* State is owned by Main. */ } }
  };
  const snapshot = (): WorkspaceSnapshot => Object.freeze({ stateRevision: revision, phase,
    current: current ? Object.freeze({ id: current.id, name: current.name, mode: current.mode, input: current.input?.snapshot() ?? null, project: current.project(),
      persistence: current.persistence?.snapshot() ?? null }) : null,
    review, backupReview, cleanupPending: activationUncertain || failedCleanup.size > 0 || !!lastDeparture?.cleanupPending, lastSave, lastDeparture,
    canSave: !!saveOriginal && phase === 'idle' && !disposed && !activationUncertain && !failedCleanup.size
      && !lastSave?.requiresReview && !lastDeparture?.requiresReview && current?.mode === 'proofread'
      && current.input.snapshot().draftPhase === 'idle' && current.input.snapshot().canSaveCopy
      && (!current.history || current.history.available)
      && current.mapping.status === 'ready' && current.draft.candidate.patches.length > 0 });
  const inputReady = (state: InputSnapshot | null | undefined): void => {
    if (!state) return;
    if (state.phase !== 'idle' || !['idle', 'uncertain'].includes(state.draftPhase)) throw new Error('DOCUMENT_BUSY');
    if (state.input?.composing) throw new Error('INPUT_COMPOSING');
    if (state.draftPhase === 'uncertain') throw new Error('DOCUMENT_RECOVERY_REQUIRED');
  };
  const begin = (expectedRevision: number, initialPhase: WorkspacePhase, isSave = false): AbortController => {
    if (disposed || phase !== 'idle') throw new Error('WORKSPACE_BUSY');
    if (expectedRevision !== revision) throw new Error('STALE_WORKSPACE');
    if (activationUncertain || failedCleanup.size) throw new Error('DOCUMENT_CLEANUP_REQUIRED');
    if (lastDeparture?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
    inputReady(current?.input?.snapshot());
    pending = new AbortController();
    savingOperation = isSave; operationSave = null;
    operationDone = new Promise<WorkspaceSaveReport | null>(done => { finishOperation = done; });
    phase = initialPhase; notify(); return pending;
  };
  const live = (operation: AbortController): void => {
    if (disposed || pending !== operation || operation.signal.aborted) throw new Error('WORKSPACE_CANCELLED');
  };
  const ask = <T>(operation: AbortController, callback: () => Promise<T>): Promise<T> => {
    live(operation);
    return new Promise((resolveAnswer, reject) => {
      let settled = false;
      const finishAnswer = (settle: () => void): void => {
        if (settled) return;
        settled = true; operation.signal.removeEventListener('abort', aborted);
        settle();
      };
      const aborted = (): void => finishAnswer(() => reject(new Error('WORKSPACE_CANCELLED')));
      operation.signal.addEventListener('abort', aborted, { once: true });
      // Teardown can settle this wait even if a gone dialog never responds.
      // Late results and rejections are consumed without repeating any action.
      void Promise.resolve().then(() => { live(operation); return callback(); })
        .then((value) => finishAnswer(() => resolveAnswer(value)), (error: unknown) => finishAnswer(() => reject(error)));
    });
  };
  const retire = async (value: OpenDocument | null): Promise<void> => {
    if (!value) return;
    try { await value.close(); failedCleanup.delete(value); }
    catch { failedCleanup.add(value); }
  };
  const sameInput = (before: InputSnapshot | null, after: InputSnapshot | null): boolean =>
    before === null || after === null ? before === after : before.stateRevision === after.stateRevision && before.draftRevision === after.draftRevision
    && before.candidateHash === after.candidateHash && before.phase === after.phase && before.draftPhase === after.draftPhase;
  const permission = async (action: LeaveReview['action'], next: Pick<OpenDocument, 'name'> | null,
    operation: AbortController): Promise<DepartureProof | null | false> => {
    live(operation);
    const leaving = current;
    if (!leaving) return null;
    if (leaving.mode === 'interactive') return { input: null, reason: null };
    const before = leaving.input.snapshot(); inputReady(before);
    if (!before.hasUnappliedInput && before.changes.length === 0) return { input: before, reason: null };
    review = Object.freeze({ reviewId: randomUUID(), action, currentName: leaving.name, nextName: next?.name ?? null,
      hasUnappliedInput: before.hasUnappliedInput, changeCount: before.changes.length, inputStateRevision: before.stateRevision });
    phase = 'reviewing'; notify();
    const response = await ask(operation, () => decisions.review(review!));
    live(operation);
    if (!isLeaveDecision(response) || response.reviewId !== review.reviewId) throw new Error('STALE_DOCUMENT_REVIEW');
    if (response.decision === 'cancel') return false;
    if (current !== leaving || !sameInput(before, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
    inputReady(leaving.input.snapshot());
    if (response.decision === 'discard') return { input: before, reason: 'discarded' };
    phase = 'saving'; notify();
    // This decision explicitly means applying pending text and saving a copy
    // before leaving. A later chooser cancellation keeps the applied draft.
    if (before.hasUnappliedInput) {
      await leaving.input.apply({ editToken: before.input!.editToken, inputRevision: before.input!.revision });
      live(operation);
    }
    const outcome = await leaving.input.saveCopy(leaving.input.snapshot().stateRevision, async () => {
      live(operation);
      const path = await ask(operation, () => decisions.chooseCopy(leaving.name));
      return !disposed && pending === operation && !operation.signal.aborted ? path : undefined;
    }, leaving.writer);
    live(operation);
    if (!outcome) return false;
    if (outcome.status !== 'created') throw new Error(outcome.status === 'unknown' ? 'COPY_OUTCOME_UNKNOWN' : 'COPY_FAILED');
    const saved = leaving.input.snapshot();
    if (saved.candidateHash !== outcome.expectedHash || saved.hasUnappliedInput) throw new Error('STALE_DOCUMENT_REVIEW');
    inputReady(saved); return { input: saved, reason: 'copied' };
  };
  const stageInstall = (next: OpenDocument | null, check: () => void) => {
    check();
    const previous = current;
    const nextSubscription = next ? next.onState(notify) : () => {};
    let rollback: (() => void) | undefined;
    try {
      rollback = activate(next, previous);
      // A Main port can synchronously revoke a connection or discover a failure.
      // Do not close the old input or publish the new identity until this passes.
      check();
    } catch (error) {
      nextSubscription();
      if (error instanceof Error && error.message === 'DOCUMENT_ACTIVATION_UNKNOWN') activationUncertain = true;
      try { rollback?.(); } catch { activationUncertain = true; }
      if (activationUncertain) throw new Error('DOCUMENT_ACTIVATION_UNKNOWN');
      throw error;
    }
    let settled = false;
    return {
      publish(): OpenDocument | null {
        if (settled) throw new Error('DOCUMENT_ACTIVATION_UNKNOWN');
        settled = true; unsubscribe(); current = next; unsubscribe = nextSubscription; lastSave = null; retainedSave = null;
        phase = 'committing'; review = null; notify(); return previous;
      },
      rollback(): void {
        if (settled) return;
        settled = true; nextSubscription();
        try { rollback?.(); } catch { activationUncertain = true; throw new Error('DOCUMENT_ACTIVATION_UNKNOWN'); }
      },
    };
  };
  const install = (next: OpenDocument | null, check: () => void): OpenDocument | null => stageInstall(next, check).publish();
  const depart = async (next: OpenDocument | null, proof: DepartureProof | null, operation: AbortController,
    verifyActivation: (() => Promise<void>) | null = next?.verifyRecovery ?? null): Promise<OpenDocument | null> => {
    const leaving = current;
    const checkInput = (): void => {
      live(operation);
      if (current ? !proof || !sameInput(proof.input, current.input?.snapshot() ?? null) : proof !== null) throw new Error('STALE_DOCUMENT_REVIEW');
      inputReady(current?.input?.snapshot());
    };
    checkInput();
    if (leaving?.mode !== 'proofread' || !leaving.persistence || !checkpoints || !proof?.input) {
      if (!verifyActivation) return install(next, checkInput);
      await verifyActivation(); checkInput();
      const staged = stageInstall(next, checkInput);
      try { await verifyActivation(); checkInput(); return staged.publish(); }
      catch (error) { staged.rollback(); throw error; }
    }
    const release = leaving.input.holdDeparture(proof.input.stateRevision);
    const frozen = leaving.input.snapshot();
    phase = 'committing'; notify();
    let staged: ReturnType<typeof stageInstall> | undefined;
    let started = false; let published = false;
    const check = (finishStarted = false): void => {
      if (disposed || current !== leaving || pending !== operation || (!finishStarted && operation.signal.aborted)) throw new Error('WORKSPACE_CANCELLED');
      if (activationUncertain) throw new Error('DOCUMENT_ACTIVATION_UNKNOWN');
      if (!sameInput(frozen, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
    };
    try {
      const durable = await leaving.persistence.settle(); check();
      if (proof.reason === null && frozen.draftRevision > 1
        && (durable.persisted?.draftRevision !== frozen.draftRevision || durable.persisted.resultHash !== frozen.candidateHash)) {
        lastDeparture = Object.freeze({ documentId: leaving.id, status: 'failed', code: 'DRAFT_PERSISTENCE_REQUIRED',
          cleanupPending: durable.cleanupPending, requiresReview: false });
        throw new Error('DRAFT_PERSISTENCE_REQUIRED');
      }
      // Stage the native view first. Failed attachment must never mark a live
      // draft as discarded. Keep its input and current identity until settlement.
      await verifyActivation?.(); check();
      staged = stageInstall(next, () => check());
      if (proof.reason !== null) {
        check(); started = true;
        const result = await checkpoints.retire(leaving.saveSource, leaving.checkpointSessionId, frozen.draftRevision, proof.reason);
        if (!result || !['retired', 'empty', 'failed', 'unknown'].includes(result.status) || typeof result.cleanupPending !== 'boolean'
          || (result.status === 'retired' && !isTransactionId(result.checkpointId)) || (result.status === 'empty' && result.checkpointId !== null)) {
          throw new Error('DRAFT_RETIREMENT_UNKNOWN');
        }
        const settled = result.status === 'retired' || result.status === 'empty';
        lastDeparture = Object.freeze({ documentId: leaving.id, status: result.status,
          code: typeof result.code === 'string' && /^DRAFT_[A-Z_]+$/u.test(result.code) ? result.code : null,
          cleanupPending: result.cleanupPending, requiresReview: !settled || result.cleanupPending });
        if (!settled) throw new Error(result.status === 'unknown' ? 'DRAFT_RETIREMENT_UNKNOWN' : 'DRAFT_RETIREMENT_FAILED');
      } else lastDeparture = Object.freeze({ documentId: leaving.id, status: 'clean', code: durable.code,
        cleanupPending: durable.cleanupPending, requiresReview: durable.cleanupPending });
      // Once an authorized marker starts, renderer loss cannot revoke that disk
      // decision. Main finishes a verified result, as with an original-file Save.
      await verifyActivation?.();
      check(started); const previous = staged.publish(); published = true; return previous;
    } catch (error) {
      try { staged?.rollback(); } catch { error = new Error('DOCUMENT_ACTIVATION_UNKNOWN'); }
      const afterMarkerCode = error instanceof Error && /^(DOCUMENT_ACTIVATION_UNKNOWN|WORKSPACE_CANCELLED|STALE_DOCUMENT_REVIEW|DRAFT_[A-Z_]+)$/u.test(error.message)
        ? error.message : 'DRAFT_RETIREMENT_UNKNOWN';
      if (started) lastDeparture = Object.freeze({ documentId: leaving.id, status: lastDeparture?.status ?? 'unknown',
        code: lastDeparture?.code ?? afterMarkerCode, cleanupPending: lastDeparture?.cleanupPending ?? true, requiresReview: true });
      throw error;
    } finally {
      // A failed/unknown marker can already have ended the persisted session.
      // Retain frozen text and source evidence; no further Apply or blind retry.
      if (!published && !started) release();
    }
  };
  const finish = (): void => {
    const done = finishOperation; const saved = operationSave;
    finishOperation = undefined; operationDone = undefined; savingOperation = false; operationSave = null;
    pending = null; review = null; backupReview = null; phase = disposed ? 'disposed' : 'idle'; notify(); done?.(saved);
  };
  const openDocument = async (expectedRevision: number, choose: (signal: AbortSignal) => Promise<ProjectSource | undefined>,
    recoverySessionId?: string): Promise<WorkspaceOutcome> => {
    const operation = begin(expectedRevision, 'choosing');
    lastDeparture = null;
    let candidate: OpenDocument | null = null;
    let status: WorkspaceOutcome['status'] = 'cancelled';
    try {
      const path = await ask(operation, () => choose(operation.signal)); live(operation);
      if (path) {
        phase = 'opening'; notify();
        candidate = await prepare(outputRoot, path, ++generation, operation.signal, checkpoints, recoverySessionId); live(operation);
        const proof = await permission('open', candidate, operation);
        if (proof !== false) {
          const previous = await depart(candidate, proof, operation);
          candidate = null;
          await retire(previous); status = recoverySessionId ? 'restored' : 'opened';
        }
      }
    } finally { await retire(candidate); finish(); }
    return { status, state: snapshot() };
  };
  return Object.freeze({
    snapshot,
    get current() { return current; },
    get retainedSave() { return retainedSave; },
    // Main close coordination can join this exact accepted Save, never launch
    // or retry one. A still-open backup review is not a started file operation.
    waitForSave(): Promise<WorkspaceSaveReport | null> | null {
      return !disposed && savingOperation && ['saving', 'committing'].includes(phase) ? operationDone! : null;
    },
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Main-only authority revocation. It settles chooser/review waits, but never
    // disposes the current input or interrupts a file write already in progress.
    cancelPending(): void { pending?.abort(); },
    invalidateActivation(): void { activationUncertain = true; pending?.abort(); notify(); },
    retryPersistence(documentId: string, draftRevision: number): void {
      if (disposed || phase !== 'idle') throw new Error('WORKSPACE_BUSY');
      if (lastDeparture?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      if (!current || current.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (current.mode !== 'proofread') throw new Error('READ_ONLY_MODE');
      if (!current.persistence) throw new Error('DRAFT_PERSISTENCE_UNAVAILABLE');
      inputReady(current.input.snapshot());
      current.persistence.retry(draftRevision);
    },
    async readDiff(documentId: string, draftRevision: number, candidateHash: string): Promise<WorkspaceDiff> {
      const value = current;
      if (disposed || !value || value.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (value.mode !== 'proofread') throw new Error('READ_ONLY_MODE');
      if (!isDiffReview({ draftRevision, candidateHash })) throw new Error('STALE_SOURCE_DIFF');
      const diff = await value.sourceDiff.read(draftRevision, candidateHash);
      if (disposed || current !== value) throw new Error('STALE_DOCUMENT');
      if (value.draft.revision !== draftRevision || value.draft.candidate.resultHash !== candidateHash) throw new Error('STALE_SOURCE_DIFF');
      return Object.freeze({ ...diff, documentId, draftRevision });
    },
    async listBackups(documentId: string): Promise<WorkspaceBackupCatalog> {
      const document = current;
      if (disposed || !document || document.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (!backups) throw new Error('BACKUP_RESTORE_UNAVAILABLE');
      if (phase !== 'idle') throw new Error('WORKSPACE_BUSY');
      if (backupListing?.document === document) return backupListing.promise;
      if (backupListing) throw new Error('WORKSPACE_BUSY');
      const entry = { document, promise: backups.list(document.saveSource).then(catalog => {
        if (disposed || current !== document) throw new Error('STALE_DOCUMENT');
        return Object.freeze({ ...catalog, documentId });
      }).finally(() => { if (backupListing === entry) backupListing = null; }) };
      backupListing = entry; return entry.promise;
    },
    async restoreBackup(expectedRevision: number, documentId: string, reference: RestoreReference): Promise<Readonly<{ status: WorkspaceSaveReport['status']; state: WorkspaceSnapshot }>> {
      const leaving = current; const reviewBackup = decisions.reviewBackup;
      if (!leaving || leaving.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (leaving.mode !== 'proofread') throw new Error('READ_ONLY_MODE');
      if (!backups || !reviewBackup) throw new Error('BACKUP_RESTORE_UNAVAILABLE');
      if (!isRestoreReference(reference)) throw new Error('BACKUP_RECORD_INVALID');
      if (lastSave?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      const before = leaving.input.snapshot(); inputReady(before);
      if (before.hasUnappliedInput) throw new Error('UNAPPLIED_INPUT');
      if (before.changes.length || leaving.draft.candidate.patches.length) throw new Error('UNSAVED_CHANGES');
      if (leaving.mapping.status !== 'ready' || (leaving.history && !leaving.history.available)) throw new Error('DRAFT_UNAVAILABLE');
      const selectedReference = Object.freeze({ ...reference });
      const operation = begin(expectedRevision, 'reviewing', true);
      let next: ProofreadDocument | null = null; let release: (() => void) | undefined; let keepFrozen = false;
      const report = (status: WorkspaceSaveReport['status'], code: string | null, cleanupPending = false, requiresReview = false): void => {
        lastSave = Object.freeze({ documentId: current?.id ?? documentId, operation: 'backup-restore', status, code, cleanupPending, requiresReview }); operationSave = lastSave; notify();
      };
      let status: WorkspaceSaveReport['status'];
      try {
        status = await (async (): Promise<WorkspaceSaveReport['status']> => {
          const selected = await backups.review(leaving.saveSource, selectedReference); live(operation);
          if (current !== leaving || !sameInput(before, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
          if (selected.backup.hash === leaving.saveSource.baseHash) { report('unchanged', null); return 'unchanged'; }
          backupReview = Object.freeze({ reviewId: randomUUID(), documentId, currentName: leaving.name,
            currentHash: leaving.saveSource.baseHash, backup: selected.backup }); notify();
          const answer = await ask(operation, () => reviewBackup(backupReview!)); live(operation);
          if (!isBackupDecision(answer) || answer.reviewId !== backupReview.reviewId) throw new Error('STALE_DOCUMENT_REVIEW');
          if (answer.decision === 'cancel') { report('cancelled', null); return 'cancelled'; }
          if (current !== leaving || !sameInput(before, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
          release = leaving.input.holdDeparture(before.stateRevision);
          const frozen = leaving.input.snapshot(); phase = 'saving'; notify();
          const durable = await leaving.persistence?.settle(); live(operation);
          if (!sameInput(frozen, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
          if (durable && (durable.cleanupPending || (frozen.draftRevision > 1
            && (durable.persisted?.draftRevision !== frozen.draftRevision || durable.persisted.resultHash !== frozen.candidateHash)))) {
            throw new Error('DRAFT_PERSISTENCE_REQUIRED');
          }
          // After entry into the transaction, unexpected errors retain the
          // frozen old session. Only a known pre-write result can release it.
          keepFrozen = true;
          let result: OriginalSaveResult;
          try { result = await selected.restore(operation.signal); }
          catch { report('unknown', 'SAVE_OUTCOME_UNKNOWN', true, true); return 'unknown'; }
          retainedSave = result; keepFrozen = result.status === 'committed' || result.requiresReview;
          if (result.status !== 'committed') {
            report(result.status, result.code, result.cleanupPending, result.requiresReview); return result.status;
          }
          lastSave = null; notify();
          let staged: ReturnType<typeof stageInstall> | undefined;
          try {
            if (disposed || pending !== operation || current !== leaving) throw new Error('SAVE_REBASE_REQUIRED');
            rebuilding = new AbortController();
            const saved = await openSaveSource(leaving.entry, selected.bytes);
            if (!result.verifySaved || !await result.verifySaved(saved)) throw new Error('SAVE_REBASE_REQUIRED');
            // A whole-backup replacement starts a new clean logical history;
            // offsets, drafts and old Text lineage are never carried across it.
            next = await prepare(outputRoot, leaving.preview.grant, ++generation, rebuilding.signal, checkpoints);
            const check = (): void => {
              if (disposed || activationUncertain || pending !== operation || current !== leaving || rebuilding?.signal.aborted
                || next?.mapping.status !== 'ready' || next.saveSource.baseHash !== result.expectedHash
                || next.draft.candidate.resultHash !== result.expectedHash || !sameInput(frozen, leaving.input.snapshot())) throw new Error('SAVE_REBASE_REQUIRED');
            };
            if (!await result.verifySaved(next.saveSource)) throw new Error('SAVE_REBASE_REQUIRED');
            staged = stageInstall(next, check);
            if (!await result.verifySaved(next.saveSource)) throw new Error('SAVE_REBASE_REQUIRED');
            check(); const previous = staged.publish(); next = null;
            report('backup-restored', result.code, result.cleanupPending, result.cleanupPending);
            await retire(previous); return 'backup-restored';
          } catch {
            try { staged?.rollback(); } catch { activationUncertain = true; }
            retainedSave = result; report('rebase-required', 'SAVE_REBASE_REQUIRED', result.cleanupPending, true); return 'rebase-required';
          }
        })();
      } finally { if (!keepFrozen) release?.(); await retire(next); rebuilding = null; finish(); }
      return { status, state: snapshot() };
    },
    async save(expectedRevision: number, documentId: string, reviewed?: DiffReview): Promise<Readonly<{ status: WorkspaceSaveReport['status']; state: WorkspaceSnapshot }>> {
      const leaving = current;
      if (!leaving || leaving.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (leaving.mode !== 'proofread') throw new Error('READ_ONLY_MODE');
      if (reviewed !== undefined && (!isDiffReview(reviewed) || reviewed.draftRevision !== leaving.draft.revision
        || reviewed.candidateHash !== leaving.draft.candidate.resultHash)) throw new Error('STALE_SOURCE_DIFF');
      if (!saveOriginal) throw new Error('SAVE_PLATFORM_UNSUPPORTED');
      if (lastSave?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      const before = leaving.input.snapshot();
      if (before.hasUnappliedInput) throw new Error(before.input?.composing ? 'INPUT_COMPOSING' : 'UNAPPLIED_INPUT');
      const operation = begin(expectedRevision, 'saving', true);
      let next: ProofreadDocument | null = null;
      const report = (status: WorkspaceSaveReport['status'], code: string | null, cleanupPending = false, requiresReview = false): void => {
        lastSave = Object.freeze({ documentId: current?.id ?? documentId, status, code, cleanupPending, requiresReview }); operationSave = lastSave; notify();
      };
      let status: WorkspaceSaveReport['status'];
      try {
        status = await (async (): Promise<WorkspaceSaveReport['status']> => {
          if (!before.changes.length) { report('unchanged', null); return 'unchanged'; }
          const result = await leaving.input.saveOriginal(before.stateRevision, async (candidate) => {
            await leaving.persistence?.settle();
            return saveOriginal(leaving.saveSource, candidate, operation.signal);
          });
          retainedSave = result;
          if (result.status !== 'committed') {
            report(result.status, result.code, result.cleanupPending, result.requiresReview);
            return result.status;
          }
          // Disk commit outlives renderer authority. Reconcile in Main even after
          // UI revocation; only workspace disposal can stop this new preview.
          // Stay in saving while rebuilding; do not flash a recovery error.
          lastSave = null; notify();
          try {
            if (disposed || pending !== operation || current !== leaving) throw new Error('SAVE_REBASE_REQUIRED');
            rebuilding = new AbortController();
            // Verify the committed file version before computing a new logical
            // savepoint. Candidate bytes alone never prove that Save completed.
            const savedSource = await openSaveSource(leaving.entry, leaving.draft.candidate.bytes);
            if (!result.verifySaved || !await result.verifySaved(savedSource)) throw new Error('SAVE_REBASE_REQUIRED');
            const history = await leaving.history?.savedCheckpoint(savedSource.bytes);
            next = await prepare(outputRoot, leaving.preview.grant, ++generation, rebuilding.signal, checkpoints, undefined, history);
            // Screen state is optional and never part of a SaveCommit. Failure
            // to carry a tab/scroll must not turn a verified write into a retry.
            try { await transferPresentation?.(leaving, next, rebuilding.signal); } catch { /* Product reports partial presentation. */ }
            if (!result.verifySaved || !await result.verifySaved(next.saveSource)) throw new Error('SAVE_REBASE_REQUIRED');
            const previous = install(next, () => {
              if (disposed || activationUncertain || pending !== operation || current !== leaving || rebuilding?.signal.aborted
                || next?.mapping.status !== 'ready'
                || leaving.draft.candidate.resultHash !== result.expectedHash || leaving.input.snapshot().hasUnappliedInput) throw new Error('SAVE_REBASE_REQUIRED');
            });
            next = null;
            report('saved', result.code, result.cleanupPending, result.cleanupPending);
            await retire(previous);
            return 'saved';
          } catch {
            retainedSave = result;
            report('rebase-required', 'SAVE_REBASE_REQUIRED', result.cleanupPending, true);
            return 'rebase-required';
          }
        })();
      } finally { await retire(next); rebuilding = null; finish(); }
      return { status, state: snapshot() };
    },
    async switchMode(expectedRevision: number, documentId: string, mode: PreviewMode): Promise<WorkspaceOutcome> {
      const leaving = current;
      if (!leaving || leaving.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (mode !== 'proofread' && mode !== 'interactive') throw new Error('INVALID_PREVIEW_IDENTITY');
      if (lastSave?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      if (mode === 'interactive' && !prepareInteractive) throw new Error('PREVIEW_MODE_UNAVAILABLE');
      const operation = begin(expectedRevision, 'reviewing');
      lastDeparture = null;
      let candidate: OpenDocument | null = null;
      let status: WorkspaceOutcome['status'] = 'cancelled';
      try {
        if (mode !== leaving.mode) {
          // Resolve the old draft before any local script is run. Native review
          // and exclusive-copy semantics remain the same as opening another file.
          const proof = await permission('mode', { name: leaving.name }, operation);
          if (proof !== false) {
            await leaving.saveSource.verify(); live(operation);
            phase = 'opening'; notify();
            if (mode === 'interactive') {
              if (leaving.mode !== 'proofread') throw new Error('STALE_DOCUMENT');
              const history = proof?.reason === null ? leaving.history?.capture() : undefined;
              candidate = await prepareInteractive!(outputRoot, leaving.preview.grant, ++generation, operation.signal, history);
            } else {
              if (leaving.mode !== 'interactive') throw new Error('STALE_DOCUMENT');
              candidate = await prepare(outputRoot, leaving.preview.grant, ++generation, operation.signal,
                checkpoints, undefined, leaving.historyContinuation);
            }
            live(operation);
            const prepared = candidate;
            // Optional product-only presentation handoff. Fresh mapping already
            // exists; dynamic DOM never enters Text, history or save authority.
            await transferPresentation?.(leaving, prepared, operation.signal); live(operation);
            const verifyActivation = async (): Promise<void> => {
              await leaving.saveSource.verify(); await prepared.saveSource.verify();
              if (prepared.saveSource.baseHash !== leaving.saveSource.baseHash) throw new Error('FILE_CHANGED');
            };
            const previous = await depart(prepared, proof, operation, verifyActivation);
            candidate = null; await retire(previous); status = 'opened';
          }
        }
      } finally { await retire(candidate); finish(); }
      return { status, state: snapshot() };
    },
    open: openDocument,
    async restore(expectedRevision: number, sessionId: string, choose: (signal: AbortSignal) => Promise<ProjectSource | undefined>): Promise<WorkspaceOutcome> {
      if (!isTransactionId(sessionId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
      if (!checkpoints) throw new Error('DRAFT_PERSISTENCE_UNAVAILABLE');
      if (checkpoints.isSessionActive(sessionId)) throw new Error('DRAFT_SESSION_ACTIVE');
      return openDocument(expectedRevision, choose, sessionId);
    },
    async listRecovery(): Promise<WorkspaceRecoveryCatalog> {
      if (disposed) throw new Error('WORKSPACE_BUSY');
      if (!checkpoints) throw new Error('DRAFT_PERSISTENCE_UNAVAILABLE');
      listing ??= checkpoints.catalog().then(catalog => Object.freeze({
        entries: Object.freeze(catalog.groups.map(({ sessionId, name, draftRevision, status, historyAvailable }) =>
          Object.freeze({ sessionId, name, draftRevision, status, historyAvailable, active: checkpoints.isSessionActive(sessionId) }))),
        locked: catalog.locked, reviewRequired: catalog.reviewRequired,
      })).finally(() => { listing = null; });
      return listing;
    },
    async requestClose(expectedRevision: number): Promise<WorkspaceOutcome> {
      const operation = begin(expectedRevision, 'reviewing');
      lastDeparture = null;
      let status: WorkspaceOutcome['status'] = 'cancelled';
      try {
        const proof = await permission('close', null, operation);
        if (proof !== false) { await retire(await depart(null, proof, operation)); status = 'closed'; }
      } finally { finish(); }
      return { status, state: snapshot() };
    },
    // Process/test teardown only, never a user-facing close/quit command. Keep
    // current/evidence references and prohibit a later result from committing.
    async dispose(): Promise<void> {
      if (disposed) return disposal;
      disposed = true; pending?.abort(); rebuilding?.abort(); unsubscribe(); phase = 'disposed'; notify();
      // Abort chooser/review waits, then join preparation, authorized file work
      // and candidate retirement before releasing the current document's owner.
      disposal = (async () => { await operationDone; await retire(current); })().finally(() => { listeners.clear(); });
      return disposal;
    },
  });
}
export type Workspace = ReturnType<typeof createWorkspace>;
