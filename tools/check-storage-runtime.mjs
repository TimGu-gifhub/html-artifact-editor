import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, release, type } from 'node:os';
import { resolve } from 'node:path';
import electron from 'electron';
import { buildNative } from './build-native.mjs';

// Filesystem tests under Electron's bundled Node, with no window or user page.
// Node mode is scoped to these child processes; normal app launch is unchanged.
// Includes the 48-write compaction stress case and native fault/crash cases.
const options = { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 };
const results = resolve('test-results'); mkdirSync(results, { recursive: true });
const record = { status: 'running', commit: null, dirty: null, platform: { os: type(), release: release(), arch: arch() }, versions: null };
const report = () => writeFileSync(resolve(results, 'storage-runtime.json'), `${JSON.stringify(record, null, 2)}\n`);
report();
try {
  buildNative({ tests: true });
  const git = (args) => { const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
  record.commit = git(['rev-parse', 'HEAD']); record.dirty = !!git(['status', '--porcelain']);
  const version = spawnSync(electron, ['-p', 'JSON.stringify(process.versions)'], options); assert.equal(version.status, 0);
  record.versions = JSON.parse(version.stdout); assert.ok(record.versions.electron && record.versions.node);
  const files = ['tests/unit/save-preparation.test.mjs', 'tests/unit/draft-checkpoint-store.test.mjs', 'tests/unit/draft-lifecycle.test.mjs',
    'tests/unit/history-persistence.test.mjs', 'tests/unit/checkpoint-compaction.test.mjs', 'tests/unit/compaction-resolution.test.mjs'];
  if (process.platform === 'win32') files.push('tests/unit/save-commit.test.mjs', 'tests/unit/save-recovery.test.mjs', 'tests/unit/draft-checkpoint-save.test.mjs',
    'tests/unit/history-committed-recovery.test.mjs');
  record.nativeReplacement = process.platform === 'win32' ? 'included' : 'unsupported';
  const run = spawnSync(electron, ['--test', '--test-concurrency=4', '--test-reporter=tap', ...files], options);
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  writeFileSync(resolve(results, 'storage-runtime.log'), output);
  assert.equal(run.status, 0, run.error?.message ?? output.slice(-6000));
  const count = (name) => { const found = output.match(new RegExp(`^# ${name} (\\d+)\\r?$`, 'm')); assert.ok(found, `Missing ${name} result`); return Number(found[1]); };
  const tests = count('tests'); assert.ok(tests > 0); assert.equal(count('pass'), tests);
  for (const field of ['fail', 'cancelled', 'skipped']) assert.equal(count(field), 0);
  record.status = 'passed'; record.tests = tests; report();
  console.log(`PASS: ${tests} storage tests under Electron ${record.versions.electron} / Node ${record.versions.node}; report: test-results/storage-runtime.json`);
} catch (error) {
  record.status = 'failed'; record.error = String(error); report(); console.error(error); process.exitCode = 1;
}
