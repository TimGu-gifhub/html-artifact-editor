// Self-authored minimal TrueType font: one rectangular A glyph. MIT, no third-party asset.
export function testFont(): Uint8Array {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x10000, 0); head.writeUInt32BE(0x10000, 4);
  head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1000, 18);
  head.writeInt16BE(500, 40); head.writeInt16BE(700, 42); head.writeUInt16BE(8, 46);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x10000, 0); hhea.writeInt16BE(800, 4); hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(600, 10); hhea.writeInt16BE(500, 16); hhea.writeInt16BE(1, 18); hhea.writeUInt16BE(2, 34);
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x10000, 0); maxp.writeUInt16BE(2, 4);
  maxp.writeUInt16BE(4, 6); maxp.writeUInt16BE(1, 8); maxp.writeUInt16BE(2, 14);
  const glyf = Buffer.alloc(34);
  glyf.writeInt16BE(1, 0); glyf.writeInt16BE(500, 6); glyf.writeInt16BE(700, 8);
  glyf.writeUInt16BE(3, 10); glyf.fill(1, 14, 18);
  [0, 500, 0, -500, 0, 0, 700, 0].forEach((v, i) => glyf.writeInt16BE(v, 18 + 2 * i));
  const loca = Buffer.alloc(6); loca.writeUInt16BE(glyf.length / 2, 4);
  const hmtx = Buffer.alloc(8); hmtx.writeUInt16BE(600, 0); hmtx.writeUInt16BE(600, 4);
  const cmap = Buffer.alloc(44);
  cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(12, 8);
  [4, 32, 0, 4, 4, 1, 0, 65, 65535, 0, 65, 65535, 65472, 1, 0, 0]
    .forEach((v, i) => cmap.writeUInt16BE(v, 12 + i * 2));
  const os2 = Buffer.alloc(78);
  os2.writeInt16BE(600, 2); os2.writeUInt16BE(400, 4); os2.writeUInt16BE(5, 6);
  os2.writeUInt32BE(1, 42); os2.write('HAE ', 58); os2.writeUInt16BE(64, 62);
  os2.writeUInt16BE(65, 64); os2.writeUInt16BE(65, 66);
  os2.writeInt16BE(800, 68); os2.writeInt16BE(-200, 70);
  os2.writeUInt16BE(800, 74); os2.writeUInt16BE(200, 76);
  const post = Buffer.alloc(32); post.writeUInt32BE(0x30000, 0);
  const nameText = Buffer.from('HaeTest', 'utf16le').swap16();
  const name = Buffer.alloc(18 + nameText.length);
  name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  [3, 1, 0x409, 1, nameText.length, 0].forEach((v, i) => name.writeUInt16BE(v, 6 + 2 * i));
  nameText.copy(name, 18);
  const tables = Object.entries({ 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post })
    .sort(([a], [b]) => a < b ? -1 : 1);
  const checksum = (bytes: Buffer): number => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) sum = (sum + bytes.readUInt32BE(i)) >>> 0;
    return sum;
  };
  let offset = 12 + tables.length * 16;
  const output = Buffer.alloc(offset + tables.reduce((n, [, b]) => n + ((b.length + 3) & ~3), 0));
  output.writeUInt32BE(0x10000, 0); output.writeUInt16BE(tables.length, 4);
  output.writeUInt16BE(128, 6); output.writeUInt16BE(3, 8); output.writeUInt16BE(32, 10);
  let headOffset = 0;
  tables.forEach(([tag, table], i) => {
    const padded = Buffer.alloc((table.length + 3) & ~3); table.copy(padded);
    const record = 12 + 16 * i;
    output.write(tag, record); output.writeUInt32BE(checksum(padded), record + 4);
    output.writeUInt32BE(offset, record + 8); output.writeUInt32BE(table.length, record + 12);
    padded.copy(output, offset); if (tag === 'head') headOffset = offset; offset += padded.length;
  });
  output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headOffset + 8);
  return output;
}
