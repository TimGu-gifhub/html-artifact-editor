import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { app } from 'electron';
import { isInterruptionDecision } from '../../contracts/interruption.ts';
import type { InterruptionState, InterruptionSummary } from '../../contracts/interruption.ts';
import { isSaveLock } from '../../contracts/save-resolution.ts';
import { isCheckpointWriteLock } from '../../contracts/compaction-resolution.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { checkedDirectory } from '../../platform/storage-files.ts';
import { openSaveSource } from '../../platform/save-source.ts';
import { authorizeProject, readProjectFile } from '../protocol/project-files.ts';
import { prepareSaveRecovery } from '../storage/save-recovery.ts';
import { prepareCompactionRecovery } from '../storage/compaction-recovery.ts';
import type { PersistentWorkspaceSession } from '../workspace/persistent-session.ts';

export type InterruptionPorts = Readonly<{
  chooseSource: () => Promise<string | undefined>;
  review: (summary: InterruptionSummary) => Promise<unknown>;
  onStep?: (kind: 'save' | 'compaction', step: string) => Promise<void>;
}>;
type Resolution = Readonly<{ status: 'resolved' | 'failed' | 'unknown'; code: string | null }>;
type Plan = Readonly<{ cancel: () => boolean; commit: () => Promise<Resolution> }>;
const errorCode = (error: unknown): string => {
  const code = error instanceof Error ? error.message : '';
  return code.length <= 96 && /^(?:(?:INTERRUPTION|SAVE|DRAFT|STORAGE|BACKUP|RESOURCE)_[A-Z_]+|FILE_CHANGED|STALE_WORKSPACE)$/u.test(code)
    ? code : 'INTERRUPTION_CHECK_FAILED';
};

