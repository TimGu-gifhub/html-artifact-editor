import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { MAX_SOURCE_BYTES } from '../contracts/source-tree.ts';

export type NewFileOutcome = Readonly<{
  status: 'created' | 'failed' | 'unknown'; path: string; expectedHash: string; code: string | null;
}>;
type Step = 'created' | 'written' | 'synced' | 'verified';
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
const unchanged = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
async function inspectDirectories(directory: string): Promise<BigIntStats[]> {
  const root = parse(directory).root;
  const parts = relative(root, directory).split(sep).filter(Boolean);
  const chain: BigIntStats[] = [];
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    const stat = await lstat(path, { bigint: true });
    if (!stat.ino || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('NEW_FILE_LOCATION_CHANGED');
    chain.push(stat);
  }
  if (relative(directory, await realpath(directory)) !== '') throw new Error('NEW_FILE_LOCATION_CHANGED');
  return chain;
}
function targetInDirectory(directory: string, input: string, format: 'html' | 'pdf'): string {
  if (!isAbsolute(input) || input.length > 1024 || /^[\\/]{2}/u.test(input) || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error('NEW_FILE_INVALID_PATH');
  }
  const path = resolve(input);
  if (relative(directory, dirname(path)) !== '') throw new Error('NEW_FILE_SAME_DIRECTORY_REQUIRED');
  const name = basename(path);
  if (!(format === 'pdf' ? /\.pdf$/iu : /\.html?$/iu).test(name) || name.length > 255 || /^[.$]/u.test(name) || /[. ]$/u.test(name)
    || /[<>:"|?*\\/%~]/u.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error('NEW_FILE_INVALID_NAME');
  }
  return path;
}

// Main supplies a verified directory: the entry directory for HTML copies, or
// a native-chooser destination for PDF. Only direct new files are supported;
// no replacement or resource copying. The default remains HTML-only.
// The optional step observer is for deterministic local filesystem fault tests.
export async function createNewFileWriter(directory: string, onStep: (step: Step) => Promise<void> = async () => {}, format: 'html' | 'pdf' = 'html') {
  if (!isAbsolute(directory) || /^[\\/]{2}/u.test(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error('NEW_FILE_INVALID_PATH');
  const root = resolve(directory);
  const authorization = await inspectDirectories(root);
  const verifyDirectory = async (): Promise<void> => {
    const current = await inspectDirectories(root);
    if (current.length !== authorization.length || current.some((stat, index) => !sameIdentity(stat, authorization[index]!))) {
      throw new Error('NEW_FILE_LOCATION_CHANGED');
    }
  };
  return Object.freeze({
    directory: root,
    async write(input: string, value: Uint8Array): Promise<NewFileOutcome> {
      let path = input;
      let expectedHash = '';
      let file: FileHandle | undefined;
      let created = false;
      try {
        if (!(value instanceof Uint8Array) || value.length > (format === 'pdf' ? 32 * 1024 * 1024 : MAX_SOURCE_BYTES)) throw new Error('NEW_FILE_SIZE_LIMIT');
        if (format === 'pdf' && ![37, 80, 68, 70, 45].every((byte, index) => value[index] === byte)) throw new Error('NEW_FILE_INVALID_PDF');
        const bytes = new Uint8Array(value);
        expectedHash = hash(bytes);
        path = targetInDirectory(root, input, format);
        await verifyDirectory();
        // O_EXCL never truncates an existing file, symlink or hardlink, even if a
        // native chooser offered an overwrite confirmation. Keep this handle.
        file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        const identity = await file.stat({ bigint: true });
        if (!identity.isFile() || !identity.ino || identity.nlink !== 1n || identity.size !== 0n) throw new Error('NEW_FILE_IDENTITY_CHANGED');
        await onStep('created');
        await verifyDirectory();
        if (!unchanged(identity, await lstat(path, { bigint: true }))
          || !unchanged(identity, await file.stat({ bigint: true }))) throw new Error('NEW_FILE_IDENTITY_CHANGED');
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
          if (!bytesWritten) throw new Error('NEW_FILE_WRITE_FAILED');
          offset += bytesWritten;
        }
        await onStep('written');
        await file.sync(); await onStep('synced');
        const written = await file.stat({ bigint: true });
        if (!sameIdentity(identity, written) || written.size !== BigInt(bytes.length) || written.nlink !== 1n) throw new Error('NEW_FILE_IDENTITY_CHANGED');
        const readback = new Uint8Array(bytes.length);
        offset = 0;
        while (offset < readback.length) {
          const { bytesRead } = await file.read(readback, offset, readback.length - offset, offset);
          if (!bytesRead) throw new Error('NEW_FILE_VERIFY_FAILED');
          offset += bytesRead;
        }
        if (hash(readback) !== expectedHash) throw new Error('NEW_FILE_VERIFY_FAILED');
        await verifyDirectory();
        const leaf = await lstat(path, { bigint: true });
        if (leaf.isSymbolicLink() || !leaf.isFile() || !unchanged(written, leaf)
          || !unchanged(written, await file.stat({ bigint: true }))) throw new Error('NEW_FILE_IDENTITY_CHANGED');
        await onStep('verified');
        // The last check also detects changes made after verification, before close.
        await verifyDirectory();
        if (!unchanged(written, await file.stat({ bigint: true })) || !unchanged(written, await lstat(path, { bigint: true }))) throw new Error('NEW_FILE_IDENTITY_CHANGED');
        await file.close(); file = undefined;
        return Object.freeze({ status: 'created', path, expectedHash, code: null });
      } catch (error) {
        const detail = error as { code?: string; message?: string };
        const code = detail.code === 'EEXIST' ? 'NEW_FILE_EXISTS'
          : /^NEW_FILE_[A-Z_]+$/u.test(detail.message ?? '') ? detail.message!
            : ['EACCES', 'EPERM'].includes(detail.code ?? '') ? 'NEW_FILE_PERMISSION_DENIED'
              : detail.code === 'ENOSPC' ? 'NEW_FILE_DISK_FULL' : 'NEW_FILE_WRITE_FAILED';
        // Once exclusive creation succeeded, leave the file and evidence in place.
        // Never delete a path on failure or call a partial/unknown result saved.
        return Object.freeze({ status: created ? 'unknown' : 'failed', path, expectedHash, code });
      } finally { if (file) { try { await file.close(); } catch { /* Preserve the unknown outcome. */ } } }
    },
  });
}
export type NewFileWriter = Awaited<ReturnType<typeof createNewFileWriter>>;
