// Main constructs this descriptor from a byte snapshot. It is never accepted from a page.
export const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_TREE_NODES = 100_000;
export const MAX_TREE_DEPTH = 256;
export type TreeAttribute = Readonly<{ name: string; namespace: string; prefix: string; value: string }>;
export type TreeNode = Readonly<{ parent: number }> & (
  | Readonly<{ kind: 'document'; mode: 'CSS1Compat' | 'BackCompat' }>
  | Readonly<{ kind: 'fragment' }>
  | Readonly<{ kind: 'doctype'; name: string; publicId: string; systemId: string }>
  | Readonly<{ kind: 'element'; name: string; namespace: string; attributes: readonly TreeAttribute[] }>
  | Readonly<{ kind: 'comment'; value: string }>
  | Readonly<{ kind: 'text'; value: string; nodeId: string; editable: boolean; readOnlyReason: string | null }>
);
export type SourceTree = readonly TreeNode[];

export function orderedAttributes(attributes: readonly TreeAttribute[]): TreeAttribute[] {
  return [...attributes].sort((a, b) => {
    const left = `${a.namespace}\0${a.name}\0${a.prefix}`;
    const right = `${b.namespace}\0${b.name}\0${b.prefix}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
