import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes as P5 } from 'parse5';
import { HTML_NAMESPACE, MAX_SOURCE_BYTES, MAX_TREE_DEPTH, MAX_TREE_NODES, orderedAttributes } from '../../contracts/source-tree.ts';
import type { SourceTree, TreeNode } from '../../contracts/source-tree.ts';
import { byteBoundary, decodeUtf8, encodeUtf8 } from './utf8.ts';

export type SourceIdentity = Readonly<{ projectId: string; documentId: string; generation: number }>;
// Main/private history only. Logical values refer to Texts in originBytes, never
// to executable locations. Rebuilding this proof must reparse the current bytes.
export type SourceLineage = Readonly<{
  originBytes: Uint8Array; values: readonly Readonly<{ nodeId: string; text: string }>[];
}>;
export type TextSource = Readonly<{
  nodeId: string; treeIndex: number; startCodeUnit: number; endCodeUnit: number;
  startByte: number; endByte: number; rawSliceHash: string; decodedText: string;
  contextFingerprint: string; parentTag: string; namespace: string;
  consumesLeadingLf: boolean;
  editable: boolean; readOnlyReason: string | null;
}>;
export type SourceIndex = Readonly<{
  schemaVersion: 1; identity: SourceIdentity; baseHash: string; hasBom: boolean;
  bytes: Uint8Array; text: string; tree: SourceTree; nodes: readonly TextSource[];
  parseErrors: readonly string[];
  lineage?: SourceLineage;
}>;
export type HashBytes = (bytes: Uint8Array) => string;
const restricted = new Set(['script', 'style', 'noscript', 'title', 'textarea', 'xmp', 'plaintext',
  'iframe', 'noembed', 'noframes', 'template', 'form', 'input', 'select', 'option', 'optgroup',
  'button', 'output', 'canvas', 'object', 'embed', 'audio', 'video']);
const isElement = (node: P5.Node): node is P5.Element => 'tagName' in node;

