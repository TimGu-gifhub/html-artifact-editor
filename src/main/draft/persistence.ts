import type { DraftPersistenceState } from '../../contracts/persistence.ts';
import { isTransactionId } from '../../contracts/save-record.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import type { CheckpointWrite } from '../storage/checkpoints.ts';
import { freezeCandidate } from './prepare.ts';

type Pending = Readonly<{ candidate: PatchCandidate; revision: number }>;
type Writer = (candidate: PatchCandidate, revision: number) => Promise<CheckpointWrite>;

// One active write plus the latest pending candidate. Completion is independent
// of input revisions: background storage must not revoke a user's edit proof.
export function createDraftPersistence(write: Writer) {
  let latest: Pending | null = null; let queued: Pending | null = null;
  let writing: Pending | null = null; let active: Promise<void> | null = null;
  let persisted: DraftPersistenceState['persisted'] = null;
  let status: DraftPersistenceState['status'] = 'idle'; let code: string | null = null;
  let cleanupPending = false; let halted = false; let enqueueFailed = false;
  let closing: Promise<DraftPersistenceState> | null = null;
  const listeners = new Set<() => void>(); const waiters = new Set<(state: DraftPersistenceState) => void>();
  const snapshot = (): DraftPersistenceState => Object.freeze({ status, draftRevision: latest?.revision ?? 1,
    writingRevision: writing?.revision ?? null, queuedRevision: queued?.revision ?? null, persisted,
    code, cleanupPending, canRetry: !!latest && !active && halted && !cleanupPending && !closing });
  const notify = (): void => {
    for (const listener of listeners) { try { listener(); } catch { /* A gone renderer cannot veto Main evidence. */ } }
  };
  const settle = (): Promise<DraftPersistenceState> => active
    ? new Promise(resolve => { waiters.add(resolve); }) : Promise.resolve(snapshot());
  const pump = (): void => {
    if (active || halted || !queued) return;
    const item = queued; queued = null; writing = item; status = 'writing'; code = null;
    // The applied candidate is already frozen. Start storage on a later microtask
    // and retain the active promise before observers can enqueue or request Save.
    active = Promise.resolve().then(() => write(item.candidate, item.revision)).then(result => {
      if (!result || !['persisted', 'failed', 'unknown'].includes(result.status)
        || result.draftRevision !== item.revision
        || (result.resultHash !== item.candidate.resultHash && (result.status === 'persisted' || result.resultHash !== ''))
        || typeof result.cleanupPending !== 'boolean'
        || (result.status === 'persisted' && !isTransactionId(result.checkpointId))) throw new Error('DRAFT_PERSISTENCE_RESULT_INVALID');
      status = result.status; cleanupPending = result.cleanupPending;
      code = typeof result.code === 'string' && /^DRAFT_[A-Z_]+$/u.test(result.code) ? result.code : null;
      if (result.status === 'persisted') persisted = Object.freeze({ draftRevision: item.revision, resultHash: item.candidate.resultHash });
      // Failure never starts another write automatically, including an already
      // queued later revision. Explicit retry targets the newest frozen candidate.
      halted = result.status !== 'persisted' || cleanupPending || enqueueFailed;
      if (result.status !== 'persisted' && !code) code = result.status === 'unknown' ? 'DRAFT_PERSISTENCE_UNKNOWN' : 'DRAFT_PERSISTENCE_FAILED';
    }, () => { status = 'unknown'; code = 'DRAFT_PERSISTENCE_UNKNOWN'; halted = true; })
      .catch(() => { status = 'unknown'; code = 'DRAFT_PERSISTENCE_RESULT_INVALID'; halted = true; })
      .finally(() => {
        active = null; writing = null;
        if (enqueueFailed) { status = 'failed'; code = 'DRAFT_PERSISTENCE_REVISION_INVALID'; halted = true; }
        else if (cleanupPending && queued) status = 'failed';
        pump(); notify();
        if (!active) { const state = snapshot(); for (const waiter of waiters) waiter(state); waiters.clear(); }
      });
    notify();
  };
  return Object.freeze({ snapshot, settle,
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enqueue(candidate: PatchCandidate, revision: number): void {
      if (closing) return;
      try {
        if (!Number.isSafeInteger(revision) || revision <= (latest?.revision ?? 1)) throw new Error('DRAFT_PERSISTENCE_REVISION_INVALID');
        latest = Object.freeze({ candidate: freezeCandidate(candidate), revision }); queued = latest;
        enqueueFailed = false;
        if (cleanupPending) status = 'failed';
        pump(); notify();
      } catch { enqueueFailed = true; status = 'failed'; code = 'DRAFT_PERSISTENCE_REVISION_INVALID'; halted = true; notify(); }
    },
    retry(expectedRevision: number): void {
      if (expectedRevision !== latest?.revision) throw new Error('STALE_DRAFT_REQUEST');
      if (!snapshot().canRetry) throw new Error('DRAFT_PERSISTENCE_RETRY_UNAVAILABLE');
      queued = latest; halted = false; enqueueFailed = false; pump();
    },
    close(): Promise<DraftPersistenceState> {
      if (!closing) {
        closing = settle().then(() => { const state = snapshot(); notify(); listeners.clear(); return state; });
      }
      return closing;
    },
  });
}
export type DraftPersistence = ReturnType<typeof createDraftPersistence>;
