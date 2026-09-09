import type { PatchCandidate } from '../../core/patch/engine.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import type { createSavePreparationStore, PreparationResult } from './preparation.ts';

export type OriginalSaveResult = Readonly<{
  status: 'committed' | 'failed' | 'unknown' | 'cancelled'; code: string | null;
  transactionId: string | null; expectedHash: string; cleanupPending: boolean; requiresReview: boolean;
  verifySaved: ((source: SaveSource) => Promise<boolean>) | null;
}>;
export type OriginalSaver = (source: SaveSource, candidate: PatchCandidate, signal: AbortSignal) => Promise<OriginalSaveResult>;
type SaveStore = Awaited<ReturnType<typeof createSavePreparationStore>>;

// Main owns this store and the source captured when the document was opened.
// Revocation can cancel preparation; a started replacement must finish and be
// reconciled even if its original renderer has disappeared.
export function createOriginalSaver(store: SaveStore): OriginalSaver {
  return (source, candidate, signal) => executeOriginalSave(store, candidate.resultHash, signal, () => store.prepare(source, candidate));
}

// Shared result reconciliation for an ordinary Patch Save and an explicitly
// reviewed whole-backup restoration. The preparation authority stays in Main.
export async function executeOriginalSave(store: SaveStore, expectedHash: string, signal: AbortSignal,
  prepare: () => Promise<PreparationResult>): Promise<OriginalSaveResult> {
  const base = { transactionId: null, expectedHash, cleanupPending: false, requiresReview: false, verifySaved: null };
  if (signal.aborted) return Object.freeze({ ...base, status: 'cancelled', code: null });
  const prepared = await prepare();
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
  return Object.freeze({ ...result, transactionId: prepared.transactionId, expectedHash,
    requiresReview: result.status !== 'committed',
    verifySaved: result.status === 'committed' ? async (next: SaveSource): Promise<boolean> => {
      await next.verify();
      const matches = next.baseHash === expectedHash && (await store.inspect(prepared.transactionId, next.current)).state === 'committed-matches';
      await next.verify(); return matches;
    } : null,
  });
}
