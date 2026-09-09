import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackupRestorer } from '../../src/main/storage/backups.ts';
import { createSavePreparationStore } from '../../src/main/storage/preparation.ts';
import { openSaveSource } from '../../src/platform/save-source.ts';

const old = Buffer.from('\ufeff<!doctype html>\r\n<p>A &amp; 😀</p>\r\n');
const next = Buffer.from('\ufeff<!doctype html>\r\n<p>已保存 🧪</p>\r\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hae-backup-review-')); const path = join(root, '报告.html');
  const privateRoot = join(root, 'private'); await mkdir(privateRoot); await writeFile(path, old);
  const source = await openSaveSource(path, old); const control = { step: async () => {} };
  const store = await createSavePreparationStore(privateRoot, step => control.step(step));
  const prepared = await store.prepare(source, { bytes: next, baseHash: source.baseHash, resultHash: hash(next) });
  assert.equal(prepared.status, 'prepared'); await prepared.cancel();
  // A newly authorized external current version, distinct from the old backup.
  await writeFile(path, next); const current = await openSaveSource(path, next);
  const backups = createBackupRestorer(store); const catalog = await backups.list(current);
  return { root, path, privateRoot, control, store, current, backups, reference: catalog.entries[0].reference };
}

test('backup catalog/review are bounded read-only metadata; raw bytes stay private and copied', async () => {
  const f = await fixture(); const names = await readdir(f.privateRoot);
  const catalog = await f.backups.list(f.current); assert.equal(catalog.entries.length, 1);
  assert.deepEqual(Object.keys(catalog.entries[0]).sort(), ['createdAt', 'hash', 'reference', 'size']);
  assert.equal(catalog.entries[0].size, old.length); assert.equal(catalog.entries[0].hash, hash(old));
  assert.equal(catalog.locked, false); assert.equal(catalog.reviewRequired, false);
  const review = await f.backups.review(f.current, f.reference); review.bytes.fill(0);
  assert.deepEqual(Buffer.from(review.bytes), old); assert.deepEqual(await readFile(f.path), next);
  assert.deepEqual(await readdir(f.privateRoot), names);
  await assert.rejects(f.backups.review(f.current, { ...f.reference, intentHash: '0'.repeat(64) }), /BACKUP_RECORD_CHANGED/);
  const otherPath = join(f.root, 'other.html'); await writeFile(otherPath, next);
  const other = await openSaveSource(otherPath, next);
  assert.deepEqual((await f.backups.list(other)).entries, []);
  await assert.rejects(f.backups.review(other, f.reference), /BACKUP_WRONG_TARGET/);
});

for (const file of ['backup.bin', 'intent.json']) test(`review pins the pre-confirmation ${file} version, including a same-byte rewrite`, async () => {
  const f = await fixture(); const review = await f.backups.review(f.current, f.reference);
  const path = join(f.privateRoot, f.reference.transactionId, file); const bytes = await readFile(path);
  await writeFile(path, bytes); const result = await review.restore(new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'BACKUP_RECORD_CHANGED');
  assert.equal(result.transactionId, null); assert.deepEqual(await readFile(f.path), next);
  assert.deepEqual(await readdir(f.privateRoot), [f.reference.transactionId]);
});

test('a source version changed after review cannot become restoration authority', async () => {
  const f = await fixture(); const review = await f.backups.review(f.current, f.reference);
  await writeFile(f.path, next); const result = await review.restore(new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'FILE_CHANGED');
  assert.equal(result.transactionId, null); assert.deepEqual(await readFile(f.path), next);
});

test('revocation cancels reviewed preparation, retains its reverse backup and deduplicates execution', async () => {
  const f = await fixture(); const review = await f.backups.review(f.current, f.reference); const abort = new AbortController();
  f.control.step = async step => { if (step === 'prepared-synced') abort.abort(); };
  const first = review.restore(abort.signal); assert.equal(review.restore(new AbortController().signal), first);
  const result = await first; assert.equal(result.status, 'cancelled'); assert.equal(result.requiresReview, false);
  const record = await f.store.inspect(result.transactionId); assert.equal(record.phase, 'cancelled');
  assert.equal(record.intent.version, 2); assert.deepEqual(record.intent.restoreOf, f.reference);
  assert.deepEqual(await readFile(join(f.privateRoot, result.transactionId, 'backup.bin')), next);
  assert.deepEqual(await readFile(join(f.privateRoot, result.transactionId, 'candidate.bin')), old);
  assert.deepEqual(await readFile(f.path), next); assert.equal((await f.store.scan()).locked, false);
});

test('absence of a native restoration port cancels prepared evidence and does not report saved', async () => {
  const f = await fixture(); const review = await f.backups.review(f.current, f.reference);
  const result = await review.restore(new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'SAVE_PLATFORM_UNSUPPORTED');
  assert.equal(result.requiresReview, false); assert.equal(result.verifySaved, null);
  assert.equal((await f.store.inspect(result.transactionId)).phase, 'cancelled');
  assert.equal((await f.store.scan()).locked, false); assert.deepEqual(await readFile(f.path), next);
});
