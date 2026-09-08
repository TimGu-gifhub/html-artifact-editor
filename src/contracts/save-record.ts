import { MAX_SOURCE_BYTES } from './source-tree.ts';

export type StoredFileIdentity = Readonly<{ dev: string; ino: string; mtimeNs: string; ctimeNs: string }>;
export type SaveIntent = Readonly<{
  version: 1; transactionId: string; targetKey: string; name: string; identity: StoredFileIdentity;
  oldHash: string; newHash: string; oldSize: number; newSize: number; createdAt: number;
}>;
export type SaveSeal = Readonly<{ version: 1; transactionId: string; intentHash: string; phase: 'prepared' | 'cancelled' }>;
export type RecoveryState = 'incomplete' | 'invalid' | 'unavailable' | 'wrong-target' | 'baseline-matches' | 'candidate-on-disk' | 'conflict';
export const isTransactionId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const isContentHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const size = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SOURCE_BYTES;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^(?:0|-?[1-9][0-9]{0,39})$/u.test(value);
export function isSaveIntent(value: unknown): value is SaveIntent {
  if (!record(value) || Object.keys(value).length !== 10 || value.version !== 1 || !isTransactionId(value.transactionId)
    || !isContentHash(value.targetKey) || !isContentHash(value.oldHash) || !isContentHash(value.newHash)
    || !size(value.oldSize) || !size(value.newSize) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
    || typeof value.name !== 'string' || !value.name.length || value.name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(value.name)) return false;
  return record(value.identity) && Object.keys(value.identity).length === 4 && decimal(value.identity.dev)
    && decimal(value.identity.ino) && value.identity.ino !== '0' && timestamp(value.identity.mtimeNs) && timestamp(value.identity.ctimeNs);
}
export function isSaveSeal(value: unknown): value is SaveSeal {
  return record(value) && Object.keys(value).length === 4 && value.version === 1 && isTransactionId(value.transactionId)
    && isContentHash(value.intentHash) && (value.phase === 'prepared' || value.phase === 'cancelled');
}
