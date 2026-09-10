// Product metadata only. No private paths, source bytes, lock proofs or file
// versions are capabilities of the renderer; Main owns the native decision.
export type SaveObservation = 'baseline-matches' | 'committed-matches' | 'candidate-on-disk' | 'conflict';
export type InterruptionSummary = Readonly<{ reviewId: string; name: string }> & (
  Readonly<{ kind: 'save'; observed: SaveObservation; stage: 'incomplete' | 'prepared' | 'cancelled' | 'replacing' | 'committed' }>
  | Readonly<{ kind: 'compaction'; draftRevision: number; obsoleteCount: number }>
);
export type InterruptionDecision = Readonly<{
  reviewId: string; decision: 'cancel' | 'keep-current' | 'continue-cleanup';
}>;
export type InterruptionState = Readonly<{
  phase: 'idle' | 'checking' | 'reviewing' | 'resolving';
  summary: InterruptionSummary | null;
  result: Readonly<{ status: 'cancelled' | 'resolved' | 'failed' | 'unknown' | 'unavailable'; code: string | null }> | null;
  requiresReview: boolean;
}>;

// The callback is Main-owned (native dialog or test decision), but it must
// still answer the exact current review with the decision for that operation.
export function isInterruptionDecision(value: unknown, summary: InterruptionSummary): value is InterruptionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && Object.hasOwn(row, 'reviewId') && Object.hasOwn(row, 'decision') && row.reviewId === summary.reviewId
    && (row.decision === 'cancel' || row.decision === (summary.kind === 'save' ? 'keep-current' : 'continue-cleanup'));
}
