import { isDraftCheckpoint, isDraftRetirement, MAX_DRAFT_RECORD_BYTES } from '../../contracts/draft-checkpoint.ts';
import type { DraftCheckpoint, DraftRetirement } from '../../contracts/draft-checkpoint.ts';
import type { CheckedDirectory } from '../../platform/storage-files.ts';

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export async function readDraftHeader(root: CheckedDirectory, id: string) {
  const folder = await root.directory(id); const file = await folder.read('record.json', MAX_DRAFT_RECORD_BYTES);
  const value = decode(file.bytes);
  if (!isDraftCheckpoint(value) || value.checkpointId !== id) throw new Error('DRAFT_CHECKPOINT_INVALID');
  const checkpoint: DraftCheckpoint = Object.freeze({ ...value, identity: Object.freeze({ ...value.identity }),
    intents: Object.freeze(value.intents.map(intent => Object.freeze({ ...intent }))) });
  return { folder, checkpoint, hash: file.hash };
}
export async function readDraftRetirement(header: Readonly<{ folder: CheckedDirectory; hash: string;
  checkpoint: Pick<DraftCheckpoint, 'checkpointId' | 'sessionId' | 'draftRevision'> }>): Promise<DraftRetirement | null> {
  let bytes: Uint8Array;
  try { bytes = (await header.folder.read('retired.json', 2048)).bytes; }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  const value = decode(bytes);
  if (!isDraftRetirement(value) || value.checkpointId !== header.checkpoint.checkpointId || value.recordHash !== header.hash
    || value.sessionId !== header.checkpoint.sessionId || value.draftRevision < header.checkpoint.draftRevision) throw new Error('DRAFT_RETIREMENT_INVALID');
  return Object.freeze(value);
}
