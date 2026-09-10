import { lstat, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CLEANUP_DRAFT_FILES, CLEANUP_SAVE_FILES, CLEANUP_JOURNAL, CLEANUP_LIMIT, cleanupRootFile } from '../contracts/record-cleanup.ts';
import type { CleanupFile, CleanupFolder } from '../contracts/record-cleanup.ts';
import { isTransactionId, sameStoredIdentity } from '../contracts/save-record.ts';
import { removalIdentity } from './checkpoint-removal.ts';
import { sameVersion } from './storage-files.ts';
import type { CheckedDirectory } from './storage-files.ts';

// An explicitly reviewed private-store manifest supplies fixed names only.
// Project paths, recursion, links and directories containing new files are not accepted.
export function recordRemoval(root: CheckedDirectory) {
  const absent = async (path: string) => {
    try { await lstat(path); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
    throw new Error('RECORD_CLEANUP_CHANGED');
  };
  const folderFor = async (row: CleanupFolder) => {
    if (!isTransactionId(row.id)) throw new Error('RECORD_CLEANUP_INVALID');
    await root.verify(); const folder = await root.directory(row.id); const identity = folder.identityChain.at(-1)!;
    if (identity.dev !== row.identity.dev || identity.ino !== row.identity.ino) throw new Error('RECORD_CLEANUP_CHANGED');
    return folder;
  };
  const remove = async (folder: CheckedDirectory, proof: CleanupFile, verified: () => Promise<void>) => {
    const file = await folder.read(proof.name, proof.size);
    if (file.hash !== proof.hash || file.bytes.length !== proof.size || !sameStoredIdentity(removalIdentity(file.stat), proof.identity)) throw new Error('RECORD_CLEANUP_CHANGED');
    await verified(); await folder.verify();
    const path = join(folder.path, proof.name);
    if (!sameVersion(file.stat, await lstat(path, { bigint: true }))) throw new Error('RECORD_CLEANUP_CHANGED');
    await unlink(path); await absent(path); await folder.verify(); await root.verify();
  };
  return Object.freeze({
    async file(row: CleanupFolder, proof: CleanupFile, verified: () => Promise<void>) {
      const allowed: readonly string[] = row.kind === 'draft' ? CLEANUP_DRAFT_FILES : CLEANUP_SAVE_FILES;
      if (!allowed.includes(proof.name)) throw new Error('RECORD_CLEANUP_INVALID');
      await remove(await folderFor(row), proof, verified);
    },
    async empty(row: CleanupFolder, verified: () => Promise<void>) {
      const folder = await folderFor(row);
      if ((await folder.entries(1)).length) throw new Error('RECORD_CLEANUP_CHANGED');
      await verified(); await folder.verify(); await root.verify(); await rmdir(folder.path); await absent(folder.path); await root.verify();
    },
    async receipt(proof: CleanupFile, verified: () => Promise<void>) {
      if (!cleanupRootFile(proof.name)) throw new Error('RECORD_CLEANUP_INVALID');
      await remove(root, proof, verified);
    },
    async journal(proof: CleanupFile, verified: () => Promise<void>) {
      if (proof.name !== CLEANUP_JOURNAL || proof.size > CLEANUP_LIMIT) throw new Error('RECORD_CLEANUP_INVALID');
      await remove(root, proof, verified);
    },
  });
}
