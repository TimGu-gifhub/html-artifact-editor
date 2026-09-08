// Pure UTF-8 codec. Byte offsets refer to the original input, including its BOM.
export const INVALID_BOUNDARY = 0xffff_ffff;
export type Utf8Source = Readonly<{
  text: string;
  hasBom: boolean;
  byteOffsets: Uint32Array;
}>;

export function decodeUtf8(bytes: Uint8Array): Utf8Source {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const offsets = new Uint32Array(bytes.length + 1).fill(INVALID_BOUNDARY);
  const chunks: string[] = [];
  let chars: number[] = [];
  let position = hasBom ? 3 : 0;
  let units = 0;
  offsets[0] = position;
  while (position < bytes.length) {
    const lead = bytes[position]!;
    let length: number;
    let scalar: number;
    let minimum: number;
    if (lead <= 0x7f) { length = 1; scalar = lead; minimum = 0; }
    else if (lead >= 0xc2 && lead <= 0xdf) { length = 2; scalar = lead & 0x1f; minimum = 0x80; }
    else if (lead >= 0xe0 && lead <= 0xef) { length = 3; scalar = lead & 0x0f; minimum = 0x800; }
    else if (lead >= 0xf0 && lead <= 0xf4) { length = 4; scalar = lead & 0x07; minimum = 0x10000; }
    else throw new Error('UNSUPPORTED_ENCODING');
    for (let i = 1; i < length; i++) {
      const continuation = bytes[position + i];
      if (continuation === undefined || continuation < 0x80 || continuation > 0xbf) {
        throw new Error('UNSUPPORTED_ENCODING');
      }
      scalar = (scalar << 6) | (continuation & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      throw new Error('UNSUPPORTED_ENCODING');
    }
    if (scalar <= 0xffff) {
      chars.push(scalar);
      units++;
    } else {
      const pair = scalar - 0x10000;
      chars.push(0xd800 + (pair >> 10), 0xdc00 + (pair & 0x3ff));
      // No byte boundary exists between the two UTF-16 surrogate code units.
      offsets[++units] = INVALID_BOUNDARY;
      units++;
    }
    position += length;
    offsets[units] = position;
    if (chars.length >= 8192) { chunks.push(String.fromCharCode(...chars)); chars = []; }
  }
  if (chars.length) chunks.push(String.fromCharCode(...chars));
  return Object.freeze({ text: chunks.join(''), hasBom, byteOffsets: offsets.slice(0, units + 1) });
}

export function byteBoundary(source: Utf8Source, codeUnit: number): number {
  if (!Number.isSafeInteger(codeUnit) || codeUnit < 0 || codeUnit >= source.byteOffsets.length
    || source.byteOffsets[codeUnit] === INVALID_BOUNDARY) throw new Error('INVALID_TEXT_BOUNDARY');
  return source.byteOffsets[codeUnit]!;
}

// Encoding a source/context string permits NUL. Editing input rejects it separately.
export function encodeUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let offset = 0;
  for (let i = 0; i < text.length; i++) {
    let scalar = text.charCodeAt(i);
    if (scalar >= 0xd800 && scalar <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('INVALID_UNICODE');
      scalar = 0x10000 + ((scalar - 0xd800) << 10) + low - 0xdc00;
    } else if (scalar >= 0xdc00 && scalar <= 0xdfff) throw new Error('INVALID_UNICODE');
    if (scalar < 0x80) bytes[offset++] = scalar;
    else if (scalar < 0x800) {
      bytes[offset++] = 0xc0 | (scalar >> 6);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    } else if (scalar < 0x10000) {
      bytes[offset++] = 0xe0 | (scalar >> 12);
      bytes[offset++] = 0x80 | ((scalar >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    } else {
      bytes[offset++] = 0xf0 | (scalar >> 18);
      bytes[offset++] = 0x80 | ((scalar >> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((scalar >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    }
  }
  return bytes.slice(0, offset);
}
