import { randomUUID } from 'node:crypto';
import { CLEANUP_DRAFT_FILES, CLEANUP_SAVE_FILES, cleanupOrder, cleanupRootFile, isCleanupManifest } from '../../contracts/record-cleanup.ts';
import type { CleanupFile, CleanupFolder, CleanupManifest } from '../../contracts/record-cleanup.ts';
import { MAX_DRAFT_RECORD_BYTES } from '../../contracts/draft-checkpoint.ts';
import { digest } from '../../platform/storage-files.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';
import { removalIdentity } from '../../platform/checkpoint-removal.ts';
import { createDraftCheckpointStore } from './checkpoints.ts';
import { createSavePreparationStore } from './preparation.ts';
import { readSaveResolutions } from './save-resolutions.ts';
import { readDraftHeader } from './draft-records.ts';

export const cleanupProof = (name: string, file: Awaited<ReturnType<CheckedDirectory['read']>>): CleanupFile =>
  Object.freeze({ name, size: file.bytes.length, hash: file.hash, identity: removalIdentity(file.stat) });

// Validate every complete point, including superseded/retired history, before
// freezing a deletion list. Unresolved evidence is not a capacity escape hatch.
export async function inspectCleanupInventory(root: CheckedDirectory): Promise<CleanupManifest> {
  const entries = await root.entries(512);
  if (entries.some(row => row.name === 'active.lock' || row.name === 'compaction.json')) throw new Error('RECORD_CLEANUP_RECOVERY_REQUIRED');
  // Freeze the exact file versions first. Semantic checks below must validate
  // these same bytes; the preparer rechecks every proof after this function.
  const folders: CleanupFolder[] = []; const files: CleanupFile[] = [];
  for (const entry of entries) {
    if (entry.kind === 'file') {
      if (!cleanupRootFile(entry.name)) throw new Error('RECORD_CLEANUP_RECOVERY_REQUIRED');
      files.push(cleanupProof(entry.name, await root.read(entry.name, MAX_DRAFT_RECORD_BYTES))); continue;
    }
    const folder = await root.directory(entry.name);
    const children = await folder.entries(7); const kind = children.some(row => row.name === 'intent.json') ? 'save' : 'draft';
    const order: readonly string[] = kind === 'save' ? CLEANUP_SAVE_FILES : CLEANUP_DRAFT_FILES;
    if (children.some(row => row.kind !== 'file' || !order.includes(row.name))) throw new Error('RECORD_CLEANUP_RECOVERY_REQUIRED');
    const proofs: CleanupFile[] = [];
    for (const name of order) if (children.some(row => row.name === name)) proofs.push(cleanupProof(name, await folder.read(name, MAX_DRAFT_RECORD_BYTES)));
    folders.push(Object.freeze({ id: entry.name, kind, identity: folder.identityChain.at(-1)!, files: Object.freeze(proofs) }));
  }
  folders.sort(cleanupOrder); files.sort((a, b) => a.name.localeCompare(b.name));
  const saves = await createSavePreparationStore(root.path); const drafts = await createDraftCheckpointStore(root.path);
  const catalog = await drafts.catalog(); const saveCatalog = await saves.scan(); const draftCatalog = await drafts.scan();
  const resolutions = await readSaveResolutions(root, entries.map(row => row.name));
  const resolved = new Set(resolutions.filter(row => row.seal).map(row => row.record.transactionId));
  if (catalog.locked || catalog.reviewRequired || saveCatalog.locked || saveCatalog.unrecognized
    || draftCatalog.records.some(row => row.phase !== 'complete')
    || saveCatalog.records.some(row => ['incomplete', 'invalid'].includes(row.phase)
      || (['prepared', 'replacing'].includes(row.phase) && !resolved.has(row.transactionId)))) throw new Error('RECORD_CLEANUP_RECOVERY_REQUIRED');
  const revisions = new Map<string, string>();
  for (const row of draftCatalog.records) {
    const { checkpoint } = await readDraftHeader(root, row.checkpointId);
    const key = checkpoint.sessionId + ':' + checkpoint.draftRevision;
    const proof = digest(new TextEncoder().encode(JSON.stringify({ targetKey: checkpoint.targetKey, identity: checkpoint.identity,
      baseHash: checkpoint.baseHash, resultHash: checkpoint.resultHash, intents: checkpoint.intents,
      history: checkpoint.version === 2 ? checkpoint.history : null })));
    if (revisions.has(key) && revisions.get(key) !== proof) throw new Error('RECORD_CLEANUP_RECOVERY_REQUIRED');
    revisions.set(key, proof);
  }
  const value = { version: 1 as const, cleanupId: randomUUID(), createdAt: Date.now(), root: root.identityChain.at(-1)!,
    summary: Object.freeze({ records: folders.length, sessions: catalog.groups.length,
      unsavedDrafts: catalog.groups.filter(row => row.status === 'dirty').length,
      backups: saveCatalog.records.filter(row => row.phase !== 'abandoned').length,
      bytes: [...folders.flatMap(row => row.files), ...files].reduce((sum, row) => sum + row.size, 0) }),
    folders: Object.freeze(folders), files: Object.freeze(files) };
  if (!isCleanupManifest(value)) throw new Error('RECORD_CLEANUP_INVALID');
  return Object.freeze(value);
}
