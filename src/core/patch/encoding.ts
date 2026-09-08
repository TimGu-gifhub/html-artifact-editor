import { encodeUtf8 } from '../parser/utf8.ts';

export const MAX_TEXT_BYTES = 64 * 1024;
export type LineEnding = '\n' | '\r\n' | '\r';
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_BYTES * 2) throw new Error('TEXT_SIZE_LIMIT');
  if (value.includes('\0')) throw new Error('INVALID_TEXT_NUL');
  const normalized = value.replace(/\r\n?/g, '\n');
  if (encodeUtf8(normalized).length > MAX_TEXT_BYTES) throw new Error('TEXT_SIZE_LIMIT');
  return normalized;
}
export function lineEndingCounts(text: string): Map<LineEnding, number> {
  const counts = new Map<LineEnding, number>([['\n', 0], ['\r\n', 0], ['\r', 0]]);
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as LineEnding;
    counts.set(ending, counts.get(ending)! + 1);
  }
  return counts;
}
export function defaultLineEnding(source: string): LineEnding {
  const counts = lineEndingCounts(source);
  const maximum = Math.max(...counts.values());
  const winners = [...counts].filter(([, count]) => count === maximum);
  return winners.length === 1 ? winners[0]![0] : '\n';
}
export function chooseLineEnding(rawSlice: string, fallback: LineEnding): { ending: LineEnding; mixed: boolean } {
  const local = [...lineEndingCounts(rawSlice)].filter(([, count]) => count > 0);
  return { ending: local.length === 1 ? local[0]![0] : fallback, mixed: local.length > 1 };
}
export function encodeText(text: string, ending: LineEnding, consumesLeadingLf: boolean): Uint8Array {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const compensation = consumesLeadingLf && text.startsWith('\n') ? '\n' : '';
  return encodeUtf8((compensation + escaped).replaceAll('\n', ending));
}
