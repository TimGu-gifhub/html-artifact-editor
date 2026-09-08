import assert from 'node:assert/strict';
import test from 'node:test';
import { isBootstrapReady } from '../../src/contracts/bootstrap.ts';

const ready = { contractVersion: 1, surface: 'ui', sandboxed: true, contextIsolated: true };
test('accepts the two strictly scoped startup payloads', () => {
  assert.equal(isBootstrapReady(ready), true);
  assert.equal(isBootstrapReady({ ...ready, surface: 'preview' }), true);
});
test('rejects malformed, unsafe, extended and unsupported startup payloads', () => {
  for (const input of [null, [], 'ready', {}, { ...ready, contractVersion: 2 },
    { ...ready, surface: 'child' }, { ...ready, sandboxed: false },
    { ...ready, contextIsolated: false }, { ...ready, path: 'document.html' },
    { ...ready, contractVersion: '1' }]) {
    assert.equal(isBootstrapReady(input), false);
  }
});
