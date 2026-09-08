import { arch, release, type } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

let productVersion;
if (process.platform === 'darwin') {
  productVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
}
const report = {
  runnerImage: process.env.ImageOS ?? null,
  runnerImageVersion: process.env.ImageVersion ?? null,
  runnerOS: process.env.RUNNER_OS ?? null,
  runnerArch: process.env.RUNNER_ARCH ?? null,
  platform: process.platform, os: type(), release: release(), arch: arch(),
  productVersion, node: process.versions.node,
  npm: process.env.npm_config_user_agent ?? null,
};
await mkdir('test-results', { recursive: true });
await writeFile('test-results/platform.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
