import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(`${root}package-lock.json`, 'utf8'));
const rows = Object.entries(lock.packages).filter(([path]) => path).sort(([a], [b]) => a.localeCompare(b, 'en'));
const lines = [
  '# 第三方依赖清单', '',
  '由 `npm run licenses` 从单一锁文件生成；`npm run licenses:check` 校验一致性。', '',
  '清单包含全部平台的可选构建依赖，不代表每个平台均已安装或验证。',
  'runtime 表示应用依赖，dev 表示开发/构建依赖。许可证字段来自 npm 包元数据，不能替代原始声明。', '',
  '| 包（锁文件安装位置） | 版本 | 用途 | 许可证 | 平台限制 |',
  '| --- | --- | --- | --- | --- |',
];
for (const [path, info] of rows) {
  if (!info.license || !info.version || !info.integrity) throw new Error(`Incomplete dependency metadata: ${path}`);
  lines.push(`| ${path.replaceAll('node_modules/', '')} | ${info.version} | ${info.dev ? 'dev' : 'runtime'} | ${info.license} | ${(info.os ?? ['all']).join(', ')} / ${(info.cpu ?? ['all']).join(', ')} |`);
}
lines.push('', '## 随构建保留的声明', '',
  '`npm run licenses` 同时写出被 Git 忽略的 `out/licenses/`：', '',
  '- React、React DOM、Scheduler 的原始 MIT LICENSE。',
  '- parse5 的 MIT LICENSE 与其运行依赖 entities 的 BSD-2-Clause LICENSE。',
  '- Electron 的 LICENSE 与完整 LICENSES.chromium.html；后者包含 Chromium/Node 及其第三方组件声明。',
  '- 本项目的 MIT LICENSE。', '',
  '当前没有安装包。HAE-015 打包时必须带上这些声明，并重新审查实际分发依赖；',
  '不能仅携带这份清单。构建依赖中的 MPL-2.0 文件如以后被修改或分发，应按其许可证保留相应义务。', '');
const rendered = lines.join('\n');
const destination = `${root}docs/DEPENDENCIES.md`;
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== rendered) throw new Error('Dependency inventory is stale. Run npm run licenses.');
  console.log(`PASS: dependency license inventory (${rows.length} packages).`);
} else {
  await writeFile(destination, rendered);
}
await mkdir(`${root}out/licenses`, { recursive: true });
for (const [source, name] of [
  ['LICENSE', 'HTML-Artifact-Editor-LICENSE'],
  ['node_modules/react/LICENSE', 'React-LICENSE'],
  ['node_modules/react-dom/LICENSE', 'React-DOM-LICENSE'],
  ['node_modules/scheduler/LICENSE', 'Scheduler-LICENSE'],
  ['node_modules/parse5/LICENSE', 'parse5-LICENSE'],
  ['node_modules/entities/LICENSE', 'entities-LICENSE'],
  ['node_modules/electron/dist/LICENSE', 'Electron-LICENSE'],
  ['node_modules/electron/dist/LICENSES.chromium.html', 'LICENSES.chromium.html'],
]) await copyFile(`${root}${source}`, `${root}out/licenses/${name}`);
