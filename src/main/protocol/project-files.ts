import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ResourceDenied, validateSegments } from './resource-policy.ts';

type Identity = Readonly<{ dev: bigint; ino: bigint }>;
export type ProjectGrant = Readonly<{
  root: string;
  rootIdentity: Identity;
  entry: string;
  blockedRoots: readonly string[];
}>;

export function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function sameIdentity(a: Identity, b: Identity): boolean {
  // An unavailable file identity is not evidence of a safe target.
  return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function checkLocation(grant: ProjectGrant, path: string): void {
  if (!withinRoot(grant.root, path) || grant.blockedRoots.some((root) => withinRoot(root, path))) {
    throw new ResourceDenied();
  }
}

// Only trusted Main callers may create grants. A renderer never supplies these paths.
export async function authorizeProject(entryPath: string, blockedRoots: readonly string[] = []): Promise<ProjectGrant> {
  if (!isAbsolute(entryPath) || /[\x00-\x1f]/u.test(entryPath)
    || /^[\\/]{2}/.test(entryPath)) throw new ResourceDenied();
  const entry = resolve(entryPath);
  if (!/\.html?$/i.test(entry)) throw new ResourceDenied();
  const root = await realpath(dirname(entry));
  validateSegments(relative(parse(root).root, root).split(sep));
  const rootIdentity = await lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || !rootIdentity.ino) throw new ResourceDenied();
  const name = relative(dirname(entry), entry);
  validateSegments([name]);
  const blocked = await Promise.all(blockedRoots.map(async (path) => {
    try { return await realpath(path); } catch { return resolve(path); }
  }));
  const grant: ProjectGrant = Object.freeze({
    root, rootIdentity: Object.freeze({ dev: rootIdentity.dev, ino: rootIdentity.ino }),
    entry: name, blockedRoots: Object.freeze(blocked),
  });
  checkLocation(grant, root);
  return grant;
}

async function inspectChain(grant: ProjectGrant, segments: readonly string[]): Promise<BigIntStats[]> {
  const root = await lstat(grant.root, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory() || !sameIdentity(root, grant.rootIdentity)) throw new ResourceDenied();
  const chain = [root];
  let path = grant.root;
  for (let i = 0; i < segments.length; i++) {
    path = join(path, segments[i]!);
    checkLocation(grant, path);
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.ino
      || (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) {
      throw new ResourceDenied();
    }
    chain.push(stat);
  }
  // Do not follow an alias, even when its destination happens to be inside root.
  if (relative(path, await realpath(path)) !== '') throw new ResourceDenied();
  return chain;
}

export async function readProjectFile(grant: ProjectGrant, resource: string, limit: number): Promise<Uint8Array> {
  const segments = resource.split('/');
  validateSegments(segments);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new ResourceDenied();
  try {
    const before = await inspectChain(grant, segments);
    const leaf = before.at(-1)!;
    if (leaf.size > BigInt(limit)) throw new ResourceDenied();
    // Read the verified handle, never reopen by path after identity validation.
    const file = await open(join(grant.root, ...segments), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      if (!unchanged(leaf, opened) || !opened.isFile()) throw new ResourceDenied();
      const bytes = new Uint8Array(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new ResourceDenied();
        offset += bytesRead;
      }
      const after = await inspectChain(grant, segments);
      if (!unchanged(opened, await file.stat({ bigint: true }))
        || !unchanged(opened, after.at(-1)!)
        || before.some((stat, i) => !sameIdentity(stat, after[i]!))) throw new ResourceDenied();
      return bytes;
    } finally { await file.close(); }
  } catch { throw new ResourceDenied(); }
}
