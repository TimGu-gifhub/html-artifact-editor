import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { test } from 'node:test';
import { authorizeProject, readProjectFile, withinRoot } from '../../src/main/protocol/project-files.ts';

async function fixture(t) {
  const base = resolve('test-results/files');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(join(base, 'case-'));
  t.after(async () => {
    assert.ok(dir.startsWith(`${base}${sep}`));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = join(dir, 'project');
  await fs.mkdir(root);
  await fs.writeFile(join(root, '入口 🧪.html'), '\ufeff<!doctype html>\r\n<p>中文 &amp; 🧪</p>\n');
  await fs.mkdir(join(root, 'assets'));
  await fs.writeFile(join(root, 'assets/a.css'), 'body { color: red; }');
  return { dir, root, grant: await authorizeProject(join(root, '入口 🧪.html')) };
}
test('reads the original BOM, mixed newlines, Unicode and entity bytes without normalization', async (t) => {
  const { root, grant } = await fixture(t);
  const before = await fs.readFile(join(root, grant.entry));
  assert.deepEqual(Buffer.from(await readProjectFile(grant, grant.entry, 1000)), before);
  assert.deepEqual(await fs.readFile(join(root, grant.entry)), before);
  assert.ok(withinRoot(root, join(root, 'assets/a.css')));
  assert.equal(withinRoot(root, `${root}-private/a.css`), false);
});
test('rejects denied roots, hidden paths, non-files, hardlinks and size overflow', async (t) => {
  const { root, dir, grant } = await fixture(t);
  await assert.rejects(authorizeProject(join(root, grant.entry), [root]), /RESOURCE_BLOCKED/);
  await fs.mkdir(join(root, 'recovery'));
  await fs.writeFile(join(root, 'recovery/private.html'), 'PRIVATE');
  await assert.rejects(authorizeProject(join(root, 'recovery/private.html')), /RESOURCE_BLOCKED/);
  await assert.rejects(readProjectFile(grant, grant.entry, 2), /RESOURCE_BLOCKED/);
  await assert.rejects(readProjectFile(grant, 'assets', 1000), /RESOURCE_BLOCKED/);
  await fs.writeFile(join(dir, 'private.css'), 'PRIVATE');
  await fs.link(join(dir, 'private.css'), join(root, 'hard.css'));
  await assert.rejects(readProjectFile(grant, 'hard.css', 1000), /RESOURCE_BLOCKED/);
  const blocked = await authorizeProject(join(root, grant.entry), [join(root, 'assets')]);
  await assert.rejects(readProjectFile(blocked, 'assets/a.css', 1000), /RESOURCE_BLOCKED/);
});
test('S-01 rejects real junction/symlink directories even for inside-root targets', async (t) => {
  const { root, dir, grant } = await fixture(t);
  const outside = join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'private.css'), 'PRIVATE');
  await fs.symlink(outside, join(root, 'escape'), 'junction');
  await fs.symlink(join(root, 'assets'), join(root, 'alias'), 'junction');
  await assert.rejects(readProjectFile(grant, 'escape/private.css', 1000), /RESOURCE_BLOCKED/);
  await assert.rejects(readProjectFile(grant, 'alias/a.css', 1000), /RESOURCE_BLOCKED/);
});
test('rejects root replacement after the grant was issued', async (t) => {
  const { root, grant } = await fixture(t);
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  await fs.writeFile(join(root, grant.entry), 'REPLACED');
  await assert.rejects(readProjectFile(grant, grant.entry, 1000), /RESOURCE_BLOCKED/);
});
test('S-01 file identity stops replacement between path inspection and open', async (t) => {
  const { root, grant } = await fixture(t);
  const target = join(root, 'assets/a.css');
  const originalOpen = fs.open;
  let injected = false;
  fs.open = async (...args) => {
    if (args[0] === target) {
      injected = true;
      await fs.rename(target, `${target}.original`);
      await fs.writeFile(target, 'PRIVATE REPLACEMENT');
    }
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readProjectFile(grant, 'assets/a.css', 1000), /RESOURCE_BLOCKED/); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(injected, true);
});
test('S-01 rechecks a junction swap after opening the verified file handle', async (t) => {
  const { root, dir, grant } = await fixture(t);
  const outside = join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'a.css'), 'PRIVATE REPLACEMENT');
  const originalOpen = fs.open;
  let injected = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === join(root, 'assets/a.css')) {
      injected = true;
      await fs.rename(join(root, 'assets'), join(root, 'assets-old'));
      await fs.symlink(outside, join(root, 'assets'), 'junction');
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readProjectFile(grant, 'assets/a.css', 1000), /RESOURCE_BLOCKED/); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(injected, true);
});
test('a write through another handle during the read is rejected', async (t) => {
  const { root, grant } = await fixture(t);
  const target = join(root, 'assets/a.css');
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === target) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { await fs.writeFile(target, 'CHANGED'); return read(...readArgs); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readProjectFile(grant, 'assets/a.css', 1000), /RESOURCE_BLOCKED/); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});
