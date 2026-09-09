import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';
import type { StoredFileIdentity } from './save-record.ts';
import { MAX_SOURCE_BYTES } from './source-tree.ts';

export const MAX_DRAFT_INTENTS = 1000;
export const MAX_DRAFT_RECORD_BYTES = 24 * 1024 * 1024;
export type StoredTextIntent = Readonly<{
  nodeId: string; expectedText: string; newText: string; rawSliceHash: string; contextFingerprint: string;
}>;
export type DraftCheckpoint = Readonly<{
  version: 1; checkpointId: string; sessionId: string; draftRevision: number; createdAt: number;
  targetKey: string; name: string; identity: StoredFileIdentity; baseHash: string; baseSize: number;
  resultHash: string; intents: readonly StoredTextIntent[];
}>;
export type DraftCheckpointSeal = Readonly<{ version: 1; checkpointId: string; recordHash: string }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isStoredTextIntent(value: unknown): value is StoredTextIntent {
  return object(value) && Object.keys(value).length === 5 && typeof value.nodeId === 'string' && /^n(?:0|[1-9][0-9]{0,4})$/u.test(value.nodeId)
    && typeof value.expectedText === 'string' && value.expectedText.length <= MAX_SOURCE_BYTES
    && typeof value.newText === 'string' && value.newText.length <= 128 * 1024
    && isContentHash(value.rawSliceHash) && isContentHash(value.contextFingerprint);
}
export function isDraftCheckpoint(value: unknown): value is DraftCheckpoint {
  if (!object(value) || Object.keys(value).length !== 12 || value.version !== 1 || !isTransactionId(value.checkpointId)
    || !isTransactionId(value.sessionId) || !Number.isSafeInteger(value.draftRevision) || (value.draftRevision as number) < 1
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 1 || !isContentHash(value.targetKey)
    || typeof value.name !== 'string' || !value.name.length || value.name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(value.name)
    || !isStoredFileIdentity(value.identity) || !isContentHash(value.baseHash) || !isContentHash(value.resultHash)
    || !Number.isSafeInteger(value.baseSize) || (value.baseSize as number) < 0 || (value.baseSize as number) > MAX_SOURCE_BYTES
    || !Array.isArray(value.intents) || value.intents.length > MAX_DRAFT_INTENTS || !value.intents.every(isStoredTextIntent)) return false;
  return new Set(value.intents.map(item => item.nodeId)).size === value.intents.length;
}
export function isDraftCheckpointSeal(value: unknown): value is DraftCheckpointSeal {
  return object(value) && Object.keys(value).length === 3 && value.version === 1 && isTransactionId(value.checkpointId) && isContentHash(value.recordHash);
}
