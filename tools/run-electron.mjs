import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const kind = process.argv.includes('--product') ? 'product' : process.argv.includes('--smoke') ? 'smoke'
  : process.argv.includes('--security') ? 'security'
    : process.argv.includes('--mapping') ? 'mapping'
      : process.argv.includes('--patch') ? 'patch'
        : process.argv.includes('--draft') ? 'draft'
          : process.argv.includes('--editor') ? 'editor'
            : process.argv.includes('--workspace') ? 'workspace'
              : process.argv.includes('--session') ? 'session'
                : process.argv.includes('--project') ? 'project'
                  : process.argv.includes('--save-session') ? 'save-session'
                    : process.argv.includes('--startup') ? 'startup'
                      : process.argv.includes('--quit') ? 'quit'
                        : process.argv.includes('--recovery') ? 'recovery'
                          : process.argv.includes('--source-diff') ? 'source-diff'
                            : process.argv.includes('--history') ? 'history'
    : process.argv.includes('--preview') ? 'preview-tool' : 'main';
const smoke = ['product', 'smoke', 'security', 'mapping', 'patch', 'draft', 'editor', 'workspace', 'session', 'project', 'save-session', 'startup', 'quit', 'recovery', 'source-diff', 'history'].includes(kind);
const entry = resolve(root, `out/${kind}/index.cjs`);
if (!existsSync(entry)) throw new Error('Build output missing. Run npm run build first.');
const reportPath = resolve(root, `test-results/${kind}.json`);
if (smoke) {
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(reportPath, '{"status":"running"}\n');
}
const env = { ...process.env };
// Embedded terminals may inherit this flag from their own Electron host.
delete env.ELECTRON_RUN_AS_NODE;
const args = [kind === 'main' ? root : entry];
if (kind === 'preview-tool' && process.argv.includes('--interactive')) args.push('--interactive');
if (kind === 'preview-tool' && process.argv.includes('--directory')) args.push('--directory');
const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit', windowsHide: smoke });
// History also includes 24 separately durable edits plus compaction/restart.
// This is a suite budget; individual workers and IPC keep their existing limits.
const timeoutMs = kind === 'product' ? 180_000 : ['save-session', 'quit', 'recovery', 'history'].includes(kind) ? 90_000 : 45_000;
const timeout = smoke ? setTimeout(() => {
  console.error(`Electron ${kind} exceeded ${timeoutMs / 1000} seconds.`);
  child.kill();
  process.exitCode = 1;
}, timeoutMs) : undefined;
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
