import { SAVE_RESOLUTION_LIMIT, isSaveResolution, isSaveResolutionSeal, saveResolutionFile, saveResolutionName } from '../../contracts/save-resolution.ts';
import { sameStoredIdentity } from '../../contracts/save-record.ts';
import { digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { removalIdentity } from '../../platform/checkpoint-removal.ts';
import { verifyIncompleteSave } from './incomplete-save.ts';

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
// The original transaction remains the backup authority. A receipt records an
// explicit decision about a freshly authorized file; it is never a SaveCommit.
export async function readSaveResolutions(root: CheckedDirectory, names: readonly string[]) {
  const selected = names.filter(name => saveResolutionFile(name)); const rows = [];
  for (const id of new Set(selected.map(name => saveResolutionFile(name)!.id))) {
    const name = saveResolutionName(id); const completeName = saveResolutionName(id, true);
    if (!selected.includes(name)) throw new Error('STORAGE_REVIEW_REQUIRED');
    const file = await root.read(name, SAVE_RESOLUTION_LIMIT); const record = decode(file.bytes);
    if (!isSaveResolution(record) || record.transactionId !== id) throw new Error('STORAGE_REVIEW_REQUIRED');
    const lock = new TextEncoder().encode(record.lockText);
    if (lock.length !== record.lock.size || digest(lock) !== record.lock.hash) throw new Error('STORAGE_REVIEW_REQUIRED');
    const folder = await root.directory(id); const identity = folder.identityChain.at(-1)!;
    if (identity.dev !== record.evidence.directory.dev || identity.ino !== record.evidence.directory.ino) throw new Error('STORAGE_REVIEW_REQUIRED');
    const entries = await folder.entries(7);
    if (entries.length !== record.evidence.files.length) throw new Error('STORAGE_REVIEW_REQUIRED');
    for (const item of record.evidence.files) {
      const actual = await folder.read(item.name, item.size);
      if (actual.bytes.length !== item.size || actual.hash !== item.hash || !sameStoredIdentity(removalIdentity(actual.stat), item.identity)) throw new Error('STORAGE_REVIEW_REQUIRED');
    }
    if (record.version === 2) await verifyIncompleteSave(folder, id, { targetKey: record.targetKey, ...record.current });
    const seal = selected.includes(completeName) ? await root.read(completeName, 1024) : null;
    if (seal) {
      const value = decode(seal.bytes);
      if (!isSaveResolutionSeal(value) || value.transactionId !== id || value.resolutionHash !== file.hash) throw new Error('STORAGE_REVIEW_REQUIRED');
    }
    rows.push({ name, completeName, record, file, seal });
  }
  return rows;
}
