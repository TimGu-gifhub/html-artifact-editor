import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isTransactionId } from '../contracts/save-record.ts';

export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const sameFile = (a: Pick<BigIntStats, 'dev' | 'ino'>, b: Pick<BigIntStats, 'dev' | 'ino'>): boolean =>
  a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
export const sameVersion = (a: BigIntStats, b: BigIntStats): boolean => sameFile(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
export type StorageStep = 'created' | 'written' | 'synced' | 'verified';
function localPath(value: string): string {
  if (!isAbsolute(value) || value.length > 1024 || /^[\\/]{2}/u.test(value) || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('STORAGE_INVALID_PATH');
  return resolve(value);
}
function childName(value: string): void {
  if (!value || value.length > 255 || /^[.$]/u.test(value) || /[. ]$/u.test(value) || /[\x00-\x1f\x7f<>:"|?*\\/%~]/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)) throw new Error('STORAGE_INVALID_NAME');
}
async function directoryChain(path: string): Promise<BigIntStats[]> {
  const root = parse(path).root; let cursor = root; const result: BigIntStats[] = [];
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino) throw new Error('STORAGE_LOCATION_CHANGED');
    result.push(stat);
  }
  if (relative(path, await realpath(path)) !== '') throw new Error('STORAGE_LOCATION_CHANGED');
  return result;
}
function regular(stat: BigIntStats, limit: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.ino || stat.nlink !== 1n) throw new Error('STORAGE_FILE_CHANGED');
  if (stat.size > BigInt(limit)) throw new Error('STORAGE_SIZE_LIMIT');
}
async function readHandle(file: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size); let offset = 0;
  while (offset < size) {
    const read = await file.read(bytes, offset, size - offset, offset);
    if (!read.bytesRead) throw new Error('STORAGE_READ_FAILED'); offset += read.bytesRead;
  }
  return bytes;
}

// Main supplies a native, already authorized directory. No recursive creation,
// general path operation or user-content bridge. All children are direct names.
export async function checkedDirectory(input: string) {
  const path = localPath(input); const initial = await directoryChain(path);
  const verify = async (): Promise<void> => {
    const actual = await directoryChain(path);
    if (actual.length !== initial.length || actual.some((item, index) => !sameFile(item, initial[index]!))) throw new Error('STORAGE_LOCATION_CHANGED');
  };
  const read = async (name: string, limit: number) => {
    childName(name);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('STORAGE_SIZE_LIMIT');
    await verify(); const target = join(path, name); const before = await lstat(target, { bigint: true }); regular(before, limit);
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true }); regular(opened, limit);
      if (!sameVersion(before, opened)) throw new Error('STORAGE_FILE_CHANGED');
      const bytes = await readHandle(file, Number(opened.size));
      await verify();
      if (!sameVersion(opened, await file.stat({ bigint: true })) || !sameVersion(opened, await lstat(target, { bigint: true }))
        || relative(target, await realpath(target)) !== '') throw new Error('STORAGE_FILE_CHANGED');
      return { bytes, stat: opened, hash: digest(bytes) };
    } finally { await file.close(); }
  };
  const writeNewFile = async (name: string, value: Uint8Array, onStep: (step: StorageStep) => Promise<void>) => {
    const bytes = new Uint8Array(value); const expectedHash = digest(bytes);
    await verify(); const target = join(path, name);
    const file = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let written: BigIntStats;
    try {
      const created = await file.stat({ bigint: true }); regular(created, 0);
      await onStep('created'); await verify();
      if (!sameVersion(created, await lstat(target, { bigint: true })) || !sameVersion(created, await file.stat({ bigint: true }))) throw new Error('STORAGE_FILE_CHANGED');
      let offset = 0;
      while (offset < bytes.length) {
        const next = await file.write(bytes, offset, bytes.length - offset, offset);
        if (!next.bytesWritten) throw new Error('STORAGE_WRITE_FAILED'); offset += next.bytesWritten;
      }
      await onStep('written'); await file.sync(); await onStep('synced');
      written = await file.stat({ bigint: true }); regular(written, bytes.length);
      if (!sameFile(created, written) || written.size !== BigInt(bytes.length) || digest(await readHandle(file, bytes.length)) !== expectedHash) throw new Error('STORAGE_VERIFY_FAILED');
      await onStep('verified'); await verify();
      if (!sameVersion(written, await file.stat({ bigint: true })) || !sameVersion(written, await lstat(target, { bigint: true }))) throw new Error('STORAGE_FILE_CHANGED');
    } finally { await file.close(); } // Failure retains partial evidence; never unlink it.
    let removed = false;
    const verifyOwned = async (): Promise<void> => {
      await verify(); const actual = await read(name, bytes.length);
      if (!sameVersion(written, actual.stat) || actual.hash !== expectedHash) throw new Error('STORAGE_LOCK_CHANGED');
    };
    return Object.freeze({ hash: expectedHash, identity: Object.freeze({ dev: written.dev.toString(), ino: written.ino.toString(),
      mtimeNs: written.mtimeNs.toString(), ctimeNs: written.ctimeNs.toString() }),
      verifyOwned,
      // Only the owner of a verified lock uses this; never use it for HTML or evidence.
      async removeOwned(): Promise<void> {
        if (removed) return;
        await verifyOwned();
        await unlink(target); removed = true;
      },
    });
  };
  return Object.freeze({ path, verify, read,
    writeNew(name: string, value: Uint8Array, onStep: (step: StorageStep) => Promise<void> = async () => {}) {
      childName(name); return writeNewFile(name, value, onStep);
    },
    async writeReplacement(transactionId: string, value: Uint8Array, onStep: (step: StorageStep) => Promise<void>) {
      if (!isTransactionId(transactionId)) throw new Error('STORAGE_INVALID_NAME');
      const written = await writeNewFile(`.hae-${transactionId}.tmp`, value, onStep);
      // No unlink capability for a project temporary file or original HTML.
      return Object.freeze({ hash: written.hash, identity: written.identity });
    },
    identityChain: Object.freeze(initial.map((stat) => Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString() }))),
    async directory(name: string, create = false) {
      childName(name); await verify(); const target = join(path, name);
      if (create) await mkdir(target, { mode: 0o700 });
      const child = await checkedDirectory(target); await verify(); return child;
    },
    async entries(limit: number) {
      await verify(); const items: { name: string; kind: 'file' | 'directory'; size: number }[] = [];
      const stream = await opendir(path);
      for await (const item of stream) {
        if (items.length >= limit) throw new Error('STORAGE_REVIEW_REQUIRED');
        childName(item.name); const stat = await lstat(join(path, item.name), { bigint: true });
        if (stat.isSymbolicLink() || !stat.ino || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
          || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('STORAGE_REVIEW_REQUIRED');
        items.push({ name: item.name, kind: stat.isDirectory() ? 'directory' : 'file', size: Number(stat.size) });
      }
      await verify(); return items;
    },
  });
}
export type CheckedDirectory = Awaited<ReturnType<typeof checkedDirectory>>;
