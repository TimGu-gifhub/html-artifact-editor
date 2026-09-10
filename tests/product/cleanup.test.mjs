import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { source, css } from './acceptance-fixture.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const results = join(root, 'test-results');
const childEntry = join(root, 'out/product-cleanup-child/index.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
// Independent byte oracle; never computed from Main's patch ranges/candidate.
function expected(count) {
  let value = source;
  for (const [from, to] of [
    ['年度 &#65; 报告 😀', '年度 B 报告 🧪'],
    ['2025-01-01', '2026-09-10'], ['一 &amp; 二', '核对 &lt;&amp;&gt;'],
  ].slice(0, count)) {
    assert.equal(value.split(from).length, 2); value = value.replace(from, to);
  }
  return Buffer.from(value);
}
async function fixture(name) {
  const base = await mkdtemp(join(results, 'record-cleanup-' + name + '-'));
  const project = join(base, 'project'); await mkdir(project);
  await writeFile(join(project, 'report.html'), source);
  await writeFile(join(project, 'wrong.html'), source);
  await writeFile(join(project, 'keep.css'), css);
  return { base, project, profile: join(base, 'profile'), entry: join(project, 'report.html') };
}
function launch(t, mode, value, sessionId = '', observation = '') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [childEntry, mode, value.profile, value.project, sessionId, observation],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const receipts = [], listeners = new Set();
  let ended = null, failure = null, buffer = '', output = '';
  const finish = (code, signal) => { ended = { code, signal }; for (const notify of listeners) notify(); };
  child.on('error', error => { failure = error; finish(null, null); }); child.on('close', finish);
  const append = chunk => { output = (output + chunk).slice(-262144); };
  child.stderr.on('data', append);
  child.stdout.on('data', chunk => {
    append(chunk); buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith('HAE_CLEANUP:')) continue;
      const value = JSON.parse(line.slice('HAE_CLEANUP:'.length)); receipts.push(value);
      if (value.event === 'failed') failure = new Error(value.error + '\n' + value.stack + '\n' + JSON.stringify(value));
      for (const notify of listeners) notify();
    }
  });
  const wait = (check, label) => new Promise((accept, reject) => {
    const timer = setTimeout(() => { listeners.delete(inspect); reject(Error(mode + ' timeout ' + label + '\n' + output.slice(-5000))); }, 60000);
    const inspect = () => {
      const answer = check();
      if (!failure && answer === undefined && !ended) return;
      clearTimeout(timer); listeners.delete(inspect);
      if (failure) reject(failure); else if (answer !== undefined) accept(answer);
      else reject(Error(mode + ' exited before ' + label + ' ' + JSON.stringify(ended) + '\n' + output.slice(-5000)));
    };
    listeners.add(inspect); inspect();
  });
  t.after(async () => {
    if (!ended) { child.kill('SIGKILL'); await new Promise(done => { if (ended) done(); else child.once('close', done); }); }
    await writeFile(join(value.base, mode + '.log'), output);
  });
  return { child, receipt: name => wait(() => receipts.find(row => row.event === name), name),
    exited: () => wait(() => ended ?? undefined, 'process exit') };
}
async function projectEvidence(value) {
  const result = {};
  for (const item of await readdir(value.project, { withFileTypes: true })) {
    if (item.isFile() && item.name !== 'report.html') result[item.name] = hash(await readFile(join(value.project, item.name)));
  }
  return result;
}

