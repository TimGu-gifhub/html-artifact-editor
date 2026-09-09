import { SAVE_FILES, SAVE_RESOLUTION_LIMIT, isSaveLock, isSaveResolution, saveResolutionName } from '../../contracts/save-resolution.ts';
import type { SaveFile, SaveFileProof, SaveResolution, SaveResolutionSeal } from '../../contracts/save-resolution.ts';
import { sameStoredIdentity } from '../../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { checkedDirectory, digest, sameVersion } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { checkpointRemoval, removalIdentity } from '../../platform/checkpoint-removal.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import type { SaveRecoveryGuard } from '../../platform/windows-recovery-guard.ts';
import { createSavePreparationStore } from './preparation.ts';
import { createDraftCheckpointStore } from './checkpoints.ts';
import { readSaveResolutions } from './save-resolutions.ts';
import { draftOwnership } from './draft-ownership.ts';

type Snapshot = Awaited<ReturnType<CheckedDirectory['read']>>;
type Result = Readonly<{ status: 'resolved' | 'failed' | 'unknown'; observed: SaveResolution['observed']; code: string | null }>;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const text = (file: Snapshot): string => new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
const proof = (file: Snapshot) => Object.freeze({ size: file.bytes.length, hash: file.hash, identity: removalIdentity(file.stat) });
const same = (file: Snapshot, expected: Omit<SaveFileProof, 'name'>): boolean => file.hash === expected.hash && file.bytes.length === expected.size
  && sameStoredIdentity(removalIdentity(file.stat), expected.identity);
const changed = (): never => { throw new Error('SAVE_RECOVERY_CHANGED'); };

