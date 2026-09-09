import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';
import type { StoredFileIdentity } from './save-record.ts';
import { MAX_SOURCE_BYTES } from './source-tree.ts';
import { isHistoryRecord } from './history.ts';
import type { HistoryRecord } from './history.ts';

export const MAX_DRAFT_INTENTS = 1000;
export const MAX_DRAFT_RECORD_BYTES = 24 * 1024 * 1024;
export type StoredTextIntent = Readonly<{
  nodeId: string; expectedText: string; newText: string; rawSliceHash: string; contextFingerprint: string;
}>;
type CheckpointBinding = Readonly<{
  checkpointId: string; sessionId: string; draftRevision: number; createdAt: number;
  targetKey: string; name: string; identity: StoredFileIdentity; baseHash: string; baseSize: number;
  resultHash: string; intents: readonly StoredTextIntent[];
}>;
export type LegacyDraftCheckpoint = CheckpointBinding & Readonly<{ version: 1 }>;
export type HistoryDraftCheckpoint = CheckpointBinding & Readonly<{ version: 2; history: HistoryRecord }>;
export type DraftCheckpoint = LegacyDraftCheckpoint | HistoryDraftCheckpoint;
export type DraftCheckpointSeal = Readonly<{ version: 1; checkpointId: string; recordHash: string }>;
export type DraftRetirement = Readonly<{
  version: 1; checkpointId: string; recordHash: string; sessionId: string;
  draftRevision: number; reason: 'discarded' | 'copied'; createdAt: number;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isStoredTextIntent(value: unknown): value is StoredTextIntent {
  return object(value) && Object.keys(value).length === 5 && typeof value.nodeId === 'string' && /^n(?:0|[1-9][0-9]{0,4})$/u.test(value.nodeId)
    && typeof value.expectedText === 'string' && value.expectedText.length <= MAX_SOURCE_BYTES
    && typeof value.newText === 'string' && value.newText.length <= 128 * 1024
    && isContentHash(value.rawSliceHash) && isContentHash(value.contextFingerprint);
}
export function isDraftCheckpoint(value: unknown): value is DraftCheckpoint {
  if (!object(value) || ![1, 2].includes(value.version as number) || Object.keys(value).length !== (value.version === 2 ? 13 : 12)
    || !isTransactionId(value.checkpointId)
    || !isTransactionId(value.sessionId) || !Number.isSafeInteger(value.draftRevision) || (value.draftRevision as number) < 1
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 1 || !isContentHash(value.targetKey)
    || typeof value.name !== 'string' || !value.name.length || value.name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(value.name)
    || !isStoredFileIdentity(value.identity) || !isContentHash(value.baseHash) || !isContentHash(value.resultHash)
    || !Number.isSafeInteger(value.baseSize) || (value.baseSize as number) < 0 || (value.baseSize as number) > MAX_SOURCE_BYTES
    || !Array.isArray(value.intents) || value.intents.length > MAX_DRAFT_INTENTS) return false;
  if (value.version === 1) { if (!value.intents.every(isStoredTextIntent)) return false; }
  else {
    if (!isHistoryRecord(value.history) || value.history.revision !== value.draftRevision || value.history.baseHash !== value.baseHash
      || value.history.baseSize !== value.baseSize || value.history.candidateHash !== value.resultHash) return false;
    // Only v2 can name proven empty Texts. This is shape validation; core must
    // reconstruct every range from origin.bin and the current baseline.
    if (!value.intents.every(intent => object(intent) && typeof intent.nodeId === 'string'
      && /^n(?:0|[1-9][0-9]{0,4}|1[0-9]{5})$/u.test(intent.nodeId)
      && isStoredTextIntent({ ...intent, nodeId: 'n0' }))) return false;
  }
  return new Set(value.intents.map(item => item.nodeId)).size === value.intents.length;
}
export function isDraftCheckpointSeal(value: unknown): value is DraftCheckpointSeal {
  return object(value) && Object.keys(value).length === 3 && value.version === 1 && isTransactionId(value.checkpointId) && isContentHash(value.recordHash);
}
export function isDraftRetirement(value: unknown): value is DraftRetirement {
  return object(value) && Object.keys(value).length === 7 && value.version === 1 && isTransactionId(value.checkpointId)
    && isContentHash(value.recordHash) && isTransactionId(value.sessionId)
    && Number.isSafeInteger(value.draftRevision) && (value.draftRevision as number) > 0
    && (value.reason === 'discarded' || value.reason === 'copied')
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) > 0;
}
