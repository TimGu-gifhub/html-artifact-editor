// Static guard for the product UI sources: the trusted renderer must never
// inject HTML, use inline styles (CSP style-src 'self'), or reference remote
// assets. Run: node tests/product/ui-static.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiDir = join(root, 'src', 'ui');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|css|html)$/.test(name)) out.push(path);
  }
  return out;
}

const failures = [];
for (const path of walk(uiDir)) {
  const text = readFileSync(path, 'utf8');
  const rel = path.slice(root.length + 1);
  if (/dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write/.test(text)) {
    failures.push(`${rel}: HTML injection API`);
  }
  if (/\.tsx?$/.test(path) && /style=\{\{/.test(text)) failures.push(`${rel}: inline style prop`);
  if (/style="/.test(text)) failures.push(`${rel}: inline style attribute`);
  if (/https?:\/\//.test(text.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, ''))) failures.push(`${rel}: remote URL`);
  if (/(?:src|href)\s*=\s*"https?:/.test(text)) failures.push(`${rel}: remote asset reference`);
}

if (failures.length) {
  console.error('FAIL: product UI static guard');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`PASS: product UI static guard (${walk(uiDir).length} files)`);
