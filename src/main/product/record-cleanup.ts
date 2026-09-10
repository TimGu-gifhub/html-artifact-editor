import { randomUUID } from 'node:crypto';
import { basename, dirname, relative } from 'node:path';
import { app } from 'electron';
import { isCleanupDecision } from '../../contracts/record-cleanup.ts';
import type { CleanupState, CleanupSummary } from '../../contracts/record-cleanup.ts';
import { prepareRecordCleanup } from '../storage/record-cleanup.ts';
import { WORKSPACE_STORAGE_NAME } from '../workspace/persistent-session.ts';
import type { PersistentWorkspaceSession } from '../workspace/persistent-session.ts';

export type RecordCleanupPorts = Readonly<{ review: (summary: CleanupSummary) => Promise<unknown>;
  onStep?: (step: string) => Promise<void> }>;
export function createRecordCleanupController(runtime: () => PersistentWorkspaceSession, ports: RecordCleanupPorts, notify: () => void) {
  let state: CleanupState = Object.freeze({ phase: 'idle', summary: null, result: null, requiresReview: false });
  let operation: Promise<void> | null = null; let disposed = false;
  let retained: Awaited<ReturnType<typeof prepareRecordCleanup>> | null = null;
  const publish = (next: Partial<CleanupState>) => { state = Object.freeze({ ...state, ...next }); notify(); };
  const ready = (revision: number) => {
    const value = runtime().workspace.snapshot();
    if (disposed) throw new Error('RECORD_CLEANUP_UNAVAILABLE');
    if (value.current) throw new Error('RECORD_CLEANUP_RESTART_REQUIRED');
    if (value.stateRevision !== revision) throw new Error('STALE_WORKSPACE');
    if (value.phase !== 'idle' || value.cleanupPending || value.lastSave?.requiresReview || value.lastDeparture?.requiresReview) throw new Error('RECORD_CLEANUP_REVIEW_REQUIRED');
  };
  const run = async (revision: number, active: () => boolean, signal: AbortSignal) => {
    let plan: Awaited<ReturnType<typeof prepareRecordCleanup>> | null = null; let committing = false;
    const current = () => !disposed && !signal.aborted && active();
    const cancelled = () => publish({ result: { status: 'cancelled', code: null } });
    try {
      ready(revision); const profile = app.getPath('userData'); const directory = runtime().storage.directory;
      const verifyProfile = () => {
        if (!app.hasSingleInstanceLock() || app.getPath('userData') !== profile || relative(profile, dirname(directory)) !== ''
          || basename(directory) !== WORKSPACE_STORAGE_NAME) throw new Error('RECORD_CLEANUP_PROFILE_MISMATCH');
      };
      plan = await prepareRecordCleanup(directory, verifyProfile, ports.onStep, runtime().storage.saves.namespace); retained = plan;
      if (!current()) { cancelled(); return; } ready(revision);
      const summary: CleanupSummary = Object.freeze({ ...plan.summary, reviewId: randomUUID() });
      if (!summary.records && !summary.bytes && !summary.resuming) {
        publish({ summary, result: { status: 'unavailable', code: 'RECORD_CLEANUP_EMPTY' } }); return;
      }
      publish({ phase: 'reviewing', summary });
      const decision = await ports.review(summary);
      if (!current()) { cancelled(); return; }
      if (!isCleanupDecision(decision, summary)) throw new Error('RECORD_CLEANUP_INVALID_REVIEW');
      if (decision.decision === 'cancel') { cancelled(); return; }
      ready(revision); committing = true; publish({ phase: 'cleaning' });
      const result = await plan.commit();
      publish({ result, requiresReview: result.status === 'unknown' || (result.status === 'cleared' && result.code !== null) });
    } catch (error) {
      const code = error instanceof Error && /^(?:(?:RECORD_CLEANUP|STORAGE|DRAFT)_[A-Z_]+|STALE_WORKSPACE)$/u.test(error.message)
        ? error.message : 'RECORD_CLEANUP_FAILED';
      publish({ result: { status: committing ? 'unknown' : 'failed', code }, requiresReview: committing });
    } finally {
      if (plan && !committing) {
        let released = false; try { released = plan.cancel(); } catch { /* Retain uncertain ownership. */ }
        if (!released) publish({ result: { status: 'unknown', code: 'RECORD_CLEANUP_REVIEW_REQUIRED' }, requiresReview: true });
      }
      if (!state.requiresReview) retained = null;
    }
  };
  return Object.freeze({
    snapshot: (): CleanupState => state,
    get busy() { return operation !== null || state.phase !== 'idle'; },
    get requiresReview() { return state.requiresReview; },
    clear(revision: number, active: () => boolean, signal: AbortSignal): Promise<void> {
      if (operation || state.phase !== 'idle') return Promise.reject(new Error('RECORD_CLEANUP_BUSY'));
      if (state.requiresReview) return Promise.reject(new Error('RECORD_CLEANUP_REVIEW_REQUIRED'));
      ready(revision); publish({ phase: 'checking', summary: null, result: null });
      const accepted = run(revision, active, signal).finally(() => { if (operation === accepted) operation = null; publish({ phase: 'idle' }); });
      operation = accepted; return accepted;
    },
    async beforeClose() { await operation; return !disposed && !state.requiresReview; },
    async dispose() {
      disposed = true; await operation;
      if (state.requiresReview || retained) throw new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED');
    },
  });
}
