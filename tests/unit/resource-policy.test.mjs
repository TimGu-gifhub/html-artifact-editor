import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewCSP, resourceMime, resourcePath, resourceURL } from '../../src/main/protocol/resource-policy.ts';

const id = '00000000-0000-4000-8000-000000000001';
test('Unicode paths round trip once; queries/fragments do not become disk paths', () => {
  const name = '资源 目录/中文🧪.css';
  assert.equal(resourcePath(`${resourceURL(id, name)}?v=2#theme`, id), name);
});
for (const path of ['../x.css', '%2e%2e/x.css', '%252e%252e/x.css', '%2fetc/x.css',
  '%5c%5cserver/x.css', 'C:/x.css', 'x.css:secret', 'x%00.css', '%zz.css', 'x%255c.css',
  'a//x.css', '.git/x.css', '.env.css', 'backups/x.css', 'Recovery/x.css', 'drafts/x.css',
  'credentials/x.css', 'secrets/x.css', 'node_modules/x.js', 'NUL.css', 'COM1.css', 'LPT².css',
  'a./x.css', 'a%20/x.css', 'PRIVATE~1/x.css', 'a\\x.css']) {
  test(`S-01/S-05 rejects ${path}`, () => assert.throws(() => resourcePath(`artifact://${id}/${path}`, id), /RESOURCE_BLOCKED/));
}
test('authority rejects other hosts, credentials, ports and non-project schemes', () => {
  for (const url of [`artifact://other/a.css`, `artifact://user@${id}/a.css`, `artifact://${id}:80/a.css`,
    'file:///C:/private.css', 'https://example.invalid/a.css', 'data:text/css,body{}', 'blob:artifact://other/id']) {
    assert.throws(() => resourcePath(url, id), /RESOURCE_BLOCKED/);
  }
});
test('only the granted entry and preview MIME allowlist are served', () => {
  assert.match(resourceMime('index.html', 'index.html', 'proofread'), /^text\/html/);
  for (const path of ['a.css', 'a.png', 'a.svg', 'a.woff2']) assert.ok(resourceMime(path, 'index.html', 'proofread'));
  for (const path of ['other.html', 'a.json', 'a.txt', 'a.pem', 'a.js', 'a.mjs']) {
    assert.throws(() => resourceMime(path, 'index.html', 'proofread'));
  }
  assert.match(resourceMime('a.js', 'index.html', 'interactive'), /^text\/javascript/);
});
test('mode CSP retains hard denial of frames, workers, remote connections and forms', () => {
  for (const mode of ['proofread', 'interactive']) {
    const csp = previewCSP(mode);
    for (const rule of ["default-src 'none'", "worker-src 'none'", "frame-src 'none'", "connect-src 'self'", "form-action 'none'"]) {
      assert.ok(csp.includes(rule));
    }
    assert.ok(!csp.includes('unsafe-eval') && !csp.includes('data:') && !csp.includes('blob:'));
  }
  assert.ok(previewCSP('proofread').includes("script-src 'none'"));
});
