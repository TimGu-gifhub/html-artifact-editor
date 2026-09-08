import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPreviewIdentity, isPreviewReady } from '../../src/contracts/preview.ts';
import { acceptsPreviewReady } from '../../src/main/preview/authority.ts';

const identity = { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', generation: 3, mode: 'proofread' };
const ready = { ...identity, sandboxed: true, contextIsolated: true, readOnly: true };
function context() {
  const url = `artifact://${identity.sessionId}/index.html`;
  const session = {};
  const frame = { url };
  const contents = { session, mainFrame: frame, getURL: () => url, isDestroyed: () => false };
  return { authority: { contents, session, url, identity, isActive: () => true },
    event: { sender: contents, senderFrame: frame } };
}
test('startup contract requires exact fields, true isolation and a read-only mode', () => {
  assert.equal(isPreviewIdentity(identity), true);
  assert.equal(isPreviewReady(ready), true);
  for (const value of [null, [], {}, { ...ready, readOnly: false }, { ...ready, path: '../private.html' },
    { ...ready, offset: 0 }, { ...ready, nodeId: 'fake' }, { ...ready, mode: 'edit' },
    { ...ready, sandboxed: false }, { ...ready, generation: NaN }, { ...ready, generation: -1 },
    { ...ready, sessionId: 'wrong' }, { ...ready, version: 2 }]) assert.equal(isPreviewReady(value), false);
});
test('S-02 checks contents identity, session, main frame, exact URL, generation and live authority', () => {
  const { authority, event } = context();
  assert.equal(acceptsPreviewReady(authority, event, ready), true);
  for (const [scope, sender, payload] of [
    [{ ...authority, isActive: () => false }, event, ready],
    [{ ...authority, session: {} }, event, ready],
    [authority, { ...event, sender: { ...event.sender } }, ready],
    [authority, { ...event, senderFrame: { url: authority.url } }, ready],
    [authority, { ...event, senderFrame: null }, ready],
    [authority, event, { ...ready, generation: 2 }],
    [authority, event, { ...ready, mode: 'interactive' }],
    [authority, event, { ...ready, sessionId: '00000000-0000-4000-8000-000000000002' }],
  ]) assert.equal(acceptsPreviewReady(scope, sender, payload), false);
  event.senderFrame.url += '?spoof';
  assert.equal(acceptsPreviewReady(authority, event, ready), false);
});
