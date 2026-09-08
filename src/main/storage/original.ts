import type { PatchCandidate } from '../../core/patch/engine.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import type { createSavePreparationStore } from './preparation.ts';

export type OriginalSaveResult = Readonly<{
  status: 'committed' | 'failed' | 'unknown' | 'cancelled'; code: string | null;
  transactionId: string | null; expectedHash: string; cleanupPending: boolean; requiresReview: boolean;
  verifySaved: ((source: SaveSource) => Promise<boolean>) | null;
}>;
export type OriginalSaver = (source: SaveSource, candidate: PatchCandidate, signal: AbortSignal) => Promise<OriginalSaveResult>;

// Main owns this store and the source captured when the document was opened.
// Revocation can cancel preparation; a started replacement must finish and be
// reconciled even if its original renderer has disappeared.
export function createOriginalSaver(store: Awaited<ReturnType<typeof createSavePreparationStore>>): OriginalSaver {
  return async (source, candidate, signal) => {
    const base = { transactionId: null, expectedHash: candidate.resultHash, cleanupPending: false, requiresReview: false, verifySaved: null };
    if (signal.aborted) return Object.freeze({ ...base, status: 'cancelled', code: null });
    const prepared = await store.prepare(source, candidate);
    if (prepared.status === 'failed') return Object.freeze({ ...base, status: 'failed', code: prepared.code,
      transactionId: prepared.transactionId, requiresReview: ['SAVE_BUSY', 'SAVE_LOCKED', 'STORAGE_LOCK_CHANGED', 'STORAGE_REVIEW_REQUIRED'].includes(prepared.code) });
    if (signal.aborted) {
      try { await prepared.cancel(); return Object.freeze({ ...base, status: 'cancelled', code: null, transactionId: prepared.transactionId }); }
      catch { return Object.freeze({ ...base, status: 'failed', code: 'SAVE_CANCELLATION_FAILED', transactionId: prepared.transactionId,
        cleanupPending: true, requiresReview: true }); }
    }
    const result = await prepared.commit();
    if (result.code === 'SAVE_PLATFORM_UNSUPPORTED') {
      try { await prepared.cancel(); return Object.freeze({ ...base, status: 'failed', code: result.code, transactionId: prepared.transactionId }); }
      catch { return Object.freeze({ ...base, status: 'failed', code: 'SAVE_CANCELLATION_FAILED', transactionId: prepared.transactionId,
        cleanupPending: true, requiresReview: true }); }
    }
    return Object.freeze({ ...result, transactionId: prepared.transactionId, expectedHash: candidate.resultHash,
      requiresReview: result.status !== 'committed',
      verifySaved: result.status === 'committed' ? async (next: SaveSource): Promise<boolean> => {
        await next.verify();
        const matches = next.baseHash === candidate.resultHash && (await store.inspect(prepared.transactionId, next.current)).state === 'committed-matches';
        await next.verify(); return matches;
      } : null,
    });
  };
}
