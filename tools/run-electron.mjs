import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const smoke = process.argv.includes('--smoke');
const entry = resolve(root, smoke ? 'out/smoke/index.cjs' : 'out/main/index.cjs');
if (!existsSync(entry)) throw new Error('Build output missing. Run npm run build first.');
const reportPath = resolve(root, 'test-results/smoke.json');
if (smoke) {
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(reportPath, '{"status":"running"}\n');
}
const env = { ...process.env };
// Embedded terminals may inherit this flag from their own Electron host.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [smoke ? entry : root], { cwd: root, env, stdio: 'inherit', windowsHide: smoke });
const timeout = smoke ? setTimeout(() => {
  console.error('Electron smoke exceeded 45 seconds.');
  child.kill();
  process.exitCode = 1;
}, 45_000) : undefined;
child.once('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.once('close', async (code) => {
  clearTimeout(timeout);
  process.exitCode = process.exitCode || code || (code === 0 ? 0 : 1);
  if (smoke) {
    try {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (report.status !== 'passed') process.exitCode = 1;
      console.log(JSON.stringify(report, null, 2));
    } catch { process.exitCode = 1; }
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
