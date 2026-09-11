import { HTML_NAMESPACE } from '../../contracts/source-tree.ts';
import type { SourceIndex } from './source-index.ts';

export type HiddenContentPlan = Readonly<{ count: number; limited: boolean; css: string; selectors: readonly string[] }>;
const MAX_TARGETS = 200;
const MAX_CSS_LENGTH = 256 * 1024;
const display = new Map([
  ['table', 'table'], ['thead', 'table-header-group'], ['tbody', 'table-row-group'],
  ['tfoot', 'table-footer-group'], ['tr', 'table-row'], ['td', 'table-cell'],
  ['th', 'table-cell'], ['caption', 'table-caption'], ['li', 'list-item'],
]);

// This plan changes screen presentation only. Numeric selectors are derived
// from Main's verified source tree; they never locate or authorize a text patch.
// Restrict the first slice to explicit hidden attributes with editable content.
export function planHiddenContent(source: SourceIndex): HiddenContentPlan {
  const tree = source.tree;
  const content = new Uint8Array(tree.length);
  const positions = new Uint32Array(tree.length);
  const siblings = new Map<number, number>();
  for (let index = 0; index < tree.length; index++) {
    const node = tree[index]!;
    if (node.kind === 'text' && node.editable && (node.value.trim() || (source.lineage && node.value === ''))) content[index] = 1;
    if (node.kind === 'element') {
      const position = (siblings.get(node.parent) ?? 0) + 1;
      siblings.set(node.parent, position); positions[index] = position;
    }
  }
  for (let index = tree.length - 1; index > 0; index--) {
    if (content[index] && tree[index]!.parent >= 0) content[tree[index]!.parent] = 1;
  }
  const targets = tree.flatMap((node, index) => node.kind === 'element' && node.namespace === HTML_NAMESPACE
    && content[index] && node.attributes.some(attribute => attribute.name === 'hidden' && !attribute.namespace) ? [index] : []);
  const limited = () => Object.freeze({ count: targets.length, limited: true, css: '', selectors: Object.freeze([]) });
  if (targets.length > MAX_TARGETS) return limited();
  const rules: string[] = [];
  const selectors: string[] = [];
  let length = 0;
  for (const target of targets) {
    const path: string[] = [];
    for (let index = target; index >= 0; index = tree[index]!.parent) {
      const node = tree[index]!;
      if (node.kind === 'element') path.push(`:nth-child(${positions[index]})`);
      else if (node.kind !== 'document') return limited();
    }
    const node = tree[target]!;
    const selector = `:root${path.reverse().join(' > ')}`;
    const rule = `${selector}{display:${node.kind === 'element' ? display.get(node.name) ?? 'block' : 'block'}!important;visibility:visible!important;content-visibility:visible!important;}`;
    length += rule.length;
    if (length > MAX_CSS_LENGTH) return limited();
    rules.push(rule); selectors.push(selector);
  }
  // printToPDF uses this same native Preview; expansion must not change print.
  return Object.freeze({ count: targets.length, limited: false, css: rules.length ? `@media screen{${rules.join('')}}` : '', selectors: Object.freeze(selectors) });
}
