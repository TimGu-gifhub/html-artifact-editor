import { randomUUID } from 'node:crypto';
import { isLeaveDecision } from '../../contracts/workspace.ts';
import type { LeaveReview, WorkspaceOutcome, WorkspacePhase, WorkspaceSaveReport, WorkspaceSnapshot } from '../../contracts/workspace.ts';
import type { InputSnapshot } from '../../contracts/input.ts';
import type { OpenDocument, prepareDocument } from './document.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { OriginalSaver, OriginalSaveResult } from '../storage/original.ts';

export type WorkspaceDecisions = Readonly<{
  review: (value: LeaveReview) => Promise<unknown>;
  chooseCopy: (name: string) => Promise<string | undefined>;
}>;
export type ActivateDocument = (next: OpenDocument | null, previous: OpenDocument | null) => () => void;
// Private Main coordinator. It has no renderer/path IPC or implicit HTML Save.
// The synchronous activation port must restore its prior state before throwing.
// A successful activation returns a rollback for a failed final authority check.
export function createWorkspace(outputRoot: string, decisions: WorkspaceDecisions, prepare: typeof prepareDocument,
  activate: ActivateDocument = () => () => {}, saveOriginal?: OriginalSaver) {
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
    current: current ? Object.freeze({ id: current.id, name: current.name, input: current.input.snapshot(), project: current.project() }) : null,
    review, cleanupPending: activationUncertain || failedCleanup.size > 0, lastSave,
    canSave: !!saveOriginal && phase === 'idle' && !disposed && !activationUncertain && !failedCleanup.size
      && !lastSave?.requiresReview && !!current && current.input.snapshot().canSaveCopy
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
    operation: AbortController): Promise<InputSnapshot | null | false> => {
    live(operation);
    const leaving = current;
    if (!leaving) return null;
    const before = leaving.input.snapshot(); inputReady(before);
    if (!before.hasUnappliedInput && before.changes.length === 0) return before;
    review = Object.freeze({ reviewId: randomUUID(), action, currentName: leaving.name, nextName: next?.name ?? null,
      hasUnappliedInput: before.hasUnappliedInput, changeCount: before.changes.length, inputStateRevision: before.stateRevision });
    phase = 'reviewing'; notify();
    const response = await ask(operation, () => decisions.review(review!));
    live(operation);
    if (!isLeaveDecision(response) || response.reviewId !== review.reviewId) throw new Error('STALE_DOCUMENT_REVIEW');
    if (response.decision === 'cancel') return false;
    if (current !== leaving || !sameInput(before, leaving.input.snapshot())) throw new Error('STALE_DOCUMENT_REVIEW');
    inputReady(leaving.input.snapshot());
    if (response.decision === 'discard') return before;
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
    inputReady(saved); return saved;
  };
  const install = (next: OpenDocument | null, check: () => void): OpenDocument | null => {
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
    unsubscribe(); current = next; unsubscribe = nextSubscription; lastSave = null; retainedSave = null;
    phase = 'committing'; review = null; notify();
    return previous;
  };
  const commit = (next: OpenDocument | null, proof: InputSnapshot | null, operation: AbortController): OpenDocument | null => install(next, () => {
    live(operation);
    if (current ? !proof || !sameInput(proof, current.input.snapshot()) : proof !== null) throw new Error('STALE_DOCUMENT_REVIEW');
    inputReady(current?.input.snapshot());
  });
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
          const result = await leaving.input.saveOriginal(before.stateRevision, (candidate) => saveOriginal(leaving.saveSource, candidate, operation.signal));
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
            next = await prepare(outputRoot, leaving.preview.grant, ++generation, rebuilding.signal);
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
      let candidate: OpenDocument | null = null;
      let status: WorkspaceOutcome['status'] = 'cancelled';
      try {
        const path = await ask(operation, () => choose(operation.signal)); live(operation);
        if (path) {
          phase = 'opening'; notify();
          candidate = await prepare(outputRoot, path, ++generation, operation.signal); live(operation);
          const proof = await permission('open', candidate, operation);
          if (proof !== false) {
            const previous = commit(candidate, proof, operation);
            candidate = null;
            await retire(previous); status = 'opened';
          }
        }
      } finally { await retire(candidate); finish(); }
      return { status, state: snapshot() };
    },
    async requestClose(expectedRevision: number): Promise<WorkspaceOutcome> {
      const operation = begin(expectedRevision, 'reviewing');
      let status: WorkspaceOutcome['status'] = 'cancelled';
      try {
        const proof = await permission('close', null, operation);
        if (proof !== false) { await retire(commit(null, proof, operation)); status = 'closed'; }
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
