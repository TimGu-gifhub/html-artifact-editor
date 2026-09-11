import type { MappingIdentity } from '../contracts/mapping.ts';
import type { TextGeometry, TextShape } from '../contracts/text-geometry.ts';
import { isInlineTextGeometry } from '../contracts/inline-text.ts';
import type { InlineTextGeometry } from '../contracts/inline-text.ts';

// Range rectangles use the existing object proof. No DOM markers or page API.
export function createTextGeometry(root: Document, identity: MappingIdentity,
  current: () => { active: boolean; revision: number; selected: string | null },
  hit: (event: MouseEvent) => string | null, resolve: (id: string) => Text | undefined,
  emit: (value: TextGeometry) => void) {
  const view = root.defaultView!;
  let hover: string | null = null, queued = 0, sequence = 0, closed = false;
  let refresh = 0, previous = '';
  type ClickTarget = { id: string; caret: number; activation: number };
  let activation = 0, clicked: ClickTarget | null = null;
  let activated: ClickTarget | null = null;
  const inline = (selected: TextShape | null): InlineTextGeometry | null => {
    const node = selected ? resolve(selected.nodeId) : undefined;
    if (!selected || !node?.parentElement) return null;
    if (clicked?.id === selected.nodeId) activated = clicked;
    const range = root.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length || rects.length > 80) return null;
    const style = view.getComputedStyle(node.parentElement);
    // Solid backgrounds can be reproduced in the trusted input surface. A
    // bitmap/gradient, writing-mode or transformed range needs the full panel.
    if (style.writingMode !== 'horizontal-tb' || style.textTransform !== 'none' || style.textShadow !== 'none') return null;
    let background = 'rgb(255, 255, 255)';
    for (let element: Element | null = node.parentElement; element; element = element.parentElement) {
      const parentStyle = view.getComputedStyle(element);
      if (parentStyle.backgroundImage !== 'none') return null;
      const color = parentStyle.backgroundColor;
      if (color.startsWith('rgb(')) { background = color; break; }
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return null;
    }
    const first = rects[0]!, fontSize = Number.parseFloat(style.fontSize);
    const lineHeight = style.lineHeight === 'normal' ? Math.max(first.height, fontSize * 1.2) : Number.parseFloat(style.lineHeight);
    const left = Math.min(...rects.map(rect => rect.left)), right = Math.max(...rects.map(rect => rect.right));
    const top = first.top - Math.max(0, lineHeight - first.height) / 2;
    const bottom = Math.max(...rects.map(rect => rect.bottom)) + Math.max(0, lineHeight - first.height) / 2;
    // Do not place an editor over a clipped or offscreen Text fragment.
    if (left < 0 || top < 0 || right > view.innerWidth || bottom > view.innerHeight || selected.rects.length !== rects.length
      || selected.rects.some((rect, i) => Math.abs(rect.width - rects[i]!.width) > 1 || Math.abs(rect.height - rects[i]!.height) > 1)) return null;
    const value: InlineTextGeometry = { nodeId: selected.nodeId,
      rect: { x: left, y: top, width: Math.max(2, right - left), height: Math.max(lineHeight, bottom - top) },
      style: { fontFamily: style.fontFamily, fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
        lineHeight, letterSpacing: style.letterSpacing === 'normal' ? 0 : Number.parseFloat(style.letterSpacing),
        color: style.color, background, whiteSpace: style.whiteSpace as InlineTextGeometry['style']['whiteSpace'],
        textAlign: style.textAlign as InlineTextGeometry['style']['textAlign'], direction: style.direction as 'ltr' | 'rtl', indent: first.left - left },
      caret: activated?.id === selected.nodeId ? Math.min(activated.caret, node.length) : 0,
      activation: activated?.id === selected.nodeId ? activated.activation : 0 };
    return isInlineTextGeometry(value) ? value : null;
  };
  const shape = (id: string | null): TextShape | null => {
    const node = id ? resolve(id) : undefined;
    if (!id || !node || !node.isConnected || node.getRootNode() !== root) return null;
    if (!node.parentElement?.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) return null;
    let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
    for (let element: Element | null = node.parentElement; element; element = element.parentElement) {
      const style = view.getComputedStyle(element);
      // Rectangular clipping is provable. Complex masks and transforms are not
      // advertised with a misleading outline; the normal editor still works.
      if (style.transform !== 'none' || style.clipPath !== 'none' || style.maskImage !== 'none') return null;
      const bounds = element.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left + element.clientLeft); right = Math.min(right, bounds.left + element.clientLeft + element.clientWidth); }
      if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top + element.clientTop); bottom = Math.min(bottom, bounds.top + element.clientTop + element.clientHeight); }
    }
    const range = root.createRange(); range.selectNodeContents(node);
    const rectangles = [...range.getClientRects()];
    if (rectangles.length > 80) return null;
    const rects = rectangles.flatMap(rect => {
      const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
      const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
      return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? [{ x, y, width, height }] : [];
    });
    return rects.length ? { nodeId: id, rects } : null;
  };
  const schedule = () => {
    if (closed || queued) return;
    view.clearTimeout(refresh); refresh = 0;
    // Coalesce independently of animation frames, which can pause while a
    // native view is hidden. Main still rejects painting a hidden/mismatched
    // viewport; no page scripts or page-world listeners are enabled here.
    queued = view.setTimeout(() => {
      queued = 0; const state = current();
      if (closed || !state.active) return;
      const selected = shape(state.selected);
      const value = { identity, revision: state.revision, sequence: 0, width: view.innerWidth, height: view.innerHeight,
        hover: shape(hover), selected, inline: inline(selected) };
      const key = JSON.stringify(value);
      if (key !== previous) { previous = key; emit({ ...value, sequence: ++sequence }); }
      // Track only at most two known Text ranges through font/layout changes;
      // this is not a full-page scan or MutationObserver exemption.
      if (state.selected || hover) refresh = view.setTimeout(schedule, 100);
    }, 16);
  };
  const move = (event: MouseEvent) => { if (event.isTrusted) { hover = hit(event); schedule(); } };
  const leave = () => { hover = null; schedule(); };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const id = hit(event);
    const range = root.caretRangeFromPoint(event.clientX, event.clientY);
    clicked = id ? { id, caret: range && range.startContainer === resolve(id) ? range.startOffset : 0, activation: ++activation } : null;
    schedule();
  };
  root.addEventListener('click', click, true);
  root.addEventListener('mousemove', move, true); root.addEventListener('mouseleave', leave);
  root.addEventListener('scroll', leave, true); view.addEventListener('resize', leave);
  view.visualViewport?.addEventListener('resize', leave);
  return { schedule, close() {
    closed = true; view.clearTimeout(queued); view.clearTimeout(refresh);
    root.removeEventListener('click', click, true);
    root.removeEventListener('mousemove', move, true); root.removeEventListener('mouseleave', leave);
    root.removeEventListener('scroll', leave, true); view.removeEventListener('resize', leave);
    view.visualViewport?.removeEventListener('resize', leave);
  } };
}
