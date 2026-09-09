import type { InputSnapshot } from './input.ts';
import type { ProjectSummary } from './resources.ts';
import type { DraftPersistenceState } from './persistence.ts';

export type WorkspacePhase = 'idle' | 'choosing' | 'opening' | 'reviewing' | 'saving' | 'committing' | 'disposed';
export type LeaveReview = Readonly<{
  reviewId: string; action: 'open' | 'close'; currentName: string; nextName: string | null;
  hasUnappliedInput: boolean; changeCount: number; inputStateRevision: number;
}>;
export type LeaveDecision = Readonly<{ reviewId: string; decision: 'cancel' | 'discard' | 'save-copy' }>;
export type WorkspaceSaveReport = Readonly<{
  documentId: string; status: 'saved' | 'rebase-required' | 'failed' | 'unknown' | 'cancelled' | 'unchanged';
  code: string | null; cleanupPending: boolean; requiresReview: boolean;
}>;
export type WorkspaceDepartureReport = Readonly<{
  documentId: string; status: 'clean' | 'retired' | 'empty' | 'failed' | 'unknown';
  code: string | null; cleanupPending: boolean; requiresReview: boolean;
}>;
export type WorkspaceSnapshot = Readonly<{
  stateRevision: number; phase: WorkspacePhase;
  current: Readonly<{ id: string; name: string; input: InputSnapshot; project: ProjectSummary; persistence: DraftPersistenceState | null }> | null;
  review: LeaveReview | null; cleanupPending: boolean; lastSave: WorkspaceSaveReport | null;
  lastDeparture: WorkspaceDepartureReport | null; canSave: boolean;
}>;
export type WorkspaceOutcome = Readonly<{
  status: 'opened' | 'restored' | 'closed' | 'cancelled'; state: WorkspaceSnapshot;
}>;
export function isLeaveDecision(value: unknown): value is LeaveDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 2 && typeof fields.reviewId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(fields.reviewId)
    && ['cancel', 'discard', 'save-copy'].includes(fields.decision as string);
}
