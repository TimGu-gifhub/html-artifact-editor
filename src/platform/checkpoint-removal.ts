import type { BigIntStats } from 'node:fs';
import { lstat, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECKPOINT_FILES, COMPACTION_LIMIT, isDirectoryIdentity } from '../contracts/checkpoint-compaction.ts';
import type { DirectoryIdentity, FileRemovalProof } from '../contracts/checkpoint-compaction.ts';
import { isContentHash, isStoredFileIdentity, isTransactionId, sameStoredIdentity } from '../contracts/save-record.ts';
import { MAX_DRAFT_RECORD_BYTES } from '../contracts/draft-checkpoint.ts';
import { sameVersion } from './storage-files.ts';
import type { CheckedDirectory } from './storage-files.ts';

export const removalIdentity = (stat: BigIntStats) => Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString(),
  mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() });
const absent = async (path: string): Promise<void> => {
  try { await lstat(path); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
  throw new Error('DRAFT_COMPACTION_CHANGED');
};
// Main supplies its checked private root. Only four fixed checkpoint filenames,
// an empty UUID child, and the exact owned journal can be removed; never recurse.
export function checkpointRemoval(root: CheckedDirectory) {
  const folderFor = async (id: string, expected: DirectoryIdentity) => {
    if (!isTransactionId(id) || !isDirectoryIdentity(expected)) throw new Error('DRAFT_COMPACTION_INVALID');
    await root.verify(); const folder = await root.directory(id); const identity = folder.identityChain.at(-1)!;
    if (identity.dev !== expected.dev || identity.ino !== expected.ino) throw new Error('DRAFT_COMPACTION_CHANGED');
    return folder;
  };
  const removeFile = async (folder: CheckedDirectory, name: string, proof: Omit<FileRemovalProof, 'name'>,
    limit: number, onVerified: () => Promise<void>) => {
    if (!isContentHash(proof.hash) || !isStoredFileIdentity(proof.identity) || !Number.isSafeInteger(proof.size)
      || proof.size < 0 || proof.size > limit) throw new Error('DRAFT_COMPACTION_INVALID');
    const file = await folder.read(name, proof.size);
    if (file.hash !== proof.hash || file.bytes.length !== proof.size || !sameStoredIdentity(removalIdentity(file.stat), proof.identity)) throw new Error('DRAFT_COMPACTION_CHANGED');
    await onVerified(); await folder.verify();
    const path = join(folder.path, name);
    if (!sameVersion(file.stat, await lstat(path, { bigint: true }))) throw new Error('DRAFT_COMPACTION_CHANGED');
    await unlink(path); await absent(path); await folder.verify(); await root.verify();
  };
  return Object.freeze({
    async file(id: string, directory: DirectoryIdentity, proof: FileRemovalProof, onVerified: () => Promise<void>) {
      if (!CHECKPOINT_FILES.includes(proof.name)) throw new Error('DRAFT_COMPACTION_INVALID');
      await removeFile(await folderFor(id, directory), proof.name, proof, MAX_DRAFT_RECORD_BYTES, onVerified);
    },
    async empty(id: string, directory: DirectoryIdentity, onVerified: () => Promise<void>) {
      const folder = await folderFor(id, directory);
      if ((await folder.entries(1)).length) throw new Error('DRAFT_COMPACTION_CHANGED');
      await onVerified(); await folder.verify(); await root.verify();
      await rmdir(folder.path); await absent(folder.path); await root.verify();
    },
    async journal(proof: Omit<FileRemovalProof, 'name'>, onVerified: () => Promise<void>) {
      await removeFile(root, 'compaction.json', proof, COMPACTION_LIMIT, onVerified);
    },
  });
}
