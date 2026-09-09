import { RESOLUTION_LIMIT, isCompactionResolution, isCompactionResolutionSeal, resolutionFile, resolutionName } from '../../contracts/compaction-resolution.ts';
import { digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
// Receipts preserve the old journal and lock before explicit recovery removes
// either. A seal proves the selected deletions were verified, never an HTML save.
export async function readCompactionResolutions(root: CheckedDirectory, names: readonly string[]) {
  const selected = names.filter(name => resolutionFile(name)); const rows = [];
  const ids = new Set(selected.map(name => resolutionFile(name)!.id));
  for (const id of ids) {
    const name = resolutionName(id); const completeName = resolutionName(id, true);
    if (!selected.includes(name)) throw new Error('STORAGE_REVIEW_REQUIRED');
    const file = await root.read(name, RESOLUTION_LIMIT); const record = decode(file.bytes);
    if (!isCompactionResolution(record) || record.compactionId !== id) throw new Error('STORAGE_REVIEW_REQUIRED');
    for (const [text, proof] of [[record.journalText, record.journal], [record.lockText, record.lock]] as const) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length !== proof.size || digest(bytes) !== proof.hash) throw new Error('STORAGE_REVIEW_REQUIRED');
    }
    const seal = selected.includes(completeName) ? await root.read(completeName, 1024) : null;
    if (seal) {
      const value = decode(seal.bytes);
      if (!isCompactionResolutionSeal(value) || value.compactionId !== id || value.resolutionHash !== file.hash) throw new Error('STORAGE_REVIEW_REQUIRED');
    }
    rows.push({ name, completeName, record, file, seal });
  }
  return rows;
}
