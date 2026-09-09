import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, release, type } from 'node:os';
import { app } from 'electron';
import { project, original, css } from '../startup/fixture.ts';

app.on('window-all-closed', () => {});
const outputRoot = resolve(__dirname, '..'); const results = resolve(outputRoot, '../test-results');
app.setPath('userData', join(results, `quit-runner-${randomUUID()}`));
const passed: string[] = []; const reports: unknown[] = [];
async function run() {
  if (process.platform !== 'win32') throw new Error('QUIT_PLATFORM_UNSUPPORTED');
  await mkdir(results, { recursive: true }); await app.whenReady();
  const cases = ['clean-window', 'cancel-ime', 'copy', 'save-success', 'save-conflict', 'save-unknown', 'backup-success', 'draft-drain', 'retirement-failure',
    'storage-active', 'forced-close', 'foreign-window', 'renderer-loss'];
  for (const mode of cases) {
    const p = await project(results); const profile = await mkdtemp(join(results, 'quit-profile-')); const reportPath = join(profile, 'quit-result.json');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [join(outputRoot, 'quit-child/index.cjs'), mode, profile, p.root, p.entry, reportPath],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let size = 0;
    const capture = (value: Buffer) => { size += value.length; output = (output + String(value)).slice(-64 * 1024); if (size > 256 * 1024) child.kill('SIGKILL'); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
    const [code, signal] = await once(child, 'close').finally(() => clearTimeout(timeout));
    assert.equal(signal, null, `${mode}: timed out or terminated\n${output}`); assert.equal(code, 0, `${mode}: ${output}`);
    const report = JSON.parse(await readFile(reportPath, 'utf8')); assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.mode, mode); assert.equal(report.flags.length, mode === 'cancel-ime' ? 3 : 1, 'all pre-exit assertions must have run');
    const held = ['save-conflict', 'save-unknown', 'retirement-failure', 'storage-active'].includes(mode);
    assert.equal(report.exit, held ? 'harness-after-block' : 'native'); assert.equal(report.willQuit, held ? 0 : 1);
    assert.equal(report.ready, !held); assert.equal(report.destroyed, !held);
    const expected = ['save-success', 'save-unknown'].includes(mode) ? Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '等待已有保存完成 🧪'))
      : mode === 'save-conflict' ? Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '外部程序的新版本')) : original;
    assert.deepEqual(await readFile(p.entry), expected); assert.deepEqual(await readFile(join(p.root, 'keep.css')), css);
    if (mode === 'copy') assert.deepEqual(await readFile(join(p.root, 'copy.html')), Buffer.from(original.toString().replace('2025 年度报告 &amp; 😀', '明确另存后退出 🧪')));
    if (mode === 'draft-drain') assert.equal(report.departure, 'retired');
    if (mode === 'forced-close') { assert.equal(report.departure, null); assert.equal(report.persistence, 'persisted'); }
    reports.push(report); passed.push(mode); console.log(`PASS: real Electron application quit — ${mode}`);
  }
  await writeFile(join(results, 'quit.json'), JSON.stringify({ status: 'passed', passed, reports,
    scope: 'Real Electron app.quit/window-close events and process exit with production Workspace; Main-controlled decisions, no product/IME/menu acceptance',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    platform: { os: type(), release: release(), arch: arch() }, versions: process.versions }, null, 2));
}
void run().then(() => app.exit(0)).catch(async error => {
  console.error(error); await mkdir(results, { recursive: true });
  await writeFile(join(results, 'quit.json'), JSON.stringify({ status: 'failed', passed, reports, error: String(error) }, null, 2)); app.exit(1);
});
