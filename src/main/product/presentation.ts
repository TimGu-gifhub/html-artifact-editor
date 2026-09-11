import { randomUUID } from 'node:crypto';
import type { Rectangle } from 'electron';
import type { OpenDocument, ProofreadDocument } from '../workspace/document.ts';
import { planPresentation } from '../../core/parser/presentation.ts';
import type { PresentationState } from '../../contracts/desktop.ts';
import { tabPresentationCss } from './presentation-style.ts';
import { captureViewPresentation, verifyViewCode } from './view-presentation.ts';

type Observation = { x: number; y: number; height: number; groups: ({ active: number; top: number; display?: string } | null)[] };
const displays = ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'flow-root', 'table', 'table-row', 'table-cell', 'list-item'];
// Runs in an isolated world with no page API. It reads bounded, source-derived
// subtrees. Only a panel's root hidden attribute may differ from the source.
const observeCode = String.raw`(plan) => {
  const match = (element, panel) => {
    const stack = [{ node: element, parent: -1 }]; let index = 0;
    while (stack.length) {
      const { node, parent } = stack.pop();
      const offset = index++; const source = panel.tree[offset];
      if (!source || source.parent !== parent) return false;
      if (node.nodeType === Node.ELEMENT_NODE && source.kind === 'element') {
        const e = node;
        if (e.shadowRoot || e.localName !== source.name || e.namespaceURI !== source.namespace) return false;
        const presentation = ['hidden', 'class', 'style', 'aria-hidden'];
        if (e.attributes.length > source.attributes.length + presentation.length) return false;
        const actual = [...e.attributes].filter(a => offset !== 0 || !presentation.includes(a.name) || a.namespaceURI);
        const expected = source.attributes.filter(a => offset !== 0 || !presentation.includes(a.name) || a.namespace);
        if (actual.length !== expected.length || expected.some(a => e.getAttributeNS(a.namespace || null, a.name) !== a.value)) return false;
      } else if ((node.nodeType === Node.TEXT_NODE && source.kind === 'text') || (node.nodeType === Node.COMMENT_NODE && source.kind === 'comment')) {
        if (node.nodeValue !== source.value) return false;
      } else return false;
      if (node.childNodes.length > panel.tree.length - index) return false;
      const children = [...node.childNodes];
      for (let i = children.length - 1; i >= 0; --i) stack.push({ node: children[i], parent: offset });
    }
    return index === panel.tree.length;
  };
  return { x: scrollX, y: scrollY, height: innerHeight, groups: plan.groups.map(group => {
    const panels = group.map(panel => document.querySelector(panel.selector));
    if (panels.some((panel, i) => !panel || !match(panel, group[i]))) return null;
    const visible = panels.map(panel => panel.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }));
    const active = visible.indexOf(true);
    if (active < 0 || visible.filter(Boolean).length !== 1) return null;
    return { active, top: panels[active].getBoundingClientRect().top, display: getComputedStyle(panels[active]).display };
  }) };
}`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
async function read<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PRESENTATION_UNAVAILABLE')), 5000);
  })]); } finally { clearTimeout(timer); }
}
export function createPresentationController(viewport?: () => Rectangle) {
  const states = new WeakMap<OpenDocument, PresentationState>();
  const styles = new WeakMap<OpenDocument, { key: string; marker: string }>();
  const reset = async (document: OpenDocument): Promise<void> => {
    const style = styles.get(document);
    if (!style) return;
    states.delete(document);
    await document.preview.contents.removeInsertedCSS(style.key);
    const present: unknown = await read(document.preview.contents.executeJavaScriptInIsolatedWorld(1004, [{ code:
      `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(style.marker)}).trim()==='active'` }]));
    if (present !== false) throw new Error('PRESENTATION_UNAVAILABLE');
    styles.delete(document);
  };
  const transfer = async (previous: OpenDocument, next: OpenDocument, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const bounds = previous.preview.view.getBounds();
      // A menu can momentarily hide the native view while keeping its measured
      // layout. Use only Main's already accepted viewport, never page geometry.
      const target = bounds.width > 0 && bounds.height > 0 ? bounds : viewport?.();
      if (!target || target.width <= 0 || target.height <= 0) throw new Error('PRESENTATION_UNAVAILABLE');
      previous.preview.view.setBounds?.(target);
      next.preview.view.setBounds(target);
      // A fresh static page has not run its reveal scripts. Do not seed that
      // initially hidden state over the first interactive render.
      const frozenView = next.mode === 'proofread' || (states.get(previous)?.elements ?? 0) > 0
        ? await captureViewPresentation(previous, next, read, signal) : null;
      let plan = next.mode === 'proofread' ? planPresentation(next.mapping.source)
        : previous.mode === 'proofread' ? planPresentation(previous.mapping.source) : { groups: [], limited: false };
      if (next.mode === 'interactive' && previous.mode === 'proofread') {
        const changes = new Map(previous.input.snapshot().changes.map(change => [change.nodeId, change.newText]));
        plan = { ...plan, groups: plan.groups.map(group => group.map(panel => ({ ...panel,
          tree: panel.tree.map(node => node.kind === 'text' && changes.has(node.nodeId) ? { ...node, value: changes.get(node.nodeId)! } : node) }))) };
      }
      const raw: unknown = await read(previous.preview.contents.executeJavaScriptInIsolatedWorld(1004,
        [{ code: `(${observeCode})(${JSON.stringify(plan)})` }]));
      signal.throwIfAborted();
      if (!raw || typeof raw !== 'object') throw new Error('PRESENTATION_UNAVAILABLE');
      const observed = raw as Observation;
      if (!finite(observed.x) || !finite(observed.y) || !finite(observed.height) || !Array.isArray(observed.groups)
        || observed.groups.length !== plan.groups.length || observed.groups.some((group, i) => group !== null
          && (!Number.isSafeInteger(group.active) || group.active < 0 || group.active >= plan.groups[i]!.length || !finite(group.top)
            || (group.display !== undefined && !displays.includes(group.display))))) throw new Error('PRESENTATION_UNAVAILABLE');
      const accepted = observed.groups.flatMap((value, index) => value ? [{ ...value, group: plan.groups[index]! }] : []);
      const rules = accepted.flatMap(({ group, active, display }) => group.map((panel, index) =>
        `${panel.selector}{display:${index === active ? display ?? 'block' : 'none'}!important;${index === active ? 'visibility:visible!important;content-visibility:visible!important;' : ''}}`));
      rules.push(...accepted.map(({ group, active }) => tabPresentationCss(group.map(panel => panel.tab), active)).filter(Boolean));
      rules.push(...frozenView?.rules ?? []);
      const marker = '--hae-presentation-' + randomUUID();
      const contents = next.preview.contents;
      if (rules.length) {
        const key = await contents.insertCSS(`@media screen{${rules.join('')}:root{${marker}:active!important}}`, { cssOrigin: 'author' });
        styles.set(next, { key, marker });
        signal.throwIfAborted();
        const visible: unknown = await read(contents.executeJavaScriptInIsolatedWorld(1004, [{ code: `(() => {
          const groups=${JSON.stringify(accepted.map(({ group, active }) => ({ selectors: group.map(panel => panel.selector), active })))};
          return getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(marker)}).trim()==='active'
            && groups.every(group=>group.selectors.every((selector,i)=>document.querySelector(selector)?.checkVisibility({visibilityProperty:true,opacityProperty:true,contentVisibilityAuto:true})===(i===group.active)));
        })()` }]));
        if (visible !== true) throw new Error('PRESENTATION_UNAVAILABLE');
        if (frozenView && await read(contents.executeJavaScriptInIsolatedWorld(1005,
          [{ code: verifyViewCode(frozenView) }])) !== true) throw new Error('PRESENTATION_UNAVAILABLE');
      }
      const anchor = accepted.filter(value => value.top < observed.height && value.top > -observed.height)
        .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0];
      const position: unknown = await read(contents.executeJavaScriptInIsolatedWorld(1004, [{ code: `(() => {
        const selector=${JSON.stringify(anchor?.group[anchor.active]?.selector ?? null)};
        const e=selector?document.querySelector(selector):null;
        const target=e?scrollY+e.getBoundingClientRect().top-${JSON.stringify(anchor?.top ?? 0)}:${observed.y};
        scrollTo({left:${observed.x},top:target,behavior:'instant'});
        return {x:scrollX,y:scrollY};
      })()` }]));
      signal.throwIfAborted();
      if (!position || typeof position !== 'object' || !finite((position as { x: unknown }).x) || !finite((position as { y: unknown }).y)) throw new Error('PRESENTATION_UNAVAILABLE');
      states.set(next, { documentId: next.id, panels: accepted.length,
        ...(frozenView ? { elements: frozenView.elements, details: frozenView.details } : {}),
        status: frozenView ? frozenView.partial ? 'partial' : 'restored'
          : plan.limited || observed.groups.some(group => group === null) ? 'partial' : 'restored' });
  };
  return Object.freeze({
    snapshot(document: OpenDocument | null): PresentationState | undefined { return document ? states.get(document) : undefined; },
    async transfer(previous: OpenDocument, next: OpenDocument, signal: AbortSignal) {
      try { await transfer(previous, next, signal); }
      catch (error) { states.set(next, { documentId: next.id, panels: 0, status: 'partial' }); throw error; }
    },
    reset: (document: ProofreadDocument) => reset(document),
    releaseInteractive: async (document: OpenDocument) => { if (document.mode === 'interactive') await reset(document); },
  });
}
