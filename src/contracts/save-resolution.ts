import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';
import type { StoredFileIdentity } from './save-record.ts';
import { isDirectoryIdentity } from './checkpoint-compaction.ts';
import type { DirectoryIdentity } from './checkpoint-compaction.ts';
import { MAX_SOURCE_BYTES } from './source-tree.ts';

export const SAVE_RESOLUTION_LIMIT = 16 * 1024;
export const SAVE_FILES = ['intent.json', 'backup.bin', 'candidate.bin', 'prepared.json', 'cancelled.json', 'replacing.json', 'committed.json'] as const;
export const SAVE_PREPARATION_FILES = ['intent.json', 'backup.bin', 'candidate.bin', 'prepared.json'] as const;
export type SaveFile = typeof SAVE_FILES[number];
export type SaveFileProof = Readonly<{ name: SaveFile; size: number; hash: string; identity: StoredFileIdentity }>;
export type SaveResolution = Readonly<{
  transactionId: string; targetKey: string; createdAt: number; decision: 'keep-current';
  current: Readonly<{ hash: string; size: number; identity: StoredFileIdentity }>;
  lockText: string; lock: Omit<SaveFileProof, 'name'>;
  evidence: Readonly<{ directory: DirectoryIdentity; files: readonly SaveFileProof[] }>;
}> & (Readonly<{ version: 1; observed: 'baseline-matches' | 'candidate-on-disk' | 'committed-matches' | 'conflict' }>
  | Readonly<{ version: 2; observed: 'baseline-matches' }>);
export type SaveResolutionSeal = Readonly<{ version: 1; transactionId: string; resolutionHash: string; phase: 'complete' }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const proof = (value: unknown, keys: number, max: number): boolean => object(value) && Object.keys(value).length === keys
  && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= max
  && isContentHash(value.hash) && isStoredFileIdentity(value.identity);
export const isSaveLock = (value: unknown): value is Readonly<{ version: 1; transactionId: string; targetKey: string }> =>
  object(value) && Object.keys(value).length === 3 && value.version === 1 && isTransactionId(value.transactionId) && isContentHash(value.targetKey);
export function saveResolutionName(id: string, complete = false): string {
  if (!isTransactionId(id)) throw new Error('STORAGE_REVIEW_REQUIRED');
  return `save-resolution-${id}${complete ? '.complete' : ''}.json`;
}
export function saveResolutionFile(name: string): Readonly<{ id: string; complete: boolean }> | null {
  const match = /^save-resolution-(.+?)(\.complete)?\.json$/u.exec(name);
  return match && isTransactionId(match[1]) ? { id: match[1], complete: !!match[2] } : null;
}
export function isSaveResolution(value: unknown): value is SaveResolution {
  if (!object(value) || Object.keys(value).length !== 10 || (value.version !== 1 && value.version !== 2) || !isTransactionId(value.transactionId)
    || !isContentHash(value.targetKey) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
    || value.decision !== 'keep-current' || !['baseline-matches', 'candidate-on-disk', 'committed-matches', 'conflict'].includes(value.observed as string)
    || !proof(value.current, 3, MAX_SOURCE_BYTES) || !proof(value.lock, 3, 1024)
    || typeof value.lockText !== 'string' || value.lockText.length > 1024 || !object(value.evidence)
    || Object.keys(value.evidence).length !== 2 || !isDirectoryIdentity(value.evidence.directory) || !Array.isArray(value.evidence.files)) return false;
  const names = new Set<string>();
  for (const item of value.evidence.files) {
    if (!object(item) || !SAVE_FILES.includes(item.name as SaveFile) || !proof(item, 4,
      item.name === 'backup.bin' || item.name === 'candidate.bin' ? MAX_SOURCE_BYTES : SAVE_RESOLUTION_LIMIT) || names.has(item.name as string)) return false;
    names.add(item.name as string);
  }
  if (value.version === 1) {
    if (!SAVE_PREPARATION_FILES.every(name => names.has(name))) return false;
  } else if (value.observed !== 'baseline-matches' || !names.has('intent.json')
    || [...names].some(name => !SAVE_PREPARATION_FILES.includes(name as typeof SAVE_PREPARATION_FILES[number]))) return false;
  try {
    const lock: unknown = JSON.parse(value.lockText);
    return isSaveLock(lock) && lock.transactionId === value.transactionId && lock.targetKey === value.targetKey;
  } catch { return false; }
}
export const isSaveResolutionSeal = (value: unknown): value is SaveResolutionSeal => object(value) && Object.keys(value).length === 4
  && value.version === 1 && isTransactionId(value.transactionId) && isContentHash(value.resolutionHash) && value.phase === 'complete';
