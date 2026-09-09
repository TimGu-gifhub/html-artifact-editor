import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { buildNative } from './build-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = {
  main: ['src/main/index.ts', 'out/main'],
  'preload-ui': ['src/preload/ui.ts', 'out/preload/ui'],
  'preload-preview': ['src/preload/preview.ts', 'out/preload/preview'],
  smoke: ['tests/smoke/main.ts', 'out/smoke'],
  security: ['tests/security/main.ts', 'out/security'],
  'security-preload': ['tests/security/hostile-preload.ts', 'out/security/preload'],
  'preview-tool': ['tools/preview-main.ts', 'out/preview-tool'],
  'parser-worker': ['src/main/parser/worker.ts', 'out/parser-worker'],
  mapping: ['tests/mapping/main.ts', 'out/mapping'],
  patch: ['tests/patch/main.ts', 'out/patch'],
  'draft-worker': ['src/main/draft/worker.ts', 'out/draft-worker'],
  'diff-worker': ['src/main/draft/diff-worker.ts', 'out/diff-worker'],
  'history-worker': ['src/main/draft/history-worker.ts', 'out/history-worker'],
  draft: ['tests/draft/main.ts', 'out/draft'],
  editor: ['tests/editor/main.ts', 'out/editor'],
  'editor-probe': ['tests/editor/probe.ts', 'out/editor/probe'],
  workspace: ['tests/workspace/main.ts', 'out/workspace'],
  session: ['tests/session/main.ts', 'out/session'],
  'session-probe': ['tests/session/probe.ts', 'out/session/probe'],
  project: ['tests/project/main.ts', 'out/project'],
  'save-session': ['tests/save-session/main.ts', 'out/save-session'],
  startup: ['tests/startup/main.ts', 'out/startup'],
  'startup-child': ['tests/startup/child.ts', 'out/startup-child'],
  recovery: ['tests/draft-restore/main.ts', 'out/recovery'],
  'recovery-child': ['tests/draft-restore/child.ts', 'out/recovery-child'],
  'source-diff': ['tests/source-diff/main.ts', 'out/source-diff'],
  history: ['tests/history/main.ts', 'out/history'],
  'history-child': ['tests/history/child.ts', 'out/history-child'],
};
const defaultTargets = ['main', 'preload-ui', 'preload-preview', 'ui', 'preview', 'preview-tool', 'parser-worker', 'draft-worker', 'diff-worker', 'history-worker', 'native'];
const requested = process.argv.slice(2);
for (const target of requested.length ? requested : defaultTargets) {
  if (target === 'native') {
    buildNative();
  } else if (target === 'ui' || target === 'preview') {
    await build({
      configFile: false,
      root: resolve(root, 'src', target), base: './', publicDir: false,
      oxc: { jsx: { runtime: 'automatic' } },
      build: { outDir: resolve(root, 'out', target), emptyOutDir: true, target: 'chrome152' },
    });
  } else {
    const entry = entries[target];
    if (!entry) throw new Error(`Unknown build target: ${target}`);
    await build({
      configFile: false, root, publicDir: false,
      build: {
        outDir: resolve(root, entry[1]), emptyOutDir: true, target: 'node24',
        minify: false,
        lib: { entry: resolve(root, entry[0]), formats: ['cjs'], fileName: () => 'index.cjs' },
        rolldownOptions: {
          external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
        },
      },
    });
  }
}