export function createSourceIndex(input: Uint8Array, identity: SourceIdentity, hash: HashBytes): SourceIndex {
  if (input.length > MAX_SOURCE_BYTES) throw new Error('SOURCE_SIZE_LIMIT');
  if (!identity || !['projectId', 'documentId'].every((key) => {
    const value = identity[key as 'projectId' | 'documentId'];
    return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  }) || !Number.isSafeInteger(identity.generation) || identity.generation <= 0) throw new Error('INVALID_SOURCE_IDENTITY');
  const bytes = new Uint8Array(input); // Buffer.slice() would alias its caller's storage.
  const decoded = decodeUtf8(bytes);
  const errors = new Set<string>();
  const treeRoot = parse(decoded.text, { sourceCodeLocationInfo: true, scriptingEnabled: true,
    onParseError: (error) => { if (error.code !== 'missing-doctype' && errors.size < 32) errors.add(error.code); },
  });
  const tree: TreeNode[] = [];
  const nodes: TextSource[] = [];
  const stack: { node: P5.Node; parent: number; depth: number; reason: string | null }[] = [
    { node: treeRoot, parent: -1, depth: 0, reason: null },
  ];
  const elementStarts = new Set<number>();
  let repairedElements = false;
  while (stack.length) {
    const { node, parent, depth, reason } = stack.pop()!;
    if (depth > MAX_TREE_DEPTH || tree.length >= MAX_TREE_NODES) throw new Error('SOURCE_TREE_LIMIT');
    const treeIndex = tree.length;
    let inherited = reason;
    let descriptor: TreeNode;
    if (isElement(node)) {
      if (node.namespaceURI !== HTML_NAMESPACE) inherited = 'FOREIGN_CONTENT';
      else if (restricted.has(node.tagName) || node.attrs.some((attribute) => attribute.name === 'contenteditable')) {
        inherited ??= 'UNSUPPORTED_CONTEXT';
      }
      const location = node.sourceCodeLocation;
      if (location) {
        // The adoption agency algorithm can clone formatting elements without a parse error.
        if (elementStarts.has(location.startOffset)) repairedElements = true;
        elementStarts.add(location.startOffset);
      }
      descriptor = { parent, kind: 'element', name: node.tagName, namespace: node.namespaceURI,
        attributes: orderedAttributes(node.attrs.map((attribute) => ({ name: attribute.name,
          namespace: attribute.namespace ?? '', prefix: attribute.prefix ?? '', value: attribute.value }))),
      };
    } else if (node.nodeName === '#text') {
      const value = (node as P5.TextNode).value;
      const location = node.sourceCodeLocation;
      const parentElement = (node as P5.TextNode).parentNode;
      const consumesLeadingLf = parentElement !== null && isElement(parentElement) && ['pre', 'listing'].includes(parentElement.tagName)
        && parentElement.childNodes[0] === node
        && location?.startOffset === parentElement.sourceCodeLocation?.startTag?.endOffset;
      let readOnlyReason = inherited ?? (errors.size ? 'PARSE_ERROR' : null);
      let startByte = -1;
      let endByte = -1;
      const startCodeUnit = location?.startOffset ?? -1;
      const endCodeUnit = location?.endOffset ?? -1;
      if (!location || startCodeUnit >= endCodeUnit) readOnlyReason ??= 'MISSING_SOURCE_RANGE';
      else {
        try {
          startByte = byteBoundary(decoded, startCodeUnit);
          endByte = byteBoundary(decoded, endCodeUnit);
          if (!readOnlyReason) {
            const fragment = parseFragment(decoded.text.slice(startCodeUnit, endCodeUnit), { scriptingEnabled: true });
            const single = fragment.childNodes[0];
            let fragmentText = single?.nodeName === '#text' ? (single as P5.TextNode).value : null;
            // parse5 may include the consumed first LF in a multi-LF token's source span.
            if (consumesLeadingLf && fragmentText?.startsWith('\n')) fragmentText = fragmentText.slice(1);
            if (fragment.childNodes.length !== 1 || single?.nodeName !== '#text'
              || fragmentText !== value) readOnlyReason = 'NONCONTIGUOUS_TEXT';
          }
        } catch { readOnlyReason ??= 'INVALID_SOURCE_RANGE'; }
      }
      const parentNode = tree[parent];
      const nodeId = `n${treeIndex}`;
      nodes.push({ nodeId, treeIndex, startCodeUnit, endCodeUnit, startByte, endByte,
        rawSliceHash: startByte >= 0 ? hash(bytes.slice(startByte, endByte)) : '', decodedText: value,
        contextFingerprint: hash(encodeUtf8(JSON.stringify({ parent, parentNode, treeIndex, value, consumesLeadingLf }))),
        parentTag: parentNode?.kind === 'element' ? parentNode.name : '',
        namespace: parentNode?.kind === 'element' ? parentNode.namespace : '',
        consumesLeadingLf,
        editable: readOnlyReason === null, readOnlyReason,
      });
      descriptor = { parent, kind: 'text', value, nodeId, editable: readOnlyReason === null, readOnlyReason };
    } else if (node.nodeName === '#comment') {
      descriptor = { parent, kind: 'comment', value: (node as P5.CommentNode).data };
    } else if (node.nodeName === '#documentType') {
      const doctype = node as P5.DocumentType;
      descriptor = { parent, kind: 'doctype', name: doctype.name, publicId: doctype.publicId, systemId: doctype.systemId };
    } else if (node.nodeName === '#document') {
      descriptor = { parent, kind: 'document', mode: treeRoot.mode === 'quirks' ? 'BackCompat' : 'CSS1Compat' };
    } else descriptor = { parent, kind: 'fragment' };
    tree.push(descriptor);
    const children: P5.Node[] = isElement(node) && node.tagName === 'template' && 'content' in node
      ? [(node as P5.Template).content] : 'childNodes' in node ? node.childNodes : [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parent: treeIndex, depth: depth + 1, reason: inherited });
    }
  }
  // Mark both sides of any overlap, including read-only ranges. Never choose one winner.
  const overlap = new Set<string>();
  const ordered = nodes.filter((node) => node.startByte >= 0).sort((a, b) => a.startByte - b.startByte);
  let farthest: TextSource | undefined;
  for (const node of ordered) {
    if (farthest && node.startByte < farthest.endByte) { overlap.add(farthest.nodeId); overlap.add(node.nodeId); }
    if (!farthest || node.endByte > farthest.endByte) farthest = node;
  }
  const finalNodes = nodes.map((node): TextSource => {
    const readOnlyReason = repairedElements ? 'REPAIRED_TREE' : overlap.has(node.nodeId) ? 'OVERLAPPING_SOURCE' : node.readOnlyReason;
    const finalNode = Object.freeze({ ...node, editable: readOnlyReason === null, readOnlyReason });
    const old = tree[node.treeIndex]!;
    if (old.kind === 'text') tree[node.treeIndex] = { ...old, editable: finalNode.editable, readOnlyReason };
    return finalNode;
  });
  // No mutable parse5 objects or offset arrays cross this boundary.
  for (const item of tree) {
    if (item.kind === 'element') { item.attributes.forEach(Object.freeze); Object.freeze(item.attributes); }
    Object.freeze(item);
  }
  return Object.freeze({ schemaVersion: 1, identity: Object.freeze({ ...identity }), baseHash: hash(bytes),
    hasBom: decoded.hasBom, get bytes() { return new Uint8Array(bytes); }, text: decoded.text, tree: Object.freeze(tree), nodes: Object.freeze(finalNodes),
    parseErrors: Object.freeze([...errors]),
  });
}