test('M2 record cleanup: real native workflow, killed processes, preserved source and quota reuse', { timeout: 600000 }, async t => {
  await mkdir(results, { recursive: true });
  const report = { status: 'running', platform: { os: type(), release: release(), arch: arch() }, passed: [], evidence: [],
    pending: ['maintainer report acceptance', 'real native chooser and confirmation; IME', 'Windows 10, DPI and screen reader', 'power loss and disk full'] };
  const saveReport = () => writeFile(join(results, 'product-cleanup.json'), JSON.stringify(report, null, 2));
  await saveReport();
  if (process.platform !== 'win32') { report.status = 'unavailable'; await saveReport(); t.skip('Windows product/native Save required.'); return; }
  const kill = async running => { running.child.kill('SIGKILL'); assert.notEqual((await running.exited()).code, 0); };
  const success = async running => { const value = await running.receipt('checked'); assert.deepEqual(await running.exited(), { code: 0, signal: null }); return value; };
  const privateFiles = async value => {
    const dir = join(value.profile, 'workspace-records'), found = {};
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isFile()) found[item.name] = hash(await readFile(join(dir, item.name)));
      else for (const name of await readdir(join(dir, item.name))) found[item.name + '/' + name] = hash(await readFile(join(dir, item.name, name)));
    }
    return found;
  };
  try {
    for (const mode of ['empty', 'basic', 'close-join', 'loss-before', 'loss-after', 'unknown', 'warning', 'root-replaced']) {
      const value = await fixture(mode), before = await projectEvidence(value);
      const running = launch(t, mode, value);
      const retained = ['unknown', 'warning'].includes(mode);
      const result = retained ? await running.receipt('retained') : await running.receipt('checked');
      if (retained || mode === 'root-replaced') await kill(running);
      else assert.deepEqual(await running.exited(), { code: 0, signal: null });
      assert.deepEqual(await readFile(value.entry), mode === 'basic' ? expected(1) : Buffer.from(source));
      assert.deepEqual(await projectEvidence(value), before);
      if (mode === 'root-replaced') {
        assert.deepEqual(await readdir(join(value.profile, 'workspace-records')), []);
        assert.equal((await readdir(join(value.profile, 'workspace-records-preserved'))).length, 4);
      }
      if (mode === 'warning' || mode === 'close-join') assert.deepEqual(await readdir(join(value.profile, 'workspace-records')), []);
      report.passed.push(mode); report.evidence.push({ mode, base: value.base, result }); await saveReport();
    }
    for (const stage of ['cleanup-journal-ready', 'cleanup-after-remove', 'cleanup-before-finish']) {
      const value = await fixture(stage), before = await projectEvidence(value);
      const seeded = launch(t, 'seed', value, stage); const barrier = await seeded.receipt('seeded');
      assert.ok(Number.isSafeInteger(barrier.pid)); assert.equal(barrier.summary.records, 4);
      const beforeKill = await privateFiles(value);
      assert.ok(beforeKill['record-cleanup.json']);
      if (stage === 'cleanup-journal-ready') {
        assert.equal((await success(launch(t, 'profile-probe', value))).kind, 'profile-exclusion');
        assert.deepEqual(await privateFiles(value), beforeKill);
      }
      await kill(seeded); assert.deepEqual(await readFile(value.entry), Buffer.from(source));
      const resumed = await success(launch(t, 'resume', value));
      assert.equal(resumed.summary.resuming, true); assert.equal(resumed.summary.records, 4);
      assert.deepEqual(await readFile(value.entry), expected(1)); assert.deepEqual(await projectEvidence(value), before);
      report.passed.push(stage + '-restart'); report.evidence.push({ stage, base: value.base, resumed }); await saveReport();
    }
    for (const bad of ['partial-manifest', 'unresolved-lock']) {
      const value = await fixture(bad), before = await projectEvidence(value), dir = join(value.profile, 'workspace-records');
      const seeded = launch(t, 'seed', value, 'cleanup-journal-ready'); await seeded.receipt('seeded'); await kill(seeded);
      if (bad === 'partial-manifest') await writeFile(join(dir, 'record-cleanup.json'), '{"version":1,');
      else await writeFile(join(dir, 'active.lock'), 'unclassified lock evidence');
      const records = await privateFiles(value);
      const checked = await success(launch(t, 'unsupported', value));
      assert.equal(checked.result.status, 'failed'); assert.deepEqual(await privateFiles(value), records);
      assert.deepEqual(await readFile(value.entry), Buffer.from(source)); assert.deepEqual(await projectEvidence(value), before);
      report.passed.push(bad); report.evidence.push({ bad, base: value.base }); await saveReport();
    }
    const quota = await fixture('quota'), before = await projectEvidence(quota);
    const full = launch(t, 'quota-copy', quota);
    const point = await full.receipt('quota-full'); assert.equal(point.persistence.status, 'failed');
    await success(full);
    assert.deepEqual(await privateFiles(quota), point.records);
    assert.deepEqual(await readFile(quota.entry), Buffer.from(source));
    assert.deepEqual(await readFile(join(quota.project, 'quota-draft.html')), expected(1));
    assert.equal((await readdir(join(quota.profile, 'workspace-records'))).length, 20);
    const cleared = await success(launch(t, 'resume', quota, 'quota'));
    assert.equal(cleared.summary.backups, 20); assert.equal(cleared.summary.resuming, false);
    assert.deepEqual(await readFile(quota.entry), expected(1));
    assert.deepEqual(await readFile(join(quota.project, 'quota-draft.html')), expected(1));
    const after = await projectEvidence(quota); delete after['quota-draft.html']; assert.deepEqual(after, before);
    report.passed.push('full-quota-copy-exit-clear-new-reviewed-save');
    report.evidence.push({ base: quota.base, cleared });
    report.status = 'passed'; await saveReport();
    process.stdout.write(JSON.stringify({ productCleanup: report.status, scenarios: report.passed.length, report: join(results, 'product-cleanup.json') }) + '\n');
  } catch (error) { report.status = 'failed'; report.error = String(error); await saveReport(); throw error; }
});
