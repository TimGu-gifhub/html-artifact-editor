import { isMappingIdentity } from './mapping.ts';
import type { MappingIdentity } from './mapping.ts';
import { isInlineTextGeometry } from './inline-text.ts';
import type { InlineTextGeometry } from './inline-text.ts';
export const TEXT_GEOMETRY = 'hae:text-geometry';
export const TEXT_DECORATION = 'hae:text-decoration';
export type TextRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type TextShape = Readonly<{ nodeId: string; rects: readonly TextRect[] }>;
export type TextDecoration = Readonly<{ hover: TextShape | null; selected: TextShape | null }>;
export type TextGeometry = TextDecoration & Readonly<{ identity: MappingIdentity; revision: number; sequence: number; width: number; height: number; inline?: InlineTextGeometry | null }>;
export type DecorationAPI = Readonly<{ onState: (listener: (state: TextDecoration) => void) => () => void }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 16384;
function shape(value: unknown): boolean {
  return value === null || (object(value) && Object.keys(value).length === 2 && typeof value.nodeId === 'string' && /^n[0-9]{1,6}$/u.test(value.nodeId)
    && Array.isArray(value.rects) && value.rects.length <= 80 && value.rects.every(rect => object(rect) && Object.keys(rect).length === 4
      && dimension(rect.x) && dimension(rect.y) && dimension(rect.width) && dimension(rect.height)));
}
export function isTextDecoration(value: unknown): value is TextDecoration {
  return object(value) && Object.keys(value).length === 2 && shape(value.hover) && shape(value.selected);
}
export function isTextGeometry(value: unknown): value is TextGeometry {
  return object(value) && Object.keys(value).length === (Object.hasOwn(value, 'inline') ? 8 : 7) && isMappingIdentity(value.identity)
    && Number.isSafeInteger(value.revision) && (value.revision as number) > 0
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
    && dimension(value.width) && dimension(value.height) && shape(value.hover) && shape(value.selected)
    && (!Object.hasOwn(value, 'inline') || value.inline === null || isInlineTextGeometry(value.inline));
}
