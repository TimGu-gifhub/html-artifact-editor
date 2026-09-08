import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { authorizeProject } from '../../src/main/protocol/project-files.ts';
import { HTML_LIMIT, registerProjectProtocol } from '../../src/main/protocol/project-protocol.ts';

const identity = { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', generation: 1, mode: 'proofread' };
async function fixture(t) {
  const base = resolve('test-results/protocol');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(join(base, 'case-'));
  t.after(async () => {
    assert.ok(root.startsWith(`${base}${sep}`));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(join(root, 'index.html'), '\ufeff<p>中文 &amp; 🧪</p>\r\n');
  await fs.writeFile(join(root, 'style.css'), 'body{color:red}');
  let handler;
  let beforeRequest;
  const session = {
    protocol: { handle: (_scheme, fn) => { handler = fn; }, unhandle: () => { handler = undefined; } },
    webRequest: { onBeforeRequest: (fn) => { beforeRequest = fn; } },
  };
  const grant = await authorizeProject(join(root, 'index.html'));
  return { root, grant, session, handle: request => handler(request),
    network: details => new Promise(resolve => beforeRequest(details, resolve)) };
}
test('entry snapshot and returned copies preserve original bytes despite later disk changes', async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(join(f.root, 'index.html'));
  const protocol = await registerProjectProtocol(f.session, f.grant, identity);
  protocol.snapshot().fill(0);
  await fs.writeFile(join(f.root, 'index.html'), 'changed externally');
  const response = await f.handle(new Request(protocol.url));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  assert.deepEqual(Buffer.from(protocol.snapshot()), original);
  protocol.revoke();
});
test('registration rejects invalid UTF-8 and an oversized HTML without a live handler', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, 'index.html'), Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(registerProjectProtocol(f.session, f.grant, identity));
  await fs.writeFile(join(f.root, 'index.html'), Buffer.alloc(HTML_LIMIT + 1, 32));
  await assert.rejects(registerProjectProtocol(f.session, f.grant, identity), /RESOURCE_BLOCKED/);
});
test('revoking while a verified handle is reading prevents the response from returning bytes', async (t) => {
  const f = await fixture(t);
  const protocol = await registerProjectProtocol(f.session, f.grant, identity);
  const originalOpen = fs.open;
  let announce;
  let release;
  const started = new Promise(resolve => { announce = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  fs.open = async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] === join(f.root, 'style.css')) {
      const read = file.read.bind(file);
      file.read = async (...readArgs) => { announce(); await resumed; return read(...readArgs); };
    }
    return file;
  };
  syncBuiltinESMExports();
  try {
    const pending = f.handle(new Request(`artifact://${identity.sessionId}/style.css`));
    await started;
    assert.equal(protocol.revoke(), true);
    assert.equal(protocol.revoke(), false, 'revocation is idempotent');
    release();
    const response = await pending;
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
    assert.deepEqual(await f.network({ url: protocol.url, method: 'GET', resourceType: 'mainFrame' }), { cancel: true });
  } finally { release(); fs.open = originalOpen; syncBuiltinESMExports(); }
});
test('denial diagnostics are bounded and omit paths, credentials and query contents', async (t) => {
  const f = await fixture(t);
  const protocol = await registerProjectProtocol(f.session, f.grant, identity);
  for (let i = 0; i < 150; i++) await f.network({ url: 'https://user:password@example.invalid/private?secret=value', method: 'GET', resourceType: 'xhr' });
  assert.equal(protocol.diagnostics().length, 100);
  assert.ok(protocol.diagnostics().every(({ target }) => target === 'https://example.invalid'));
  protocol.revoke();
});
