import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { authorizeDirectory, authorizeProject, readProjectFile } from '../../src/main/protocol/project-files.ts';
import { chooseProjectDirectory, chooseProjectEntry } from '../../src/main/workspace/project-choice.ts';
import { createResourceDiagnostics, resourceTarget } from '../../src/main/protocol/resource-diagnostics.ts';

async function fixture() {
  const base = resolve('test-results/project-choice'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(join(base, 'case-'));
  await fs.mkdir(join(root, 'reports')); await fs.mkdir(join(root, 'assets'));
  await fs.writeFile(join(root, 'reports', '报告 🧪.html'), '\ufeff<!doctype html>\r\n<p>文本 &amp; 😀</p>');
  await fs.writeFile(join(root, 'assets/theme.css'), 'body{color:green}');
  return { root, entry: join(root, 'reports', '报告 🧪.html') };
}
test('an explicit project root serves nested entry siblings; a single-file grant never widens to its parent', async () => {
  const f = await fixture(); const original = await fs.readFile(f.entry);
  const root = await authorizeDirectory(f.root); const project = await authorizeProject(f.entry, [], root);
  assert.equal(project.entry, 'reports/报告 🧪.html'); assert.equal(project.rootIdentity, root.rootIdentity);
  assert.deepEqual(Buffer.from(await readProjectFile(project, project.entry, 1000)), original);
  assert.equal(Buffer.from(await readProjectFile(project, 'assets/theme.css', 1000)).toString(), 'body{color:green}');
  const single = await authorizeProject(f.entry);
  await assert.rejects(readProjectFile(single, '../assets/theme.css', 1000), /RESOURCE_BLOCKED/);
  await assert.rejects(authorizeProject(join(f.root, 'assets/theme.css'), [], root), /RESOURCE_BLOCKED/);
  let repeated = project;
  for (let i = 0; i < 20; i++) repeated = await authorizeProject(f.entry, [join(f.root, 'private-state')], repeated);
  assert.equal(repeated.blockedRoots.length, 1, 'entry switching does not grow duplicate exclusions');
});
test('entry choice rejects outside roots, hidden/private state, hardlinks and real junctions', async () => {
  const f = await fixture(); const root = await authorizeDirectory(f.root, [join(f.root, 'private-state')]);
  const outside = await fixture();
  await assert.rejects(authorizeProject(outside.entry, [], root), /RESOURCE_BLOCKED/);
  for (const name of ['.git', 'backups', 'private-state']) {
    await fs.mkdir(join(f.root, name)); await fs.writeFile(join(f.root, name, 'secret.html'), 'PRIVATE');
    await assert.rejects(authorizeProject(join(f.root, name, 'secret.html'), [], root), /RESOURCE_BLOCKED/);
  }
  await fs.link(outside.entry, join(f.root, 'linked.html'));
  await assert.rejects(authorizeProject(join(f.root, 'linked.html'), [], root), /RESOURCE_BLOCKED/);
  await fs.symlink(join(f.root, 'reports'), join(f.root, 'alias'), 'junction');
  await assert.rejects(authorizeDirectory(join(f.root, 'alias')), /RESOURCE_BLOCKED/);
  await assert.rejects(authorizeProject(join(f.root, 'alias', '报告 🧪.html'), [], root), /RESOURCE_BLOCKED/);
});
test('retained root identity rejects a replaced directory when choosing another entry', async () => {
  const f = await fixture(); const root = await authorizeDirectory(f.root);
  await fs.rename(f.root, `${f.root}-original`); await fs.mkdir(f.root); await fs.mkdir(join(f.root, 'reports'));
  await fs.writeFile(f.entry, 'REPLACED');
  await assert.rejects(chooseProjectEntry(root, async () => f.entry, new AbortController().signal), /RESOURCE_BLOCKED/);
});
test('cancel either native choice without a candidate; revocation between dialogs never opens a late entry chooser', async () => {
  const f = await fixture(); let entryCalls = 0;
  const choices = { chooseDirectory: async () => undefined, chooseEntry: async () => { entryCalls++; return undefined; } };
  assert.equal(await chooseProjectDirectory(choices, new AbortController().signal, []), undefined); assert.equal(entryCalls, 0);
  choices.chooseDirectory = async () => f.root;
  assert.equal(await chooseProjectDirectory(choices, new AbortController().signal, []), undefined); assert.equal(entryCalls, 1);
  const controller = new AbortController();
  choices.chooseDirectory = async () => { controller.abort(); return f.root; };
  await assert.rejects(chooseProjectDirectory(choices, controller.signal, []), { name: 'AbortError' }); assert.equal(entryCalls, 1);
  controller.abort(); await assert.rejects(chooseProjectEntry(await authorizeDirectory(f.root), choices.chooseEntry, controller.signal));
  assert.equal(entryCalls, 1);
});
test('diagnostics sanitize native/private targets, deduplicate and preserve specific evidence over a later generic failure', () => {
  const id = '00000000-0000-4000-8000-000000000001'; const values = createResourceDiagnostics(id);
  values.report('https://example.invalid/asset.css', 'constructor', 'RESOURCE_LOAD_FAILED');
  assert.equal(values.snapshot().items[0].resourceType, 'stylesheet');
  const malformedType = createResourceDiagnostics(id);
  malformedType.report('https://example.invalid/asset', '__proto__', 'RESOURCE_LOAD_FAILED');
  assert.equal(malformedType.snapshot().items[0].resourceType, 'other');
  values.report(`artifact://${id}/assets/missing.css?secret=1`, 'stylesheet', 'RESOURCE_MISSING');
  values.report(`artifact://${id}/assets/missing.css?secret=2`, 'Stylesheet', 'RESOURCE_LOAD_FAILED');
  assert.equal(values.snapshot().items.length, 2); assert.equal(values.snapshot().items[1].reason, 'RESOURCE_MISSING');
  assert.equal(resourceTarget(`artifact://${id}/.git/private.css`, id), 'project:/[blocked path]');
  assert.equal(resourceTarget('file:///C:/private.html', id), 'file:[blocked]');
  assert.equal(resourceTarget('https://user:password@example.invalid/asset.css?secret=1#fragment', id), 'https://example.invalid/asset.css');
  for (let i = 0; i < 150; i++) values.report(`https://example.invalid/${i}.js`, 'script', 'CSP_BLOCKED');
  assert.equal(values.snapshot().items.length, 100); assert.equal(values.snapshot().truncated, true);
  const before = values.snapshot(); values.close(); values.report('https://after.invalid', 'fetch', 'RESOURCE_BLOCKED');
  assert.deepEqual(values.snapshot(), before);
});
