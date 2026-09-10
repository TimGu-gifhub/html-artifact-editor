import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNewFileWriter } from '../../src/platform/new-file.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtures = resolve('test-results');
await mkdir(fixtures, { recursive: true });
const bytes = Buffer.from('\ufeff<!doctype html>\r\n<h1>中文 &amp; 😀</h1>');
const directory = async () => mkdtemp(join(fixtures, 'new-file-case-'));
test('dedicated PDF export uses the same exclusive/readback checks and cannot create HTML or replace an existing PDF', async () => {
  const root = await directory(); const pdf = Buffer.from('%PDF-1.7\nself-made export fixture\n%%EOF');
  const htmlWriter = await createNewFileWriter(root); const writer = await createNewFileWriter(root, undefined, 'pdf');
  assert.equal((await htmlWriter.write(join(root, 'not-html.pdf'), pdf)).status, 'failed');
  assert.equal((await writer.write(join(root, 'not-pdf.html'), pdf)).status, 'failed');
  assert.equal((await writer.write(join(root, 'invalid.pdf'), bytes)).code, 'NEW_FILE_INVALID_PDF');
  const target = join(root, '打印预览.pdf');
  assert.equal((await writer.write(target, pdf)).status, 'created');
  assert.deepEqual(await readFile(target), pdf);
  assert.equal((await writer.write(target, Buffer.from('%PDF-changed'))).code, 'NEW_FILE_EXISTS');
  assert.deepEqual(await readFile(target), pdf);
  assert.deepEqual(await readdir(root), ['打印预览.pdf']);
});
test('PDF export interruption preserves a partial file and reports unknown without touching source HTML', async () => {
  const root = await directory(); const original = join(root, 'source.html'); await writeFile(original, bytes);
  const target = join(root, 'interrupted.pdf');
  const writer = await createNewFileWriter(root, async stage => { if (stage === 'created') throw new Error('injected'); }, 'pdf');
  assert.equal((await writer.write(target, Buffer.from('%PDF-1.7\n%%EOF'))).status, 'unknown');
  assert.equal((await readFile(target)).length, 0); assert.deepEqual(await readFile(original), bytes);
});
test('exclusive new sibling creation flushes and verifies exact bytes, while caller byte mutation cannot affect it', async () => {
  const root = await directory(); const writer = await createNewFileWriter(root);
  const target = join(root, '另存报告.html');
  const input = Buffer.from(bytes);
  const pending = writer.write(target, input); input.fill(0);
  const result = await pending;
  assert.deepEqual(result, { status: 'created', path: target, expectedHash: hash(bytes), code: null });
  assert.deepEqual(await readFile(target), bytes);
  assert.ok(Object.isFrozen(result));
});
test('existing originals, existing copies and hardlinks are never truncated or replaced', async () => {
  const root = await directory(); const writer = await createNewFileWriter(root);
  const original = join(root, 'original.html'); const hardlink = join(root, 'alias.html');
  await writeFile(original, bytes); await link(original, hardlink);
  for (const path of [original, hardlink]) {
    const result = await writer.write(path, Buffer.from('changed'));
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'NEW_FILE_EXISTS');
    assert.deepEqual(await readFile(path), bytes);
  }
  const copy = join(root, 'copy.html');
  assert.equal((await writer.write(copy, bytes)).status, 'created');
  assert.equal((await writer.write(copy, Buffer.from('again'))).status, 'failed');
  assert.deepEqual(await readFile(copy), bytes);
});
test('same-path concurrent creation has exactly one winner and leaves one complete candidate', async () => {
  const root = await directory(); const writer = await createNewFileWriter(root);
  const target = join(root, 'concurrent.html'); const second = Buffer.from('<h1>second</h1>');
  const outcomes = await Promise.all([writer.write(target, bytes), writer.write(target, second)]);
  assert.deepEqual(outcomes.map((value) => value.status).sort(), ['created', 'failed']);
  const winner = outcomes.findIndex((value) => value.status === 'created');
  assert.deepEqual(await readFile(target), winner === 0 ? bytes : second);
});
test('invalid, private-looking, non-HTML and outside-directory destinations create nothing', async () => {
  const root = await directory(); const writer = await createNewFileWriter(root);
  const outside = await directory();
  for (const path of ['relative.html', join(outside, 'escape.html'), join(root, '.private.html'),
    join(root, '$private.html'), join(root, 'CON.html'), join(root, 'report.css'), join(root, 'bad%20.html'),
    join(root, 'bad~1.html'), join(root, 'bad.html '), join(root, 'report.html:stream')]) {
    assert.equal((await writer.write(path, bytes)).status, 'failed', path);
  }
  assert.equal((await writer.write(join(root, 'large.html'), new Uint8Array(5 * 1024 * 1024 + 1))).status, 'failed');
  assert.deepEqual(await readdir(root), []); assert.deepEqual(await readdir(outside), []);
});
test('revoked directory identity and directory symlink/junction aliases are rejected before file creation', async () => {
  const container = await directory(); const root = join(container, 'project');
  await mkdir(root); const writer = await createNewFileWriter(root);
  // Both absolute targets are created by this test and remain inside its fixture.
  const prior = join(container, 'prior');
  assert.ok(root.startsWith(container) && prior.startsWith(container));
  await rename(root, prior); await mkdir(root);
  const result = await writer.write(join(root, 'new.html'), bytes);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'NEW_FILE_LOCATION_CHANGED');
  assert.deepEqual(await readdir(root), []); assert.deepEqual(await readdir(prior), []);
  const alias = join(container, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createNewFileWriter(alias), /NEW_FILE_LOCATION_CHANGED/);
});
test('failure after creation preserves file evidence and reports unknown at every write stage', async () => {
  for (const stage of ['created', 'written', 'synced', 'verified']) {
    const root = await directory(); const original = join(root, 'original.html'); await writeFile(original, bytes);
    const writer = await createNewFileWriter(root, async (step) => {
      if (step === stage) throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' });
    });
    const target = join(root, 'candidate.html');
    const result = await writer.write(target, bytes);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'NEW_FILE_DISK_FULL');
    assert.equal(result.expectedHash, hash(bytes));
    assert.deepEqual(await readFile(target), stage === 'created' ? Buffer.alloc(0) : bytes);
    assert.deepEqual(await readFile(original), bytes);
    assert.equal((await writer.write(target, bytes)).code, 'NEW_FILE_EXISTS');
  }
});
test('readback corruption and post-verification external mutation never produce created status', async () => {
  for (const stage of ['created', 'synced', 'verified']) {
    const root = await directory(); const target = join(root, 'candidate.html');
    const external = Buffer.alloc(bytes.length, 0x78);
    const writer = await createNewFileWriter(root, async (step) => { if (step === stage) await writeFile(target, external); });
    const outcome = await writer.write(target, bytes);
    assert.equal(outcome.status, 'unknown');
    assert.ok(['NEW_FILE_VERIFY_FAILED', 'NEW_FILE_IDENTITY_CHANGED'].includes(outcome.code));
    assert.deepEqual(await readFile(target), external);
  }
});
