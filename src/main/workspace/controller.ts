import { randomUUID } from 'node:crypto';
import { isLeaveDecision } from '../../contracts/workspace.ts';
import type { LeaveReview, WorkspaceDepartureReport, WorkspaceOutcome, WorkspacePhase, WorkspaceSaveReport, WorkspaceSnapshot } from '../../contracts/workspace.ts';
import type { InputSnapshot } from '../../contracts/input.ts';
import type { DraftStore, OpenDocument, prepareDocument } from './document.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { OriginalSaver, OriginalSaveResult } from '../storage/original.ts';
import { isTransactionId } from '../../contracts/save-record.ts';

export type WorkspaceDecisions = Readonly<{
  review: (value: LeaveReview) => Promise<unknown>;
  chooseCopy: (name: string) => Promise<string | undefined>;
}>;
export type ActivateDocument = (next: OpenDocument | null, previous: OpenDocument | null) => () => void;
type DepartureProof = Readonly<{ input: InputSnapshot; reason: 'discarded' | 'copied' | null }>;
// Private Main coordinator. It has no renderer/path IPC or implicit HTML Save.
// The synchronous activation port must restore its prior state before throwing.
// A successful activation returns a rollback for a failed final authority check.
export function createWorkspace(outputRoot: string, decisions: WorkspaceDecisions, prepare: typeof prepareDocument,
  activate: ActivateDocument = () => () => {}, saveOriginal?: OriginalSaver, checkpoints?: DraftStore) {
  let current: OpenDocument | null = null;
  let phase: WorkspacePhase = 'idle';
  let revision = 1;
  let generation = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let review: LeaveReview | null = null;
  let pending: AbortController | null = null;
  let rebuilding: AbortController | null = null;
  let lastSave: WorkspaceSaveReport | null = null;
  let lastDeparture: WorkspaceDepartureReport | null = null;
  let retainedSave: OriginalSaveResult | null = null;
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
    current: current ? Object.freeze({ id: current.id, name: current.name, input: current.input.snapshot(), project: current.project(),
      persistence: current.persistence?.snapshot() ?? null }) : null,
    review, cleanupPending: activationUncertain || failedCleanup.size > 0 || !!lastDeparture?.cleanupPending, lastSave, lastDeparture,
    canSave: !!saveOriginal && phase === 'idle' && !disposed && !activationUncertain && !failedCleanup.size
      && !lastSave?.requiresReview && !lastDeparture?.requiresReview && !!current && current.input.snapshot().canSaveCopy
      && current.mapping.status === 'ready' && current.draft.candidate.patches.length > 0 });
  const inputReady = (state: InputSnapshot | undefined): void => {
    if (!state) return;
    if (state.phase !== 'idle' || !['idle', 'uncertain'].includes(state.draftPhase)) throw new Error('DOCUMENT_BUSY');
    if (state.input?.composing) throw new Error('INPUT_COMPOSING');
    if (state.draftPhase === 'uncertain') throw new Error('DOCUMENT_RECOVERY_REQUIRED');
  };
  const begin = (expectedRevision: number, initialPhase: WorkspacePhase): AbortController => {
    if (disposed || phase !== 'idle') throw new Error('WORKSPACE_BUSY');
    if (expectedRevision !== revision) throw new Error('STALE_WORKSPACE');
    if (activationUncertain || failedCleanup.size) throw new Error('DOCUMENT_CLEANUP_REQUIRED');
    if (lastDeparture?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
    inputReady(current?.input.snapshot());
    pending = new AbortController(); phase = initialPhase; notify(); return pending;
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
  const sameInput = (before: InputSnapshot, after: InputSnapshot): boolean =>
    before.stateRevision === after.stateRevision && before.draftRevision === after.draftRevision
    && before.candidateHash === after.candidateHash && before.phase === after.phase && before.draftPhase === after.draftPhase;
  const permission = async (action: 'open' | 'close', next: OpenDocument | null,
    operation: AbortController): Promise<DepartureProof | null | false> => {
    live(operation);
    const leaving = current;
    if (!leaving) return null;
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
  const depart = async (next: OpenDocument | null, proof: DepartureProof | null, operation: AbortController): Promise<OpenDocument | null> => {
    const leaving = current;
    const checkInput = (): void => {
      live(operation);
      if (current ? !proof || !sameInput(proof.input, current.input.snapshot()) : proof !== null) throw new Error('STALE_DOCUMENT_REVIEW');
      inputReady(current?.input.snapshot());
    };
    checkInput();
    if (!leaving?.persistence || !checkpoints || !proof) return install(next, checkInput);
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
      staged = stageInstall(next, () => check());
      if (proof.reason !== null) {
        check(); started = true;
        const result = await checkpoints.retire(leaving.saveSource, leaving.id, frozen.draftRevision, proof.reason);
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
      check(started); const previous = staged.publish(); published = true; return previous;
    } catch (error) {
      try { staged?.rollback(); } catch { error = new Error('DOCUMENT_ACTIVATION_UNKNOWN'); }
      const afterMarkerCode = error instanceof Error && ['DOCUMENT_ACTIVATION_UNKNOWN', 'WORKSPACE_CANCELLED', 'STALE_DOCUMENT_REVIEW'].includes(error.message)
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
  const finish = (): void => { pending = null; review = null; phase = disposed ? 'disposed' : 'idle'; notify(); };
  return Object.freeze({
    snapshot,
    get current() { return current; },
    get retainedSave() { return retainedSave; },
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Main-only authority revocation. It settles chooser/review waits, but never
    // disposes the current input or interrupts a file write already in progress.
    cancelPending(): void { pending?.abort(); },
    invalidateActivation(): void { activationUncertain = true; pending?.abort(); notify(); },
    retryPersistence(documentId: string, draftRevision: number): void {
      if (disposed || phase !== 'idle') throw new Error('WORKSPACE_BUSY');
      if (lastDeparture?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      if (!current || current.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (!current.persistence) throw new Error('DRAFT_PERSISTENCE_UNAVAILABLE');
      inputReady(current.input.snapshot());
      current.persistence.retry(draftRevision);
    },
    async save(expectedRevision: number, documentId: string): Promise<Readonly<{ status: WorkspaceSaveReport['status']; state: WorkspaceSnapshot }>> {
      const leaving = current;
      if (!leaving || leaving.id !== documentId) throw new Error('STALE_DOCUMENT');
      if (!saveOriginal) throw new Error('SAVE_PLATFORM_UNSUPPORTED');
      if (lastSave?.requiresReview) throw new Error('DOCUMENT_RECOVERY_REQUIRED');
      const before = leaving.input.snapshot();
      if (before.hasUnappliedInput) throw new Error(before.input?.composing ? 'INPUT_COMPOSING' : 'UNAPPLIED_INPUT');
      const operation = begin(expectedRevision, 'saving');
      let next: OpenDocument | null = null;
      const report = (status: WorkspaceSaveReport['status'], code: string | null, cleanupPending = false, requiresReview = false): void => {
        lastSave = Object.freeze({ documentId: current?.id ?? documentId, status, code, cleanupPending, requiresReview }); notify();
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
            next = await prepare(outputRoot, leaving.preview.grant, ++generation, rebuilding.signal, checkpoints);
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
    async open(expectedRevision: number, choose: (signal: AbortSignal) => Promise<ProjectSource | undefined>): Promise<WorkspaceOutcome> {
      const operation = begin(expectedRevision, 'choosing');
      lastDeparture = null;
      let candidate: OpenDocument | null = null;
      let status: WorkspaceOutcome['status'] = 'cancelled';
      try {
        const path = await ask(operation, () => choose(operation.signal)); live(operation);
        if (path) {
          phase = 'opening'; notify();
          candidate = await prepare(outputRoot, path, ++generation, operation.signal, checkpoints); live(operation);
          const proof = await permission('open', candidate, operation);
          if (proof !== false) {
            const previous = await depart(candidate, proof, operation);
            candidate = null;
            await retire(previous); status = 'opened';
          }
        }
      } finally { await retire(candidate); finish(); }
      return { status, state: snapshot() };
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
      disposal = retire(current).finally(() => { listeners.clear(); });
      return disposal;
    },
  });
}
export type Workspace = ReturnType<typeof createWorkspace>;
