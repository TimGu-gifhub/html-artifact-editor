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
const childEntry = join(root, 'out/product-interruption-child/index.cjs');
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
  const base = await mkdtemp(join(results, 'interruption-' + name + '-'));
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
      if (!line.startsWith('HAE_INTERRUPTION:')) continue;
      const value = JSON.parse(line.slice('HAE_INTERRUPTION:'.length)); receipts.push(value);
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
test('M2 product interruption workflow: real killed processes, native resolution, byte preservation and lifecycle', { timeout: 600000 }, async t => {
  await mkdir(results, { recursive: true });
  const report = { status: 'running', platform: { os: type(), release: release(), arch: arch() }, passed: [], evidence: [],
    pending: ['maintainer report acceptance', 'real native chooser and IME interaction', 'Windows 10, DPI and screen reader', 'power loss and disk full'] };
  const saveReport = () => writeFile(join(results, 'product-interruption.json'), JSON.stringify(report, null, 2));
  await saveReport();
  if (process.platform !== 'win32') { report.status = 'unavailable'; await saveReport(); t.skip('Windows product/native recovery required.'); return; }
  const kill = async running => {
    running.child.kill('SIGKILL'); const exit = await running.exited(); assert.notEqual(exit.code, 0);
  };
  try {
    const empty = await fixture('empty');
    const emptyRun = launch(t, 'empty', empty);
    await emptyRun.receipt('checked'); await emptyRun.receipt('closing'); assert.deepEqual(await emptyRun.exited(), { code: 0, signal: null });
    report.passed.push('no supported lock and active document exclusion; stale revision and narrow Main command');
    const cases = [
      ['incomplete', 'incomplete', 'unsupported', 'baseline-matches'],
      ['partial-intent', 'partial-intent', 'simple', 'baseline-matches'],
      ['partial-backup', 'partial-backup', 'basic', 'baseline-matches'],
      ['partial-candidate', 'partial-candidate', 'simple', 'baseline-matches'],
      ['partial-seal', 'partial-seal', 'simple', 'baseline-matches'],
      ['partial-resolution-restart', 'partial-backup', 'seed-resolution', 'baseline-matches'],
      ['partial-unknown', 'partial-backup', 'unknown', 'baseline-matches'],
      ['partial-warning', 'partial-backup', 'warning', 'baseline-matches'],
      ['baseline', 'prepared', 'basic', 'baseline-matches'],
      ['committed', 'committed', 'simple', 'committed-matches'],
      ['candidate', 'candidate', 'simple', 'candidate-on-disk'],
      ['review-conflict', 'prepared', 'stale-review', 'conflict'],
      ['compaction', 'compaction', 'simple', 'compaction'],
      ['close', 'prepared', 'close-join', 'baseline-matches'],
      ['renderer-before', 'prepared', 'loss-before', 'baseline-matches'],
      ['renderer-after', 'prepared', 'loss-after', 'baseline-matches'],
      ['unknown', 'prepared', 'unknown', 'baseline-matches'],
      ['warning', 'prepared', 'warning', 'baseline-matches'],
      ['save-resolution-restart', 'prepared', 'seed-resolution', 'baseline-matches'],
      ['compaction-resolution-restart', 'compaction', 'seed-resolution', 'compaction'],
    ];
    for (const [name, stage, mode, observation] of cases) {
      const value = await fixture(name);
      const seeding = launch(t, 'seed-' + stage, value);
      const seeded = await seeding.receipt('seeded'); await kill(seeding);
      assert.deepEqual(await readFile(value.entry), stage === 'candidate' || stage === 'committed' ? expected(1) : Buffer.from(source));
      const privateRoot = join(value.profile, 'workspace-records');
      assert.ok((await readdir(privateRoot)).includes('active.lock'));
      if (stage === 'compaction') await writeFile(join(value.base, 'seed-journal.json'), await readFile(join(privateRoot, 'compaction.json')));
      const preserved = await projectEvidence(value);
      let running = launch(t, mode, value, seeded.sessionId, observation);
      if (mode === 'seed-resolution') {
        await running.receipt('resolution-seeded'); await kill(running);
        assert.deepEqual(await readFile(value.entry), Buffer.from(source));
        running = launch(t, 'simple', value, seeded.sessionId, observation);
      }
      const retained = mode === 'unknown' || mode === 'warning';
      const result = await running.receipt(retained ? 'retained' : 'checked');
      if (retained) await kill(running);
      else {
        if (mode !== 'close-join') await running.receipt('closing');
        assert.deepEqual(await running.exited(), { code: 0, signal: null });
      }
      const file = await readFile(value.entry);
      const expectedFile = retained || mode === 'close-join' || mode === 'unsupported' ? Buffer.from(source)
        : observation === 'conflict' ? Buffer.from(source + '<!-- external review-time change -->\r\n')
        : expected(observation === 'compaction' ? 3 : 1);
      assert.deepEqual(file, expectedFile, name + ' exact full source including BOM, CRLF, entities, emoji and unchanged script');
      const current = await projectEvidence(value);
      for (const [key, digest] of Object.entries(preserved)) assert.equal(current[key], digest, 'preserved project evidence ' + key);
      const names = await readdir(privateRoot);
      assert.equal(names.includes('active.lock'), mode === 'unknown' || mode === 'unsupported');
      report.evidence.push({ name, stage: seeded.step, observation, result, htmlHash: hash(file), fixture: value.base });
      report.passed.push(name); await saveReport();
    }
    report.status = 'passed'; await saveReport();
  } catch (error) {
    report.status = 'failed'; report.error = String(error); await saveReport(); throw error;
  }
});
