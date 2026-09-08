import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildNative({ tests = false } = {}) {
  if (process.platform !== 'win32') { console.log('Native replacement helper: Windows only; overwrite remains unsupported on this platform.'); return; }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const compiler = resolve(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is required to build the replacement helper.');
  const output = resolve(root, 'out/native'); mkdirSync(output, { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/noconfig', '/utf8output', '/target:exe', '/platform:anycpu', '/optimize+', '/checked+',
    `/out:${resolve(output, 'ReplaceHelper.exe')}`, '/reference:System.dll', '/reference:System.Web.Extensions.dll',
    resolve(root, 'src/platform/windows/ReplaceHelper.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stdout + result.stderr);
  console.log('PASS: Windows ReplaceFileW helper built from repository source.');
  if (tests) {
    const fixtureOutput = resolve(root, 'out/storage-test'); mkdirSync(fixtureOutput, { recursive: true });
    const fixture = spawnSync(compiler, ['/nologo', '/noconfig', '/utf8output', '/target:exe', '/platform:anycpu', '/optimize+',
      `/out:${resolve(fixtureOutput, 'StorageFixture.exe')}`, '/reference:System.dll',
      resolve(root, 'tests/storage/windows/StorageFixture.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (fixture.status !== 0) throw new Error(fixture.error?.message ?? fixture.stdout + fixture.stderr);
    console.log('PASS: test-only Windows file-lock/ACL fixture helper built.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildNative({ tests: process.argv.includes('--tests') });
