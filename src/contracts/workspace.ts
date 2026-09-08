import type { InputSnapshot } from './input.ts';

export type WorkspacePhase = 'idle' | 'choosing' | 'opening' | 'reviewing' | 'saving' | 'committing' | 'disposed';
export type LeaveReview = Readonly<{
  reviewId: string; action: 'open' | 'close'; currentName: string; nextName: string | null;
  hasUnappliedInput: boolean; changeCount: number; inputStateRevision: number;
}>;
export type LeaveDecision = Readonly<{ reviewId: string; decision: 'cancel' | 'discard' | 'save-copy' }>;
export type WorkspaceSnapshot = Readonly<{
  stateRevision: number; phase: WorkspacePhase;
  current: Readonly<{ id: string; name: string; input: InputSnapshot }> | null;
  review: LeaveReview | null; cleanupPending: boolean;
}>;
export type WorkspaceOutcome = Readonly<{
  status: 'opened' | 'closed' | 'cancelled'; state: WorkspaceSnapshot;
}>;
export function isLeaveDecision(value: unknown): value is LeaveDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 2 && typeof fields.reviewId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(fields.reviewId)
    && ['cancel', 'discard', 'save-copy'].includes(fields.decision as string);
}
