import { randomUUID } from 'node:crypto';
import { isContentHash, isSaveIntent, isSaveSeal, isTransactionId } from '../../contracts/save-record.ts';
import type { RecoveryState, SaveIntent, SaveSeal } from '../../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import { checkedDirectory, digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import type { SaveSource, SaveTargetState } from '../../platform/save-source.ts';

const JSON_LIMIT = 16 * 1024;
const STORE_LIMIT = 200 * 1024 * 1024;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
type Lock = Awaited<ReturnType<CheckedDirectory['writeNew']>>;
export type PreparationResult = Readonly<{ status: 'failed'; code: string; transactionId: string | null; cancel: null }>
  | Readonly<{ status: 'prepared'; code: null; transactionId: string; intent: SaveIntent; cancel: () => Promise<void> }>;
export type PreparationInspection = Readonly<{
  transactionId: string; phase: 'incomplete' | 'invalid' | 'prepared' | 'cancelled';
  state: RecoveryState; intent: SaveIntent | null;
}>;
async function optionalRead(folder: CheckedDirectory, name: string, limit: number) {
  try { return await folder.read(name, limit); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
}
const immutableIntent = (value: SaveIntent): SaveIntent => Object.freeze({ ...value, identity: Object.freeze({ ...value.identity }) });
const codeFor = (error: unknown): string => {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  if (value.code === 'EEXIST') return 'SAVE_LOCKED';
  if (value.code === 'ENOSPC') return 'BACKUP_DISK_FULL';
  if (value.code === 'EACCES' || value.code === 'EPERM') return 'BACKUP_PERMISSION_DENIED';
  if (typeof value.message === 'string' && /^(?:STORAGE_[A-Z_]+|SAVE_[A-Z_]+|BACKUP_[A-Z_]+|FILE_CHANGED)$/u.test(value.message)) return value.message;
  return 'BACKUP_FAILED';
};

// A dedicated directory beneath Main's private app data, never a project root.
// Preparation writes only private evidence. It has no HTML replace/rename API.
export async function createSavePreparationStore(path: string, onStep: (step: string) => Promise<void> = async () => {}) {
  const root = await checkedDirectory(path); let busy = false;
  const checkQuota = async (source: SaveSource, candidateSize: number): Promise<void> => {
    const entries = await root.entries(512); let used = 0; let count = 0;
    for (const item of entries) {
      if (item.name === 'active.lock' && item.kind === 'file') { used += item.size; continue; }
      if (item.kind !== 'directory' || !isTransactionId(item.name)) throw new Error('STORAGE_REVIEW_REQUIRED');
      const folder = await root.directory(item.name);
      for (const file of await folder.entries(5)) {
        if (file.kind !== 'file' || !['intent.json', 'backup.bin', 'candidate.bin', 'prepared.json', 'cancelled.json'].includes(file.name)) throw new Error('STORAGE_REVIEW_REQUIRED');
        used += file.size;
      }
      const record = decode((await folder.read('intent.json', JSON_LIMIT)).bytes);
      if (!isSaveIntent(record) || record.transactionId !== item.name) throw new Error('STORAGE_REVIEW_REQUIRED');
      if (record.targetKey === source.targetKey) count++;
    }
    // No automatic pruning, especially of incomplete records or the last backup.
    if (count >= 20 || used + source.size + candidateSize + JSON_LIMIT > STORE_LIMIT) throw new Error('BACKUP_LIMIT');
  };
  const inspect = async (transactionId: string, readTarget?: () => Promise<SaveTargetState>): Promise<PreparationInspection> => {
    let intent: SaveIntent | null = null;
    const result = (phase: PreparationInspection['phase'], state: RecoveryState): PreparationInspection =>
      Object.freeze({ transactionId, phase, state, intent });
    try {
      if (!isTransactionId(transactionId)) return result('invalid', 'invalid');
      const folder = await root.directory(transactionId);
      const header = await optionalRead(folder, 'intent.json', JSON_LIMIT);
      if (!header) return result('incomplete', 'incomplete');
      const decoded = decode(header.bytes);
      if (!isSaveIntent(decoded) || decoded.transactionId !== transactionId) return result('invalid', 'invalid');
      intent = immutableIntent(decoded);
      const backup = await optionalRead(folder, 'backup.bin', MAX_SOURCE_BYTES);
      const candidate = await optionalRead(folder, 'candidate.bin', MAX_SOURCE_BYTES);
      const prepared = await optionalRead(folder, 'prepared.json', JSON_LIMIT);
      const cancelled = await optionalRead(folder, 'cancelled.json', JSON_LIMIT);
      if ((backup && (backup.hash !== intent.oldHash || backup.bytes.length !== intent.oldSize))
        || (candidate && (candidate.hash !== intent.newHash || candidate.bytes.length !== intent.newSize))) return result('invalid', 'invalid');
      if (!backup || !candidate || !prepared) return result('incomplete', 'incomplete');
      const matches = (bytes: Uint8Array, phase: SaveSeal['phase']): boolean => {
        const seal = decode(bytes);
        return isSaveSeal(seal) && seal.phase === phase && seal.transactionId === transactionId && seal.intentHash === header.hash;
      };
      if (!matches(prepared.bytes, 'prepared') || (cancelled && !matches(cancelled.bytes, 'cancelled'))) return result('invalid', 'invalid');
      const phase = cancelled ? 'cancelled' : 'prepared';
      if (!readTarget) return result(phase, 'unavailable');
      let target: SaveTargetState;
      try { target = await readTarget(); } catch { return result(phase, 'unavailable'); }
      if (target.targetKey !== intent.targetKey) return result(phase, 'wrong-target');
      if (target.hash === intent.oldHash && target.identity.dev === intent.identity.dev && target.identity.ino === intent.identity.ino
        && target.identity.mtimeNs === intent.identity.mtimeNs && target.identity.ctimeNs === intent.identity.ctimeNs) return result(phase, 'baseline-matches');
      // Matching candidate bytes alone never constitute a committed save.
      if (target.hash === intent.newHash) return result(phase, 'candidate-on-disk');
      return result(phase, 'conflict');
    } catch { return result('invalid', 'invalid'); }
  };
  return Object.freeze({ inspect,
    async scan() {
      // Discovery reads only our bounded private namespace, never source paths
      // from a journal. Any existing lock, including a partial one, stays put.
      const entries = await root.entries(512); const records: PreparationInspection[] = [];
      let locked = false; let unrecognized = false;
      for (const item of entries) {
        if (item.name === 'active.lock') { locked = true; continue; }
        if (item.kind === 'directory' && isTransactionId(item.name)) records.push(await inspect(item.name));
        else unrecognized = true;
      }
      await root.verify();
      return Object.freeze({ records: Object.freeze(records), locked, unrecognized });
    },
    async prepare(source: SaveSource, candidate: Pick<PatchCandidate, 'bytes' | 'baseHash' | 'resultHash'>): Promise<PreparationResult> {
      let transactionId: string | null = null; let lock: Lock | undefined; let retained = false;
      if (busy) return Object.freeze({ status: 'failed', code: 'SAVE_BUSY', transactionId, cancel: null });
      busy = true;
      try {
        const bytes = new Uint8Array(candidate.bytes); // Freeze before the first await.
        if (bytes.length > MAX_SOURCE_BYTES || !isContentHash(candidate.resultHash) || digest(bytes) !== candidate.resultHash
          || candidate.baseHash !== source.baseHash) throw new Error('SAVE_INVALID_CANDIDATE');
        if (candidate.resultHash === source.baseHash) throw new Error('SAVE_NO_CHANGES');
        await source.verify();
        const id = randomUUID();
        lock = await root.writeNew('active.lock', encode({ version: 1, transactionId: id, targetKey: source.targetKey }), (step) => onStep(`lock-${step}`));
        await source.verify(); await checkQuota(source, bytes.length);
        const folder = await root.directory(id, true); transactionId = id;
        await onStep('directory');
        const intent: SaveIntent = immutableIntent({ version: 1, transactionId: id, targetKey: source.targetKey,
          name: source.name, identity: source.identity, oldHash: source.baseHash, newHash: digest(bytes),
          oldSize: source.size, newSize: bytes.length, createdAt: Date.now() });
        if (!isSaveIntent(intent)) throw new Error('SAVE_INVALID_INTENT');
        const header = await folder.writeNew('intent.json', encode(intent), (step) => onStep(`intent-${step}`));
        await folder.writeNew('backup.bin', source.bytes, (step) => onStep(`backup-${step}`));
        // Validate the backup independently before preparing the candidate/seal.
        if ((await folder.read('backup.bin', MAX_SOURCE_BYTES)).hash !== source.baseHash) throw new Error('BACKUP_VERIFY_FAILED');
        await source.verify();
        await folder.writeNew('candidate.bin', bytes, (step) => onStep(`candidate-${step}`));
        const seal: SaveSeal = Object.freeze({ version: 1, transactionId: id, intentHash: header.hash, phase: 'prepared' });
        await folder.writeNew('prepared.json', encode(seal), (step) => onStep(`prepared-${step}`));
        const evidence = await inspect(id, source.current);
        await source.verify(); // A late external edit is a conflict, not a backup failure.
        if (evidence.phase !== 'prepared' || evidence.state !== 'baseline-matches') throw new Error('BACKUP_VERIFY_FAILED');
        await root.verify(); retained = true;
        let cancellation: Promise<void> | undefined;
        return Object.freeze({ status: 'prepared', code: null, transactionId: id, intent,
          cancel(): Promise<void> {
            cancellation ??= (async () => {
              // Cancellation only releases our verified private lock. Evidence stays.
              await folder.writeNew('cancelled.json', encode({ ...seal, phase: 'cancelled' }));
              await lock!.removeOwned(); busy = false;
            })();
            return cancellation;
          },
        });
      } catch (error) {
        // No HTML write exists in this stage. Partial private evidence remains.
        let code = codeFor(error);
        if (lock) { try { await lock.removeOwned(); } catch { code = 'STORAGE_LOCK_CHANGED'; } }
        return Object.freeze({ status: 'failed', code, transactionId, cancel: null });
      } finally { if (!retained) busy = false; }
    },
  });
}
