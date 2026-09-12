import { HTML_NAMESPACE } from '../../contracts/source-tree.ts';
import type { TreeNode } from '../../contracts/source-tree.ts';
import type { SourceIndex } from './source-index.ts';

export type PresentationPanel = Readonly<{ selector: string; tree: readonly TreeNode[]; tab: string | null }>;
export type PresentationGroup = readonly PresentationPanel[];
export type PresentationPlan = Readonly<{ groups: readonly PresentationGroup[]; limited: boolean }>;

// Source-only presentation hints. These paths never select a Text or authorize
// a patch. Only explicit, uniquely identified sibling panels are considered.
export function planPresentation(source: SourceIndex): PresentationPlan {
  const { tree } = source;
  const children = new Map<number, number[]>();
  const ids = new Map<string, number>();
  const paths = new Map<number, string>();
  const attr = (index: number, name: string) => {
    const node = tree[index];
    return node?.kind === 'element' ? node.attributes.find(value => !value.namespace && value.name === name)?.value : undefined;
  };
  const ends = tree.map((_, index) => index + 1);
  const hasText = tree.map(node => node.kind === 'text' && node.editable && !!node.value.trim());
  for (let i = tree.length - 1; i > 0; --i) {
    const parent = tree[i]!.parent;
    if (parent >= 0) { ends[parent] = Math.max(ends[parent]!, ends[i]!); hasText[parent] ||= hasText[i]!; }
  }
  for (let index = 0; index < tree.length; ++index) {
    const node = tree[index]!;
    if (node.kind !== 'element') continue;
    const siblings = children.get(node.parent) ?? [];
    siblings.push(index); children.set(node.parent, siblings);
    paths.set(index, node.parent === 0 ? `:root:nth-child(${siblings.length})`
      : `${paths.get(node.parent) ?? ''} > :nth-child(${siblings.length})`);
    const id = attr(index, 'id');
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const supported = (index: number): boolean => {
    const node = tree[index]!;
    return node.kind === 'element' && node.namespace === HTML_NAMESPACE && !!attr(index, 'id')
      && ids.get(attr(index, 'id')!) === 1
      && ['pre', 'div', 'section', 'article', 'aside', 'main', 'p'].includes(node.name) && hasText[index] === true;
  };
  const groups: PresentationGroup[] = [];
  let count = 0, nodes = 0, length = 0;
  const exceeded = () => Object.freeze({ groups: Object.freeze([]), limited: true });
  for (const siblings of children.values()) {
    // Consecutive same-tag panels; unrelated siblings break a group.
    for (let start = 0; start < siblings.length;) {
      const first = siblings[start]!;
      const node = tree[first]!;
      let end = start + 1;
      if (supported(first) && node.kind === 'element') {
        while (end < siblings.length && supported(siblings[end]!)
          && tree[siblings[end]!]!.kind === 'element' && (tree[siblings[end]!] as { name: string }).name === node.name) ++end;
      }
      const indices = siblings.slice(start, end);
      // Visibility is proved against the complete live subtrees later. No
      // particular class name, inline style or ARIA convention is required.
      if (indices.length >= 2) {
        const prior = start > 0 ? siblings[start - 1] : undefined;
        const tabs = prior !== undefined && attr(prior, 'role') === 'tablist' ? children.get(prior) ?? [] : [];
        count += indices.length; nodes += indices.reduce((total, index) => total + ends[index]! - index, 0);
        if (count > 100 || nodes > 5000) return exceeded();
        groups.push(Object.freeze(indices.map(index => {
          const id = attr(index, 'id')!;
          // aria-controls is preferred. data-tab + an exact hyphen suffix is a
          // bounded presentation convention, never source-mapping authority.
          const candidates = tabs.filter(tab => attr(tab, 'role') === 'tab' && (attr(tab, 'aria-controls') === id
            || (!!attr(tab, 'data-tab') && id.endsWith('-' + attr(tab, 'data-tab')))));
          const relative = tree.slice(index, ends[index]).map((item, offset) => Object.freeze({ ...item, parent: offset ? item.parent - index : -1 }));
          return Object.freeze({ selector: paths.get(index)!, tree: Object.freeze(relative),
            tab: candidates.length === 1 ? paths.get(candidates[0]!)! : null });
        })));
        length += JSON.stringify(groups[groups.length - 1]).length;
        if (length > 256 * 1024) return exceeded();
      }
      start = end;
    }
  }
  return Object.freeze({ groups: Object.freeze(groups), limited: false });
}
