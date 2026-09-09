import { isTransactionId } from './save-record.ts';
import type { RestoreReference } from './save-record.ts';

export type BackupSummary = Readonly<{
  reference: RestoreReference; createdAt: number; size: number; hash: string;
}>;
export type BackupCatalog = Readonly<{
  entries: readonly BackupSummary[]; locked: boolean; reviewRequired: boolean;
}>;
export type WorkspaceBackupCatalog = BackupCatalog & Readonly<{ documentId: string }>;
export type BackupReview = Readonly<{
  reviewId: string; documentId: string; currentName: string; currentHash: string; backup: BackupSummary;
}>;
export type BackupDecision = Readonly<{ reviewId: string; decision: 'cancel' | 'restore' }>;
export function isBackupDecision(value: unknown): value is BackupDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 2 && isTransactionId(fields.reviewId)
    && (fields.decision === 'cancel' || fields.decision === 'restore');
}
