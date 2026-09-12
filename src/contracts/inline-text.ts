import type { TextRect } from './text-geometry.ts';

// Display metadata from the isolated, proven Text object. None of these values
// selects a Text or grants input/source authority.
export type InlineTextStyle = Readonly<{
  fontFamily: string; fontSize: number; fontWeight: string; fontStyle: string;
  lineHeight: number; letterSpacing: number; color: string; background: string;
  whiteSpace: 'normal' | 'pre' | 'pre-wrap' | 'pre-line' | 'break-spaces';
  textAlign: 'left' | 'center' | 'right' | 'start' | 'end' | 'justify';
  direction: 'ltr' | 'rtl'; indent: number;
}>;
export type InlineTextGeometry = Readonly<{
  nodeId: string; rect: TextRect; style: InlineTextStyle; caret: number; activation: number;
}>;
export type InlineTextPlacement = InlineTextGeometry & Readonly<{
  documentId: string;
  // Main-only presentation fallback. Keeps the same input binding when its
  // source Text leaves the viewport; never accepted from Preview geometry.
  detached?: boolean;
}>;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export function isInlineTextGeometry(value: unknown): value is InlineTextGeometry {
  if (!object(value) || Object.keys(value).length !== 5 || typeof value.nodeId !== 'string' || !/^n[0-9]{1,6}$/u.test(value.nodeId)
    || !Number.isSafeInteger(value.caret) || !number(value.caret, 0, 128 * 1024)
    || !Number.isSafeInteger(value.activation) || !number(value.activation, 0, Number.MAX_SAFE_INTEGER)) return false;
  const rect = value.rect, style = value.style;
  return object(rect) && Object.keys(rect).length === 4 && ['x', 'y', 'width', 'height'].every(key => number(rect[key], 0, 16384))
    && object(style) && Object.keys(style).length === 12
    && typeof style.fontFamily === 'string' && style.fontFamily.length <= 512 && !/[\r\n\0]/u.test(style.fontFamily)
    && number(style.fontSize, 1, 512) && number(style.lineHeight, 1, 1024) && number(style.letterSpacing, -128, 512)
    && typeof style.fontWeight === 'string' && /^(normal|bold|[1-9][0-9]{0,2}|1000)$/u.test(style.fontWeight)
    && typeof style.fontStyle === 'string' && /^(normal|italic|oblique(?: -?[0-9.]+deg)?)$/u.test(style.fontStyle)
    && ['color', 'background'].every(key => typeof style[key] === 'string' && /^rgba?\([0-9.,%\s]+\)$/u.test(style[key] as string) && (style[key] as string).length < 100)
    && ['normal', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(style.whiteSpace as string)
    && ['left', 'center', 'right', 'start', 'end', 'justify'].includes(style.textAlign as string)
    && ['ltr', 'rtl'].includes(style.direction as string) && number(style.indent, 0, 16384);
}
