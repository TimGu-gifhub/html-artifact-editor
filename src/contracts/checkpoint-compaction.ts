import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';
import type { StoredFileIdentity } from './save-record.ts';
import { MAX_DRAFT_RECORD_BYTES } from './draft-checkpoint.ts';

export const COMPACTION_LIMIT = 64 * 1024;
export const CHECKPOINT_FILES = ['origin.bin', 'baseline.bin', 'complete.json', 'record.json'] as const;
export type CheckpointFileName = typeof CHECKPOINT_FILES[number];
export type FileRemovalProof = Readonly<{ name: CheckpointFileName; size: number; hash: string; identity: StoredFileIdentity }>;
export type DirectoryIdentity = Readonly<{ dev: string; ino: string }>;
export type CheckpointAnchor = Readonly<{ checkpointId: string; recordHash: string; draftRevision: number }>;
export type ObsoleteCheckpoint = CheckpointAnchor & Readonly<{ directory: DirectoryIdentity; files: readonly FileRemovalProof[] }>;
export type CheckpointCompaction = Readonly<{
  version: 1; compactionId: string; sessionId: string; createdAt: number;
  retained: readonly CheckpointAnchor[]; obsolete: readonly ObsoleteCheckpoint[];
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const isDirectoryIdentity = (value: unknown): value is DirectoryIdentity => object(value) && Object.keys(value).length === 2
  && typeof value.dev === 'string' && /^(?:0|[1-9][0-9]{0,39})$/u.test(value.dev)
  && typeof value.ino === 'string' && /^[1-9][0-9]{0,39}$/u.test(value.ino);
const anchor = (value: unknown): value is CheckpointAnchor => object(value) && isTransactionId(value.checkpointId)
  && isContentHash(value.recordHash) && revision(value.draftRevision);
export function isCheckpointCompaction(value: unknown): value is CheckpointCompaction {
  if (!object(value) || Object.keys(value).length !== 6 || value.version !== 1 || !isTransactionId(value.compactionId)
    || !isTransactionId(value.sessionId) || !revision(value.createdAt) || !Array.isArray(value.retained) || value.retained.length !== 2
    || !value.retained.every(row => anchor(row) && Object.keys(row).length === 3)
    || value.retained[0].draftRevision <= value.retained[1].draftRevision || !Array.isArray(value.obsolete)
    || !value.obsolete.length || value.obsolete.length > 18) return false;
  const floor = value.retained[1].draftRevision;
  if (!value.obsolete.every(row => anchor(row) && Object.keys(row).length === 5 && row.draftRevision < floor
    && isDirectoryIdentity((row as ObsoleteCheckpoint).directory) && Array.isArray((row as ObsoleteCheckpoint).files)
    && (row as ObsoleteCheckpoint).files.length === CHECKPOINT_FILES.length && (row as ObsoleteCheckpoint).files.every((file, index) =>
      object(file) && Object.keys(file).length === 4 && file.name === CHECKPOINT_FILES[index]
      && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_DRAFT_RECORD_BYTES
      && isContentHash(file.hash) && isStoredFileIdentity(file.identity))
    && (row as ObsoleteCheckpoint).files[3]!.hash === row.recordHash)) return false;
  const ids = [...value.retained, ...value.obsolete].map(row => row.checkpointId);
  return new Set(ids).size === ids.length;
}
