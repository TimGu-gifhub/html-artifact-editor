import { MAX_SOURCE_BYTES } from './source-tree.ts';

export type StoredFileIdentity = Readonly<{ dev: string; ino: string; mtimeNs: string; ctimeNs: string }>;
export type RestoreReference = Readonly<{ transactionId: string; intentHash: string }>;
type IntentFields = Readonly<{
  transactionId: string; targetKey: string; name: string; identity: StoredFileIdentity;
  oldHash: string; newHash: string; oldSize: number; newSize: number; createdAt: number;
}>;
export type SaveIntent = IntentFields & (Readonly<{ version: 1 }> | Readonly<{ version: 2; restoreOf: RestoreReference }>);
export type SaveSeal = Readonly<{ version: 1; transactionId: string; intentHash: string; phase: 'prepared' | 'cancelled' | 'replacing' }>;
export type SaveCommit = Readonly<{ version: 1; transactionId: string; intentHash: string; phase: 'committed'; resultHash: string; identity: StoredFileIdentity }>;
export type RecoveryState = 'incomplete' | 'invalid' | 'unavailable' | 'wrong-target' | 'baseline-matches' | 'candidate-on-disk' | 'committed-matches' | 'conflict';
export const isTransactionId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const isContentHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const size = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SOURCE_BYTES;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^(?:0|-?[1-9][0-9]{0,39})$/u.test(value);
export function isStoredFileIdentity(value: unknown): value is StoredFileIdentity {
  return record(value) && Object.keys(value).length === 4 && decimal(value.dev) && decimal(value.ino)
    && value.ino !== '0' && timestamp(value.mtimeNs) && timestamp(value.ctimeNs);
}
export const sameStoredIdentity = (a: StoredFileIdentity, b: StoredFileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export function isRestoreReference(value: unknown): value is RestoreReference {
  return record(value) && Object.keys(value).length === 2 && isTransactionId(value.transactionId) && isContentHash(value.intentHash);
}
export function isSaveIntent(value: unknown): value is SaveIntent {
  if (!record(value) || (value.version === 1 ? Object.keys(value).length !== 10
    : value.version !== 2 || Object.keys(value).length !== 11 || !isRestoreReference(value.restoreOf)
      || value.restoreOf.transactionId === value.transactionId) || !isTransactionId(value.transactionId)
    || !isContentHash(value.targetKey) || !isContentHash(value.oldHash) || !isContentHash(value.newHash)
    || !size(value.oldSize) || !size(value.newSize) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
    || typeof value.name !== 'string' || !value.name.length || value.name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(value.name)) return false;
  return isStoredFileIdentity(value.identity);
}
export function isSaveSeal(value: unknown): value is SaveSeal {
  return record(value) && Object.keys(value).length === 4 && value.version === 1 && isTransactionId(value.transactionId)
    && isContentHash(value.intentHash) && (value.phase === 'prepared' || value.phase === 'cancelled' || value.phase === 'replacing');
}
export function isSaveCommit(value: unknown): value is SaveCommit {
  return record(value) && Object.keys(value).length === 6 && value.version === 1 && isTransactionId(value.transactionId)
    && isContentHash(value.intentHash) && value.phase === 'committed' && isContentHash(value.resultHash) && isStoredFileIdentity(value.identity);
}
