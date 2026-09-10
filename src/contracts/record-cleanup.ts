import { isContentHash, isStoredFileIdentity, isTransactionId } from './save-record.ts';
import type { StoredFileIdentity } from './save-record.ts';
import { isDirectoryIdentity } from './checkpoint-compaction.ts';
import type { DirectoryIdentity } from './checkpoint-compaction.ts';
import { MAX_DRAFT_RECORD_BYTES } from './draft-checkpoint.ts';
import { saveResolutionFile } from './save-resolution.ts';
import { resolutionFile } from './compaction-resolution.ts';

export const CLEANUP_JOURNAL = 'record-cleanup.json';
export const CLEANUP_LIMIT = 2 * 1024 * 1024;
export const CLEANUP_DRAFT_FILES = ['baseline.bin', 'origin.bin', 'complete.json', 'retired.json', 'record.json'] as const;
export const CLEANUP_SAVE_FILES = ['backup.bin', 'candidate.bin', 'prepared.json', 'cancelled.json', 'replacing.json', 'committed.json', 'intent.json'] as const;
export type CleanupFile = Readonly<{ name: string; hash: string; size: number; identity: StoredFileIdentity }>;
export type CleanupFolder = Readonly<{ id: string; kind: 'draft' | 'save'; identity: DirectoryIdentity; files: readonly CleanupFile[] }>;
export type CleanupCounts = Readonly<{ records: number; sessions: number; unsavedDrafts: number; backups: number; bytes: number }>;
export type CleanupManifest = Readonly<{ version: 1; cleanupId: string; createdAt: number; root: DirectoryIdentity;
  summary: CleanupCounts; folders: readonly CleanupFolder[]; files: readonly CleanupFile[] }>;
export type CleanupSummary = CleanupCounts & Readonly<{ reviewId: string; resuming: boolean }>;
export type CleanupState = Readonly<{ phase: 'idle' | 'checking' | 'reviewing' | 'cleaning'; summary: CleanupSummary | null;
  result: Readonly<{ status: 'cleared' | 'cancelled' | 'unavailable' | 'failed' | 'unknown'; code: string | null }> | null;
  requiresReview: boolean }>;
export const cleanupRootFile = (name: string): boolean => !!saveResolutionFile(name) || !!resolutionFile(name);
export const cleanupOrder = (a: CleanupFolder, b: CleanupFolder): number =>
  Number(a.files.some(file => file.name === 'retired.json')) - Number(b.files.some(file => file.name === 'retired.json')) || a.id.localeCompare(b.id);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
function file(value: unknown): value is CleanupFile {
  return object(value) && Object.keys(value).length === 4 && typeof value.name === 'string' && isContentHash(value.hash)
    && count(value.size, MAX_DRAFT_RECORD_BYTES) && isStoredFileIdentity(value.identity);
}
export function isCleanupManifest(value: unknown): value is CleanupManifest {
  if (!object(value) || Object.keys(value).length !== 7 || value.version !== 1 || !isTransactionId(value.cleanupId)
    || !count(value.createdAt, Number.MAX_SAFE_INTEGER) || !value.createdAt || !isDirectoryIdentity(value.root)
    || !object(value.summary) || Object.keys(value.summary).length !== 5
    || !count(value.summary.records, 512) || !count(value.summary.sessions, 512) || !count(value.summary.unsavedDrafts, 512) || !count(value.summary.backups, 512)
    || !count(value.summary.bytes, 200 * 1024 * 1024) || !Array.isArray(value.folders) || !Array.isArray(value.files)
    || value.folders.length + value.files.length > 512 || value.summary.records !== value.folders.length) return false;
  const folders: CleanupFolder[] = [];
  for (const row of value.folders) {
    if (!object(row) || Object.keys(row).length !== 4 || !isTransactionId(row.id) || !['draft', 'save'].includes(row.kind as string)
      || !isDirectoryIdentity(row.identity) || !Array.isArray(row.files) || !row.files.length || !row.files.every(file)) return false;
    const order: readonly string[] = row.kind === 'draft' ? CLEANUP_DRAFT_FILES : CLEANUP_SAVE_FILES;
    const selected = row.files;
    if (selected.some((item, index) => !order.includes(item.name) || (index > 0 && order.indexOf(selected[index - 1]!.name) >= order.indexOf(item.name)))) return false;
    if (!row.files.some(item => item.name === (row.kind === 'draft' ? 'record.json' : 'intent.json'))) return false;
    folders.push(row as CleanupFolder);
  }
  if (!value.files.every(file)) return false;
  const receipts = value.files;
  if (new Set(folders.map(row => row.id)).size !== folders.length || folders.some((row, index) => index > 0 && cleanupOrder(folders[index - 1]!, row) >= 0)
    || receipts.some((row, index) => !cleanupRootFile(row.name)
      || (index > 0 && receipts[index - 1]!.name.localeCompare(row.name) >= 0))) return false;
  const bytes = [...folders.flatMap(row => row.files), ...receipts].reduce((sum, item) => sum + item.size, 0);
  return bytes === value.summary.bytes && value.summary.unsavedDrafts <= value.summary.sessions
    && value.summary.sessions <= folders.filter(row => row.kind === 'draft').length
    && value.summary.backups <= folders.filter(row => row.kind === 'save').length;
}
export function isCleanupDecision(value: unknown, summary: CleanupSummary): value is Readonly<{ reviewId: string; decision: 'clear-records' | 'cancel' }> {
  return object(value) && Object.keys(value).length === 2 && value.reviewId === summary.reviewId
    && (value.decision === 'clear-records' || value.decision === 'cancel');
}
