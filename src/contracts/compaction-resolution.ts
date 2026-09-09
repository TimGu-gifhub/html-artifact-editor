import { COMPACTION_LIMIT, isCheckpointCompaction } from './checkpoint-compaction.ts';
import type { FileRemovalProof } from './checkpoint-compaction.ts';
import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';

export const RESOLUTION_LIMIT = 128 * 1024;
export type RemovalProof = Omit<FileRemovalProof, 'name'>;
export type CompactionResolution = Readonly<{
  version: 1; compactionId: string; createdAt: number;
  journalText: string; lockText: string; journal: RemovalProof; lock: RemovalProof;
}>;
export type CompactionResolutionSeal = Readonly<{
  version: 1; compactionId: string; resolutionHash: string; phase: 'complete';
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const proof = (value: unknown, limit: number): value is RemovalProof => object(value) && Object.keys(value).length === 3
  && Number.isSafeInteger(value.size) && (value.size as number) > 0 && (value.size as number) <= limit
  && isContentHash(value.hash) && isStoredFileIdentity(value.identity);
export const isCheckpointWriteLock = (value: unknown): value is Readonly<{ version: 1; checkpointId: string }> =>
  object(value) && Object.keys(value).length === 2 && value.version === 1 && isTransactionId(value.checkpointId);
export function resolutionName(id: string, complete = false): string {
  if (!isTransactionId(id)) throw new Error('STORAGE_REVIEW_REQUIRED');
  return `compaction-${id}${complete ? '.complete' : ''}.json`;
}
export function resolutionFile(name: string): Readonly<{ id: string; complete: boolean }> | null {
  const match = /^compaction-(.+?)(\.complete)?\.json$/u.exec(name);
  return match && isTransactionId(match[1]) ? { id: match[1], complete: !!match[2] } : null;
}
export function isCompactionResolution(value: unknown): value is CompactionResolution {
  if (!object(value) || Object.keys(value).length !== 7 || value.version !== 1 || !isTransactionId(value.compactionId)
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
    || typeof value.journalText !== 'string' || value.journalText.length > COMPACTION_LIMIT
    || typeof value.lockText !== 'string' || value.lockText.length > 1024 || !proof(value.journal, COMPACTION_LIMIT)
    || !proof(value.lock, 1024)) return false;
  try {
    const journal: unknown = JSON.parse(value.journalText);
    return isCheckpointCompaction(journal) && journal.compactionId === value.compactionId && isCheckpointWriteLock(JSON.parse(value.lockText));
  } catch { return false; }
}
export const isCompactionResolutionSeal = (value: unknown): value is CompactionResolutionSeal =>
  object(value) && Object.keys(value).length === 4 && value.version === 1 && isTransactionId(value.compactionId)
  && isContentHash(value.resolutionHash) && value.phase === 'complete';