// Product orchestration of the existing fully validating Main preparers.
// The IPC command carries only a workspace revision. Source choice and the
// independently bound decision belong to native Main callbacks. No catalog,
// filename or old renderer token may authorize the private maintenance write.
export function createInterruptionController(outputRoot: string, runtime: () => PersistentWorkspaceSession,
  ports: InterruptionPorts, notify: () => void) {
  let state: InterruptionState = Object.freeze({ phase: 'idle', summary: null, result: null, requiresReview: false });
  let operation: Promise<void> | null = null;
  let disposed = false;
  // Retain the actual prepared proof when an accepted result needs review.
  let retained: Plan | null = null;
  const publish = (next: Partial<InterruptionState>): void => { state = Object.freeze({ ...state, ...next }); notify(); };
  const workspaceReady = (revision: number): void => {
    const current = runtime().workspace.snapshot();
    if (disposed) throw new Error('INTERRUPTION_UNAVAILABLE');
    if (current.current) throw new Error('INTERRUPTION_RESTART_REQUIRED');
    if (current.stateRevision !== revision) throw new Error('STALE_WORKSPACE');
    if (current.phase !== 'idle' || current.cleanupPending || current.lastSave?.requiresReview || current.lastDeparture?.requiresReview) {
      throw new Error('INTERRUPTION_REVIEW_REQUIRED');
    }
  };
  const cancelled = (): void => publish({ result: Object.freeze({ status: 'cancelled', code: null }) });
  const run = async (revision: number, active: () => boolean, signal: AbortSignal): Promise<void> => {
    let plan: Plan | null = null;
    let committing = false;
    const current = (): boolean => !disposed && !signal.aborted && active();
    try {
      workspaceReady(revision);
      const directory = runtime().storage.directory;
      if (!app.hasSingleInstanceLock() || relative(app.getPath('userData'), dirname(directory)) !== '') {
        throw new Error('INTERRUPTION_PROFILE_MISMATCH');
      }
      const root = await checkedDirectory(directory);
      let lock: unknown;
      try { lock = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await root.read('active.lock', 1024)).bytes)); }
      catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          publish({ result: Object.freeze({ status: 'unavailable', code: 'INTERRUPTION_NOT_FOUND' }) }); return;
        }
        throw new Error('INTERRUPTION_UNCLASSIFIED');
      }
      // This only chooses a preparer. It is never a proof that the old lock
      // can be removed: each preparer rereads the complete bound evidence.
      const kind = isSaveLock(lock) ? 'save' : isCheckpointWriteLock(lock) ? 'compaction' : null;
      if (!kind) throw new Error('INTERRUPTION_UNCLASSIFIED');
      if (!current()) { cancelled(); return; }
      const selected = await ports.chooseSource();
      if (!selected || !current()) { cancelled(); return; }
      workspaceReady(revision);
      const grant = await authorizeProject(selected, [app.getPath('userData'), app.getPath('sessionData')]);
      const source = await openSaveSource(join(grant.root, grant.entry), await readProjectFile(grant, grant.entry, MAX_SOURCE_BYTES));
      if (!current()) { cancelled(); return; }
      workspaceReady(revision);
      const reviewId = randomUUID();
      let summary: InterruptionSummary;
      if (kind === 'save') {
        const prepared = await prepareSaveRecovery(directory, source, resolve(outputRoot, 'native/ReplaceHelper.exe'),
          step => ports.onStep?.('save', step) ?? Promise.resolve());
        plan = { cancel: prepared.cancel, commit: () => prepared.commit('keep-current') };
        const stage = prepared.summary.phase;
        summary = Object.freeze({ reviewId, name: prepared.summary.name, kind, stage, observed: prepared.summary.observed });
      } else {
        const prepared = await prepareCompactionRecovery(directory, source,
          step => ports.onStep?.('compaction', step) ?? Promise.resolve());
        plan = { cancel: prepared.cancel, commit: prepared.commit };
        summary = Object.freeze({ reviewId, name: prepared.summary.name, kind,
          draftRevision: prepared.summary.draftRevision, obsoleteCount: prepared.summary.obsoleteCount });
      }
      retained = plan;
      if (!current()) { cancelled(); return; }
      workspaceReady(revision);
      publish({ phase: 'reviewing', summary });
      const decision = await ports.review(summary);
      if (!current()) { cancelled(); return; }
      if (!isInterruptionDecision(decision, summary)) throw new Error('INTERRUPTION_INVALID_REVIEW');
      if (decision.decision === 'cancel') { cancelled(); return; }
      workspaceReady(revision);
      // From here renderer loss cannot revoke the native decision or cause a
      // retry. The accepted transaction and exact outcome are always joined.
      publish({ phase: 'resolving' }); committing = true;
      const result = await plan.commit();
      publish({ result: Object.freeze({ status: result.status, code: result.code }),
        requiresReview: result.status === 'unknown' || (result.status === 'resolved' && result.code !== null) });
    } catch (error) {
      publish({ result: Object.freeze({ status: committing ? 'unknown' : 'failed', code: errorCode(error) }),
        requiresReview: committing });
    } finally {
      if (plan && !committing) {
        let released = false;
        try { released = plan.cancel(); } catch { /* An unconfirmed release retains the proof and ownership. */ }
        if (!released) publish({ result: Object.freeze({ status: 'unknown', code: 'INTERRUPTION_CLEANUP_REQUIRED' }), requiresReview: true });
      }
      if (!state.requiresReview) retained = null;
    }
  };
  return Object.freeze({
    snapshot: (): InterruptionState => state,
    get busy(): boolean { return operation !== null || state.phase !== 'idle'; },
    get requiresReview(): boolean { return state.requiresReview; },
    inspect(revision: number, active: () => boolean, signal: AbortSignal): Promise<void> {
      if (operation || state.phase !== 'idle') return Promise.reject(new Error('INTERRUPTION_BUSY'));
      if (state.requiresReview) return Promise.reject(new Error('INTERRUPTION_REVIEW_REQUIRED'));
      workspaceReady(revision);
      publish({ phase: 'checking', summary: null, result: null });
      const accepted = run(revision, active, signal).finally(() => {
        if (operation === accepted) operation = null;
        publish({ phase: 'idle' });
      });
      operation = accepted;
      return accepted;
    },
    async beforeClose(): Promise<boolean> {
      await operation;
      return !state.requiresReview && !disposed;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await operation;
      if (state.requiresReview || retained) throw new Error('EDITOR_RUNTIME_CLEANUP_REQUIRED');
    },
  });
}
