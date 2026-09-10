import { CLEANUP_JOURNAL, CLEANUP_LIMIT, isCleanupManifest } from '../../contracts/record-cleanup.ts';
import type { CleanupFile, CleanupFolder, CleanupManifest } from '../../contracts/record-cleanup.ts';
import type { DirectoryIdentity } from '../../contracts/checkpoint-compaction.ts';
import { sameStoredIdentity } from '../../contracts/save-record.ts';
import { checkedDirectory, digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { removalIdentity } from '../../platform/checkpoint-removal.ts';
import { recordRemoval } from '../../platform/record-removal.ts';
import { draftOwnership } from './draft-ownership.ts';
import { cleanupProof, inspectCleanupInventory } from './cleanup-inventory.ts';

type Result = Readonly<{ status: 'cleared' | 'failed' | 'unknown'; code: string | null }>;
type Item = Readonly<{ folder: CleanupFolder; file: CleanupFile | null }> | Readonly<{ folder: null; file: CleanupFile }>;
const changed = (): never => { throw new Error('RECORD_CLEANUP_CHANGED'); };
const same = (file: Awaited<ReturnType<CheckedDirectory['read']>>, proof: CleanupFile) => file.hash === proof.hash
  && file.bytes.length === proof.size && sameStoredIdentity(removalIdentity(file.stat), proof.identity);

export async function prepareRecordCleanup(path: string, verifyProfile: () => void, onStep: (step: string) => Promise<void> = async () => {},
  expectedNamespace?: readonly DirectoryIdentity[]) {
  verifyProfile(); const root = await checkedDirectory(path);
  if (expectedNamespace && (expectedNamespace.length !== root.identityChain.length || expectedNamespace.some((entry, index) =>
    entry.dev !== root.identityChain[index]!.dev || entry.ino !== root.identityChain[index]!.ino))) throw new Error('RECORD_CLEANUP_ROOT_MISMATCH');
  const release = draftOwnership(root.identityChain.map(row => `${row.dev}:${row.ino}`).join('/')).claimMaintenance();
  let cancelled = false; let commitment: Promise<Result> | undefined;
  try {
    const entries = await root.entries(513);
    let journal: CleanupFile | null = null; let manifest: CleanupManifest;
    if (entries.some(row => row.name === CLEANUP_JOURNAL)) {
      const file = await root.read(CLEANUP_JOURNAL, CLEANUP_LIMIT);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
      catch { throw new Error('RECORD_CLEANUP_INVALID'); }
      if (!isCleanupManifest(value)) throw new Error('RECORD_CLEANUP_INVALID');
      // Keep the parsed manifest private, without returning write authority.
      manifest = value; journal = cleanupProof(CLEANUP_JOURNAL, file);
    } else manifest = await inspectCleanupInventory(root);
    const identity = root.identityChain.at(-1)!;
    if (identity.dev !== manifest.root.dev || identity.ino !== manifest.root.ino) changed();
    const items: Item[] = manifest.folders.flatMap(folder => [...folder.files.map(file => ({ folder, file })), { folder, file: null }]);
    items.push(...manifest.files.map(file => ({ folder: null, file })));
    const resuming = journal !== null;
    // Remaining files must be an exact suffix of the approved deletion order.
    // Validate all remaining bytes at preparation/confirmation; before each
    // removal recheck the namespace and journal, then verify that target again.
    const remaining = async (bytes: boolean): Promise<number> => {
      if (cancelled) throw new Error('RECORD_CLEANUP_CANCELLED');
      verifyProfile(); await root.verify(); const rootEntries = await root.entries(513);
      if (rootEntries.some(row => row.name !== CLEANUP_JOURNAL
        && !manifest.folders.some(folder => row.kind === 'directory' && folder.id === row.name)
        && !manifest.files.some(file => row.kind === 'file' && file.name === row.name))) changed();
      if (journal) { if (!same(await root.read(CLEANUP_JOURNAL, CLEANUP_LIMIT), journal)) changed(); }
      else if (rootEntries.some(row => row.name === CLEANUP_JOURNAL)) changed();
      const present = new Set<string>();
      for (const folder of manifest.folders) if (rootEntries.some(row => row.name === folder.id)) {
        const actual = await root.directory(folder.id); const id = actual.identityChain.at(-1)!;
        if (id.dev !== folder.identity.dev || id.ino !== folder.identity.ino) changed();
        present.add(folder.id);
        for (const child of await actual.entries(7)) {
          const proof = folder.files.find(file => file.name === child.name);
          if (child.kind !== 'file' || !proof || child.size !== proof.size) changed();
          if (bytes && !same(await actual.read(child.name, proof!.size), proof!)) changed();
          present.add(folder.id + '/' + child.name);
        }
      }
      for (const proof of manifest.files) if (rootEntries.some(row => row.name === proof.name)) {
        if (bytes && !same(await root.read(proof.name, proof.size), proof)) changed();
        present.add(proof.name);
      }
      let first = items.length;
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!; const key = item.folder ? item.folder.id + (item.file ? '/' + item.file.name : '') : item.file.name;
        if (present.has(key)) { if (first === items.length) first = index; }
        else if (first !== items.length) changed();
      }
      if (!journal && first !== 0 && items.length) changed();
      verifyProfile(); return first;
    };
    await remaining(true); await onStep('cleanup-prepared'); await remaining(true);
    const encoded = new TextEncoder().encode(JSON.stringify(manifest) + '\n');
    if (encoded.length > CLEANUP_LIMIT) throw new Error('RECORD_CLEANUP_LIMIT');
    return Object.freeze({ summary: Object.freeze({ ...manifest.summary, resuming }),
      cancel(): boolean { if (commitment) return false; cancelled = true; release(); return true; },
      commit(): Promise<Result> {
        commitment ??= (async (): Promise<Result> => {
          let started = false; let cleared = false;
          try {
            await remaining(true);
            if (!items.length && !journal) return { status: 'cleared', code: null };
            if (!journal) {
              await onStep('cleanup-before-journal'); await remaining(true); started = true;
              await root.writeNew(CLEANUP_JOURNAL, encoded, step => onStep('cleanup-journal-' + step));
              const written = await root.read(CLEANUP_JOURNAL, CLEANUP_LIMIT);
              if (written.hash !== digest(encoded)) changed(); journal = cleanupProof(CLEANUP_JOURNAL, written);
            }
            started = true; await onStep('cleanup-journal-ready');
            const remover = recordRemoval(root);
            for (let index = await remaining(true); index < items.length; index++) {
              const item = items[index]!;
              const verify = async () => { await onStep('cleanup-before-remove'); if (await remaining(false) !== index) changed(); };
              if (item.folder) {
                if (item.file) await remover.file(item.folder, item.file, verify);
                else await remover.empty(item.folder, verify);
              } else await remover.receipt(item.file, verify);
              await onStep('cleanup-after-remove');
              if (await remaining(false) !== index + 1) changed();
            }
            await onStep('cleanup-before-finish');
            await remover.journal(journal!, async () => { if (await remaining(false) !== items.length) changed(); });
            if ((await root.entries(1)).length) changed(); verifyProfile(); cleared = true;
            await onStep('cleanup-finished');
            return Object.freeze({ status: 'cleared', code: null });
          } catch (error) {
            const code = error instanceof Error && /^(?:RECORD_CLEANUP|STORAGE|DRAFT)_[A-Z_]+$/u.test(error.message) ? error.message : 'RECORD_CLEANUP_FAILED';
            return Object.freeze({ status: cleared ? 'cleared' : started ? 'unknown' : 'failed',
              code: cleared ? 'RECORD_CLEANUP_CONFIRMED_WITH_WARNING' : code });
          } finally { release(); }
        })();
        return commitment;
      },
    });
  } catch (error) { release(); throw error; }
}
