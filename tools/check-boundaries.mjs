import { readFile, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const layers = {
  contracts: ['contracts'], core: ['core', 'contracts'],
  main: ['main', 'contracts', 'core', 'platform'],
  platform: ['platform', 'contracts'],
  preload: ['contracts', 'preview'],
  preview: ['preview', 'contracts'], ui: ['ui', 'contracts'],
};
const forbiddenPureGlobals = new Set([
  'process', 'Buffer', 'window', 'document', 'navigator', 'global', 'globalThis',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'require', '__dirname', '__filename',
]);

export function checkSource(file, text) {
  const layer = file.split('/')[1];
  if (!layers[layer]) return [`${file}: unknown source layer`];
  const pure = layer === 'core' || layer === 'contracts';
  const errors = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const checkImport = (specifier) => {
    if (typeof specifier !== 'string') {
      errors.push(`${file}: computed module loading is forbidden`);
      return;
    }
    if (specifier.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!target.startsWith('src/') || !layers[layer].includes(target.split('/')[1])) {
        errors.push(`${file}: forbidden cross-layer dependency ${specifier}`);
      }
    } else {
      const allowed = ((layer === 'main' || layer === 'platform') && specifier.startsWith('node:'))
        || (layer === 'core' && specifier === 'parse5')
        || (['main', 'platform', 'preload'].includes(layer) && specifier === 'electron')
        || (layer === 'ui' && /^(react|react-dom)(\/|$)/.test(specifier));
      if (!allowed) errors.push(`${file}: forbidden external dependency ${specifier}`);
    }
  };
  const literal = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      checkImport(literal(node.moduleSpecifier));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkImport(literal(node.moduleReference.expression));
    }
    if (ts.isImportTypeNode(node)) {
      checkImport(ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : undefined);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      checkImport(literal(node.arguments[0]));
    }
    if (pure && ts.isIdentifier(node) && forbiddenPureGlobals.has(node.text)) {
      errors.push(`${file}: platform/DOM global ${node.text} is forbidden in pure code`);
    }
    ts.forEachChild(node, visit);
  }
  if (pure && (source.referencedFiles.length || source.typeReferenceDirectives.length
    || source.libReferenceDirectives.length)) errors.push(`${file}: ambient references are forbidden in pure code`);
  visit(source);
  return errors;
}

export async function checkBoundaries() {
  const errors = [];
  let count = 0;
  async function walk(directory) {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.tsx?$/.test(file)) {
        count++;
        errors.push(...checkSource(file, await readFile(`${root}${file}`, 'utf8')));
      }
    }
  }
  await walk('src');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`PASS: module boundaries (${count} source files).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await checkBoundaries();