// Main supplies a fresh native authorization and profile ownership. Resolution
// never resumes the old Save and never manufactures a committed journal.
export async function prepareSaveResolution(path: string, source: SaveSource, verifyProfile: () => void, guard: SaveRecoveryGuard,
  onStep: (step: string) => Promise<void> = async () => {}) {
  verifyProfile(); const root = await checkedDirectory(path);
  const release = draftOwnership(root.identityChain.map(value => `${value.dev}:${value.ino}`).join('/')).claimMaintenance();
  let cancelled = false; let commitment: Promise<Result> | undefined;
  try {
    const store = await createSavePreparationStore(path); const drafts = await createDraftCheckpointStore(path);
    const lock = await root.read('active.lock', 1024); const lockValue: unknown = JSON.parse(text(lock));
    if (!isSaveLock(lockValue) || lockValue.targetKey !== source.targetKey) throw new Error('SAVE_RECOVERY_UNAVAILABLE');
    const id = lockValue.transactionId; const folder = await root.directory(id);
    const inspect = await store.inspect(id, source.current);
    if (inspect.phase === 'invalid' || inspect.phase === 'incomplete' || !inspect.intent
      || !['baseline-matches', 'candidate-on-disk', 'committed-matches', 'conflict'].includes(inspect.state)) throw new Error('SAVE_RECOVERY_UNAVAILABLE');
    const rows = await readSaveResolutions(root, (await root.entries(512)).map(item => item.name));
    const previous = rows.find(row => row.record.transactionId === id);
    const files: SaveFileProof[] = [];
    for (const entry of await folder.entries(7)) {
      if (entry.kind !== 'file' || !SAVE_FILES.includes(entry.name as SaveFile)) throw new Error('SAVE_RECOVERY_UNAVAILABLE');
      const file = await folder.read(entry.name, entry.name.endsWith('.bin') ? MAX_SOURCE_BYTES : SAVE_RESOLUTION_LIMIT);
      files.push(Object.freeze({ name: entry.name as SaveFile, ...proof(file) }));
    }
    const record: SaveResolution = previous?.record ?? Object.freeze({ version: 1, transactionId: id, targetKey: source.targetKey,
      createdAt: Date.now(), decision: 'keep-current', observed: inspect.state as SaveResolution['observed'],
      current: Object.freeze({ hash: source.baseHash, size: source.size, identity: source.identity }), lockText: text(lock), lock: proof(lock),
      evidence: Object.freeze({ directory: folder.identityChain.at(-1)!, files: Object.freeze(files) }) });
    if (!isSaveResolution(record) || !same(lock, record.lock) || text(lock) !== record.lockText || record.current.hash !== source.baseHash
      || record.current.size !== source.size || !sameStoredIdentity(record.current.identity, source.identity)) changed();
    let receipt = previous?.file ?? null; let complete = previous?.seal ?? null;
    const receiptName = saveResolutionName(id); const completeName = saveResolutionName(id, true);
    let live = (): void => {};
    const verify = async (): Promise<void> => {
      if (cancelled) throw new Error('SAVE_RECOVERY_CANCELLED');
      verifyProfile(); live(); await source.verify(); await root.verify();
      if (!same(await root.read('active.lock', 1024), record.lock)) changed();
      const entries = await root.entries(512);
      const resolutions = await readSaveResolutions(root, entries.map(item => item.name));
      if (resolutions.some(row => !row.seal && row.record.transactionId !== id)) throw new Error('STORAGE_REVIEW_REQUIRED');
      for (const [name, value, limit] of [[receiptName, receipt, SAVE_RESOLUTION_LIMIT], [completeName, complete, 1024]] as const) {
        if (value) { const actual = await root.read(name, limit); if (actual.hash !== value.hash || !sameVersion(actual.stat, value.stat)) changed(); }
        else if (entries.some(item => item.name === name)) changed();
      }
      const current = await store.inspect(id, source.current);
      if (current.phase !== inspect.phase || current.state !== record.observed || !current.intent || current.intent.targetKey !== record.targetKey) changed();
      const identity = (await root.directory(id)).identityChain.at(-1)!;
      if (identity.dev !== record.evidence.directory.dev || identity.ino !== record.evidence.directory.ino
        || (await folder.entries(7)).length !== record.evidence.files.length) changed();
      for (const item of record.evidence.files) if (!same(await folder.read(item.name, item.size), item)) changed();
      const catalog = await drafts.catalog();
      if (catalog.unclassified.some(name => name !== receiptName)) throw new Error('STORAGE_REVIEW_REQUIRED');
      const allSaves = await store.scan();
      if (allSaves.records.some(value => value.phase === 'invalid' || value.phase === 'incomplete')) throw new Error('STORAGE_REVIEW_REQUIRED');
      await source.verify(); verifyProfile(); live();
    };
    await verify(); await onStep('save-recovery-prepared'); await verify();
    const recordBytes = encode(record);
    if (recordBytes.length > SAVE_RESOLUTION_LIMIT) throw new Error('STORAGE_SIZE_LIMIT');
    const capacity = async (count: number, bytes: number): Promise<void> => {
      const entries = await root.entries(512); let used = 0;
      for (const item of entries) used += item.kind === 'file' ? item.size
        : (await (await root.directory(item.name)).entries(7)).reduce((sum, file) => sum + file.size, 0);
      if (entries.length + count > 512 || used + bytes > 200 * 1024 * 1024) throw new Error('BACKUP_LIMIT');
    };
    return Object.freeze({ status: 'prepared' as const,
      summary: Object.freeze({ name: source.name, transactionId: id, phase: inspect.phase, observed: record.observed, decision: 'keep-current' as const }),
      cancel(): boolean { if (commitment) return false; cancelled = true; release(); return true; },
      commit(decision: 'keep-current'): Promise<Result> {
        if (decision !== 'keep-current') throw new Error('SAVE_RECOVERY_DECISION_REQUIRED');
        commitment ??= (async (): Promise<Result> => {
          let started = false; let resolved = false;
          try {
            await verify();
            await guard(source, id, async assertLive => {
              live = assertLive; await verify();
              const before = async (step: string): Promise<void> => { await onStep(`save-recovery-before-${step}`); await verify(); };
              if (!receipt) {
                await before('record'); await capacity(2, recordBytes.length + 1024); live(); started = true;
                await root.writeNew(receiptName, recordBytes, step => onStep(`save-recovery-record-${step}`));
                receipt = await root.read(receiptName, SAVE_RESOLUTION_LIMIT); if (receipt.hash !== digest(recordBytes)) changed();
              }
              await verify(); await onStep('save-recovery-record-ready');
              if (!complete) {
                const seal: SaveResolutionSeal = { version: 1, transactionId: id, resolutionHash: receipt.hash, phase: 'complete' };
                await before('complete'); await capacity(1, 1024); live(); started = true;
                await root.writeNew(completeName, encode(seal), step => onStep(`save-recovery-complete-${step}`));
                complete = await root.read(completeName, 1024); if (complete.hash !== digest(encode(seal))) changed();
              }
              await onStep('save-recovery-complete-ready'); await verify(); started = true;
              await checkpointRemoval(root).recoveryLock(record.lock, () => before('lock'));
              resolved = true; await onStep('save-recovery-after-lock');
            });
            return Object.freeze({ status: 'resolved', observed: record.observed, code: null });
          } catch (error) {
            const code = error instanceof Error && /^(?:SAVE_|STORAGE_|BACKUP_|FILE_CHANGED)[A-Z_]*$/u.test(error.message) ? error.message : 'SAVE_RECOVERY_FAILED';
            return Object.freeze({ status: resolved ? 'resolved' : started ? 'unknown' : 'failed', observed: record.observed,
              code: resolved ? 'SAVE_RECOVERY_CONFIRMED_WITH_WARNING' : code });
          } finally { release(); }
        })();
        return commitment;
      },
    });
  } catch (error) { release(); throw error; }
}
