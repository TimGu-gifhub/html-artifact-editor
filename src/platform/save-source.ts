import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { StoredFileIdentity } from '../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../contracts/source-tree.ts';
import { checkedDirectory, digest, sameVersion } from './storage-files.ts';

export type SaveTargetState = Readonly<{ targetKey: string; identity: StoredFileIdentity; hash: string }>;
const storedIdentity = (value: BigIntStats): StoredFileIdentity => Object.freeze({ dev: value.dev.toString(), ino: value.ino.toString(),
  mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString() });
// Called only with the HTML path retained by Main's project authorization.
export async function openSaveSource(input: string, expected: Uint8Array) {
  const bytes = new Uint8Array(expected); const baseHash = digest(bytes);
  if (!isAbsolute(input) || /^[\\/]{2}/u.test(input) || !/\.html?$/iu.test(input) || bytes.length > MAX_SOURCE_BYTES) throw new Error('SAVE_INVALID_SOURCE');
  const path = resolve(input); const folder = await checkedDirectory(dirname(path)); const name = basename(path);
  const initial = await folder.read(name, MAX_SOURCE_BYTES);
  if (initial.hash !== baseHash) throw new Error('FILE_CHANGED');
  // Use the filesystem's canonical spelling, not an OS-wide case-fold guess:
  // Windows can also contain directories with case-sensitive filenames.
  const targetKey = createHash('sha256').update(await realpath(path)).digest('hex');
  const identity = storedIdentity(initial.stat);
  return Object.freeze({ path, targetKey, name, identity, baseHash, size: bytes.length,
    get bytes(): Uint8Array { return new Uint8Array(bytes); },
    async current(): Promise<SaveTargetState> {
      const value = await folder.read(name, MAX_SOURCE_BYTES);
      return Object.freeze({ targetKey, hash: value.hash, identity: storedIdentity(value.stat) });
    },
    async verify(): Promise<void> {
      try {
        const value = await folder.read(name, MAX_SOURCE_BYTES);
        if (value.hash !== baseHash || !sameVersion(initial.stat, value.stat)) throw new Error('FILE_CHANGED');
      } catch { throw new Error('FILE_CHANGED'); }
    },
  });
}
export type SaveSource = Awaited<ReturnType<typeof openSaveSource>>;
