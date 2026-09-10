import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { allowsPdfFrame, allowsPdfResource } from '../../src/main/product/pdf-policy.ts';
import { lockContents } from '../../src/main/preview/security.ts';

test('PDF session serves one snapshot and bundled viewer resources, never project files or network', () => {
  const current = 'hae-pdf://preview/1.pdf';
  for (const url of [current, 'chrome://resources/js/load_time_data.js', 'chrome://theme/colors.css',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/main.js']) assert.equal(allowsPdfResource(url, current), true);
  for (const url of ['hae-pdf://preview/2.pdf', current + '?file=outside', 'chrome://settings/',
    'chrome://resources.evil/script', 'chrome-extension://other/main.js', 'file:///private/file.pdf',
    'editor://app/index.html', 'artifact://project/index.html', 'https://example.invalid/',
    'http://127.0.0.1/', 'data:application/pdf,private', 'javascript:alert(1)']) assert.equal(allowsPdfResource(url, current), false);
  assert.equal(allowsPdfResource(current, null), false);
});

test('ordinary content still denies all navigation; PDF allows only bundled subframe stream, never top navigation', () => {
  const stream = `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/${randomUUID()}`;
  const fake = () => Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, setWebRTCIPHandlingPolicy() {} });
  const ordinary = fake(); lockContents(ordinary);
  const pdf = fake(); lockContents(pdf, allowsPdfFrame);
  const navigate = (contents, url, isMainFrame) => {
    const event = { url, isMainFrame, blocked: false, preventDefault() { this.blocked = true; } };
    contents.emit('will-frame-navigate', event); return event.blocked;
  };
  assert.equal(navigate(ordinary, stream, false), true);
  assert.equal(navigate(pdf, stream, false), false);
  assert.equal(navigate(pdf, stream, true), true);
  for (const url of ['hae-pdf://preview/private.pdf', 'https://example.invalid/', 'file:///private',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', stream + '/extra']) {
    assert.equal(navigate(pdf, url, false), true);
  }
});
