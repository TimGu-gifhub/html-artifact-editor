import assert from 'node:assert/strict';
import test from 'node:test';
import { byteBoundary, decodeUtf8, encodeUtf8, INVALID_BOUNDARY } from '../../src/core/parser/utf8.ts';

test('strict UTF-8 codec agrees with platform codec for every Unicode scalar', () => {
  // Independent standard encoder/decoder oracle; include all legal scalar values.
  for (let start = 0; start <= 0x10ffff; start += 4096) {
    const scalars = [];
    for (let cp = start; cp < Math.min(start + 4096, 0x110000); cp++) {
      if (cp < 0xd800 || cp > 0xdfff) scalars.push(cp);
    }
    const text = String.fromCodePoint(...scalars);
    const expected = new TextEncoder().encode(text);
    assert.deepEqual(encodeUtf8(text), expected);
    assert.equal(decodeUtf8(expected).text, text);
  }
});

test('BOM, CJK, emoji, combining characters and mixed line endings have exact byte boundaries', () => {
  const text = '中😀e\u0301\r\n甲\r乙\n末';
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const decoded = decodeUtf8(bytes);
  assert.equal(decoded.text, text);
  assert.equal(decoded.hasBom, true);
  let codeUnit = 0;
  let offset = 3;
  assert.equal(byteBoundary(decoded, 0), 3);
  for (const scalar of text) {
    assert.equal(byteBoundary(decoded, codeUnit), offset);
    if (scalar.length === 2) {
      assert.equal(decoded.byteOffsets[codeUnit + 1], INVALID_BOUNDARY);
      assert.throws(() => byteBoundary(decoded, codeUnit + 1), /INVALID_TEXT_BOUNDARY/);
    }
    codeUnit += scalar.length;
    offset += Buffer.byteLength(scalar, 'utf8');
    assert.equal(byteBoundary(decoded, codeUnit), offset);
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, text.length + 1]) {
    assert.throws(() => byteBoundary(decoded, invalid), /INVALID_TEXT_BOUNDARY/);
  }
  assert.equal(byteBoundary(decodeUtf8(new Uint8Array()), 0), 0);
  assert.equal(byteBoundary(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf])), 0), 3);
  assert.equal(decodeUtf8(Buffer.from('a\ufeffb')).text, 'a\ufeffb');
});

test('invalid UTF-8 is rejected, never replaced silently', () => {
  for (const bytes of [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x20],
    [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xe2, 0x82], [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80], [0xff], [0xfe, 0xff], [0xff, 0xfe, 0, 0],
    [0xef, 0xbb, 0xbf, 0xc0, 0x80],
  ]) assert.throws(() => decodeUtf8(new Uint8Array(bytes)), /UNSUPPORTED_ENCODING/);
});

test('unpaired UTF-16 surrogates are rejected by the encoder', () => {
  for (const text of ['\ud800', '\udc00', '\ud800x', 'x\udfff', '\ud800\ud800']) {
    assert.throws(() => encodeUtf8(text), /INVALID_UNICODE/);
  }
});
