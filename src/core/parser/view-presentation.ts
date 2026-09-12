import { HTML_NAMESPACE } from '../../contracts/source-tree.ts';
import type { SourceTree } from '../../contracts/source-tree.ts';

export type ViewTarget = Readonly<{ index: number; selector: string; details: boolean }>;
export type ViewPlan = Readonly<{ tree: SourceTree; targets: readonly ViewTarget[] }>;
// One bounded observation at a document transition, never a live DOM watcher.
export function planViewPresentation(tree: SourceTree): ViewPlan | null {
  if (tree.length > 5000 || tree.some(node => node.kind === 'fragment'
    || (node.kind === 'element' && node.name === 'template'))) return null;
  const paths = new Map<number, string>(), counts = new Map<number, number>();
  const targets: ViewTarget[] = [];
  for (let index = 0; index < tree.length; ++index) {
    const node = tree[index]!;
    if (node.kind !== 'element') continue;
    const position = (counts.get(node.parent) ?? 0) + 1; counts.set(node.parent, position);
    const selector = node.parent === 0 ? `:root:nth-child(${position})`
      : `${paths.get(node.parent) ?? ''} > :nth-child(${position})`;
    paths.set(index, selector);
    if (node.namespace === HTML_NAMESPACE && !['head', 'script', 'style', 'link', 'meta', 'base', 'title',
      'template', 'iframe', 'object', 'embed'].includes(node.name)) targets.push({ index, selector, details: node.name === 'details' });
  }
  if (targets.length > 1200) return null;
  const plan = { tree, targets };
  return JSON.stringify(plan).length <= 768 * 1024 ? plan : null;
}

export const viewProperties = ['display', 'visibility', 'content-visibility', 'opacity', 'transform', 'filter'] as const;
export type ViewAppearance = Readonly<{ values: readonly string[]; details: boolean | null; before: string; after: string }>;
const displays = new Set(['none', 'contents', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid',
  'flow-root', 'table', 'inline-table', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-row', 'table-cell',
  'table-column-group', 'table-column', 'table-caption', 'list-item', 'ruby', 'ruby-base', 'ruby-text', 'ruby-base-container', 'ruby-text-container']);
const transform = (value: unknown): boolean => {
  if (value === 'none') return true;
  if (typeof value !== 'string') return false;
  const match = /^(matrix|matrix3d)\(([-\d.e+ ,]+)\)$/u.exec(value);
  if (!match) return false;
  const parts = match[2]!.split(',').map(value => value.trim());
  if (parts.some(value => !value)) return false;
  const numbers = parts.map(value => Number(value));
  return numbers.length === (match[1] === 'matrix' ? 6 : 16) && numbers.every(n => Number.isFinite(n) && Math.abs(n) <= 100000);
};
export function isViewAppearance(value: unknown): value is ViewAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as ViewAppearance;
  if (Object.keys(data).length !== 4 || !Array.isArray(data.values) || data.values.length !== viewProperties.length
    || data.values.some(v => typeof v !== 'string' || v.length > 300)
    || (data.details !== null && typeof data.details !== 'boolean') || !transform(data.before) || !transform(data.after)) return false;
  const [display, visibility, content, opacity, motion, filter] = data.values;
  return displays.has(display!) && ['visible', 'hidden', 'collapse'].includes(visibility!)
    && ['visible', 'hidden', 'auto'].includes(content!) && /^(0(?:\.\d+)?|1(?:\.0+)?)$/u.test(opacity!)
    && transform(motion) && (filter === 'none' || /^blur\((?:\d{1,2}(?:\.\d+)?|100)px\)$/u.test(filter!));
}

export function viewAppearanceCss(selector: string, value: ViewAppearance): string {
  if (!/^:root:nth-child\(\d+\)(?: > :nth-child\(\d+\))*$/u.test(selector) || !isViewAppearance(value)) throw new Error('PRESENTATION_UNAVAILABLE');
  let css = `${selector}{${viewProperties.map((key, i) => `${key}:${value.values[i]}!important;`).join('')}transition:none!important;animation:none!important;}`;
  for (const pseudo of ['before', 'after'] as const) css += `${selector}::${pseudo}{transform:${value[pseudo]}!important;transition:none!important;animation:none!important;}`;
  if (value.details !== null) css += `${selector}::details-content{content-visibility:${value.details ? 'visible' : 'hidden'}!important;display:block!important;}`;
  return css;
}
