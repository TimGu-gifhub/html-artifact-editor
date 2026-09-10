import { SAVE_PREPARATION_FILES, SAVE_RESOLUTION_LIMIT } from '../../contracts/save-resolution.ts';
import { isSaveIntent, sameStoredIdentity } from '../../contracts/save-record.ts';
import type { StoredFileIdentity } from '../../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';

type Baseline = Readonly<{ targetKey: string; hash: string; size: number; identity: StoredFileIdentity }>;
function unavailable(): never { throw new Error('SAVE_RECOVERY_INCOMPLETE_UNAVAILABLE'); }
const prefix = (part: Uint8Array, whole: Uint8Array): boolean => part.length <= whole.length && part.every((byte, index) => byte === whole[index]);

// An incomplete preparation can be abandoned only against its complete intent
// and unchanged original. It supplies no backup, candidate or Save authority.
// The resolver also checks partial backup bytes against the authorized source;
// later receipt reads bind those exact bytes and versions, without reopening a
// journal-selected path. Started/cancelled replacement records are excluded.
export async function verifyIncompleteSave(folder: CheckedDirectory, transactionId: string, baseline: Baseline, bytes?: Uint8Array) {
  const entries = await folder.entries(7);
  if (entries.some(item => item.kind !== 'file'
    || !SAVE_PREPARATION_FILES.includes(item.name as typeof SAVE_PREPARATION_FILES[number]))) unavailable();
  const names = new Set(entries.map(item => item.name));
  if (!names.has('intent.json')) unavailable();
  const header = await folder.read('intent.json', SAVE_RESOLUTION_LIMIT);
  const intent: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header.bytes));
  if (!isSaveIntent(intent) || intent.transactionId !== transactionId || intent.targetKey !== baseline.targetKey
    || intent.oldHash !== baseline.hash || intent.oldSize !== baseline.size || !sameStoredIdentity(intent.identity, baseline.identity)
    || intent.oldHash === intent.newHash) unavailable();
  if (bytes && (bytes.length !== intent.oldSize || digest(bytes) !== intent.oldHash)) unavailable();
  const backup = names.has('backup.bin') ? await folder.read('backup.bin', MAX_SOURCE_BYTES) : null;
  if (backup && (backup.bytes.length > intent.oldSize || (bytes && !prefix(backup.bytes, bytes))
    || (backup.bytes.length === intent.oldSize && backup.hash !== intent.oldHash))) unavailable();
  const backupComplete = !!backup && backup.bytes.length === intent.oldSize && backup.hash === intent.oldHash;
  const candidate = names.has('candidate.bin') ? await folder.read('candidate.bin', MAX_SOURCE_BYTES) : null;
  if (candidate && (!backupComplete || candidate.bytes.length > intent.newSize
    || (candidate.bytes.length === intent.newSize && candidate.hash !== intent.newHash))) unavailable();
  const candidateComplete = !!candidate && candidate.bytes.length === intent.newSize && candidate.hash === intent.newHash;
  if (names.has('prepared.json')) {
    if (!backupComplete || !candidateComplete) unavailable();
    const prepared = await folder.read('prepared.json', SAVE_RESOLUTION_LIMIT);
    const expected = new TextEncoder().encode(`${JSON.stringify({ version: 1, transactionId, intentHash: header.hash, phase: 'prepared' })}\n`);
    // A complete seal belongs to ordinary recovery. Only a strict write prefix
    // is evidence for this branch; arbitrary malformed JSON remains blocked.
    if (prepared.bytes.length >= expected.length || !prefix(prepared.bytes, expected)) unavailable();
  }
  await folder.verify();
  return intent;
}
