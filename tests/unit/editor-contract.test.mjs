import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { isEditorCommand, isEditorRequest } from '../../src/contracts/editor.ts';
import { acceptsEditorSender } from '../../src/main/editor/authority.ts';
import { createEditorTransport } from '../../src/main/editor/transport.ts';

const sessionId = '00000000-0000-4000-8000-000000000001';
test('revoked transport drains all accepted commands, including late rejection, without retaining page authority', async () => {
  const frame = { url: 'editor://app/index.html', detached: false }; const handles = new Map();
  const contents = Object.assign(new EventEmitter(), { session: {}, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false,
    ipc: { handle: (name, callback) => handles.set(name, callback), removeHandler: name => handles.delete(name) } });
  const event = { sender: contents, senderFrame: frame }; const waits = []; let revoked = 0;
  const transport = createEditorTransport(contents, { connect: 'connect', command: 'command', state: 'state' }, {
    snapshot: () => ({}), onState: () => () => {}, isRequest: isEditorRequest, onRevoke: () => { revoked++; },
    execute: (_command, active, signal) => new Promise((resolve, reject) => { waits.push({ active, signal, resolve, reject }); }),
  });
  const connected = handles.get('connect')(event); const dispatch = handles.get('command');
  const first = dispatch(event, { sessionId: connected.sessionId, sequence: 1, command: { kind: 'read' } });
  const second = dispatch(event, { sessionId: connected.sessionId, sequence: 2, command: { kind: 'read' } });
  const rejected = assert.rejects(second, /late failure/);
  transport.close(); transport.close(); assert.equal(revoked, 1); assert.equal(handles.size, 0);
  assert.ok(waits.every(value => value.signal.aborted && !value.active()));
  assert.equal(await dispatch(event, { sessionId: connected.sessionId, sequence: 3, command: { kind: 'read' } }), null);
  let complete = false; const draining = transport.drain().then(() => { complete = true; });
  waits[0].resolve({}); assert.equal(await first, null); await Promise.resolve(); assert.equal(complete, false);
  waits[1].reject(new Error('late failure')); await rejected; await draining; assert.equal(complete, true);
  await transport.drain(); assert.equal(waits.length, 2);
});
test('editor transport accepts only exact bounded commands, never a file path, selector, offset or arbitrary IPC operation', () => {
  const version = { editToken: sessionId, inputRevision: 1 };
  const selection = { identity: { preview: { version: 1, sessionId, generation: 1, mode: 'proofread' },
    documentId: sessionId, baseHash: 'a'.repeat(64) }, revision: 1, nodeId: 'n1' };
  for (const command of [{ kind: 'read' }, { kind: 'begin', value: { selection, draftRevision: 1 } },
    { kind: 'change', value: { ...version, newText: '中文\0😀', composing: true } }, { kind: 'apply', value: version },
    { kind: 'resolve', value: { ...version, decision: 'discard', intentSequence: null } }, { kind: 'save-copy', stateRevision: 3 }]) {
    assert.ok(isEditorCommand(command)); assert.ok(isEditorRequest({ sessionId, sequence: 1, command }));
  }
  for (const bad of [null, [], { kind: 'invoke', channel: 'fs' }, { kind: 'save-copy', stateRevision: 1, path: 'x.html' },
    { kind: 'save-copy', stateRevision: NaN }, { kind: 'read', offset: 1 }, { kind: 'apply', value: { ...version, selector: 'h1' } },
    { kind: 'begin', value: { selection: { ...selection, path: 'x' }, draftRevision: 1 } }]) assert.equal(isEditorCommand(bad), false);
});
test('connection envelopes require a UUID and positive safe sequence with no extra authority', () => {
  const valid = { sessionId, sequence: 1, command: { kind: 'read' } };
  for (const bad of [{ ...valid, sessionId: 'x' }, { ...valid, sequence: 0 }, { ...valid, sequence: -1 },
    { ...valid, sequence: 1.5 }, { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, force: true }]) {
    assert.equal(isEditorRequest(bad), false);
  }
});
test('editor authority pins exact contents, session, top frame, URL and live page; navigation and detached frames fail closed', () => {
  const frame = { url: 'editor://app/index.html', detached: false };
  const session = {};
  const contents = { session, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const authority = { contents, session, frame: () => frame, isActive: () => true };
  const event = { sender: contents, senderFrame: frame };
  assert.ok(acceptsEditorSender(authority, event));
  assert.ok(acceptsEditorSender({ ...authority, frame: () => null }, event));
  for (const [scope, sender] of [
    [{ ...authority, isActive: () => false }, event], [{ ...authority, session: {} }, event],
    [{ ...authority, frame: () => ({ ...frame }) }, event], [authority, { ...event, sender: { ...contents } }],
    [authority, { ...event, senderFrame: { ...frame } }], [authority, { ...event, senderFrame: null }],
  ]) assert.equal(acceptsEditorSender(scope, sender), false);
  for (const url of ['editor://app/index.html?spoof', 'editor://app/index.html#hash', 'editor://app/other.html', 'artifact://app/index.html']) {
    frame.url = url; assert.equal(acceptsEditorSender(authority, event), false);
  }
  frame.url = 'editor://app/index.html'; frame.detached = true;
  assert.equal(acceptsEditorSender(authority, event), false);
  frame.detached = false; contents.isDestroyed = () => true;
  assert.equal(acceptsEditorSender(authority, event), false);
  contents.isDestroyed = () => { throw new Error('gone'); };
  assert.equal(acceptsEditorSender(authority, event), false);
});
