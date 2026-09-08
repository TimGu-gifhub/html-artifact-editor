import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSource } from '../../tools/check-boundaries.mjs';

test('pure modules allow only core and contracts without ambient platform globals', () => {
  assert.deepEqual(checkSource('src/core/sample.ts', `
    import type { Surface } from '../contracts/bootstrap.ts';
    export const bytes = new Uint8Array([1, 2, 3]);
  `), []);
});

for (const source of [
  "import 'electron';", "export * from 'node:fs';",
  "import type { X } from '../platform/window.ts';", "import '../../tools/build.mjs';",
  "const x = import('node:os');", 'const x = import(moduleName);',
  "import fs = require('node:fs');", "type X = import('electron').BrowserWindow;",
  "const x = require('fs');", 'const x = process.platform;',
  'const x = document.body;', 'const x = globalThis.navigator;',
  '/// <reference lib="dom" />',
]) {
  test(`core boundary rejects ${source}`, () => {
    assert.ok(checkSource('src/core/sample.ts', source).length > 0);
  });
}

test('contracts cannot route a transitive dependency back into main', () => {
  assert.ok(checkSource('src/contracts/sample.ts', "export * from '../main/application.ts';").length);
});

test('UI and preview cannot import privileged modules or each other', () => {
  for (const layer of ['ui', 'preview']) {
    for (const source of ["import 'electron';", "import 'node:fs';", "import '../preload/ui.ts';"]) {
      assert.ok(checkSource(`src/${layer}/sample.ts`, source).length);
    }
  }
  assert.ok(checkSource('src/preview/sample.ts', "import '../ui/main.tsx';").length);
});

test('preload dependencies cannot pull in the other preload or main', () => {
  for (const source of ["import './ui.ts';", "import '../main/application.ts';", "import 'node:fs';"]) {
    assert.ok(checkSource('src/preload/preview.ts', source).length);
  }
});
