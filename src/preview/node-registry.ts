import { HTML_NAMESPACE, MAX_TREE_DEPTH, MAX_TREE_NODES, orderedAttributes } from '../contracts/source-tree.ts';
import type { SourceTree, TreeNode } from '../contracts/source-tree.ts';
import type { MappingCheck, MappingEvent, MappingFailure, MappingIdentity } from '../contracts/mapping.ts';
import { sameMapping } from '../contracts/mapping.ts';

// Called only from the isolated preload. There is no page-world bridge or marker.
export function createNodeRegistry(root: Document, identity: MappingIdentity, expected: SourceTree,
  emit: (event: MappingEvent) => void) {
  let revision = 0;
  let active = true;
  let selected: string | null = null;
  const byObject = new WeakMap<Text, string>();
  const byId = new Map<string, Text>();
  const valueById = new Map<string, string>();
  const observer = new MutationObserver(() => invalidate('DOM_MUTATED'));
  const invalidate = (reason: MappingFailure): void => {
    if (!active) return;
    active = false;
    selected = null;
    observer.disconnect();
    byId.clear(); valueById.clear();
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('selectionchange', onSelectionChange);
    emit({ identity, kind: 'invalidated', revision: ++revision, reason });
  };
  const drain = (): boolean => {
    if (active && observer.takeRecords().length) invalidate('DOM_MUTATED');
    return active;
  };
  const select = (value: string | null): void => {
    if (!drain()) return;
    selected = value;
    emit({ identity, kind: 'selection', revision: ++revision, nodeId: value });
  };
  const crossesText = (): boolean => {
    const selection = root.getSelection();
    return !!selection && !selection.isCollapsed && (selection.anchorNode !== selection.focusNode
      || selection.anchorNode?.nodeType !== Node.TEXT_NODE);
  };
  const onSelectionChange = (): void => { if (selected && crossesText()) select(null); };
  const hasGeneratedContent = (text: Node): boolean => {
    for (let element = text.parentElement; element; element = element.parentElement) {
      for (const pseudo of ['::before', '::after', '::marker']) {
        const content = root.defaultView!.getComputedStyle(element, pseudo).content;
        if (content && content !== 'none' && content !== 'normal' && content !== '""') return true;
      }
    }
    return false;
  };
  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted || !drain() || event.button !== 0) return;
    if (crossesText()) { select(null); return; }
    const caret = root.caretRangeFromPoint(event.clientX, event.clientY);
    const text = caret?.startContainer;
    if (!text || text.nodeType !== Node.TEXT_NODE) { select(null); return; }
    const nodeId = byObject.get(text as Text);
    if (!nodeId || text.getRootNode() !== root || !(event.composedPath().includes(text.parentNode!))) { select(null); return; }
    // Overlapping pseudo content cannot be proven to identify the source Text.
    // Conservatively leave all text beneath that pseudo-bearing ancestor unselectable.
    if (hasGeneratedContent(text)) { select(null); return; }
    const range = root.createRange();
    range.selectNodeContents(text);
    // A caret may snap to a nearby node when clicking generated CSS text or blank space.
    if (![...range.getClientRects()].some((rect) => Number.isFinite(rect.x) && Number.isFinite(rect.y)
      && rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom)) { select(null); return; }
    select(nodeId);
  };
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  const stack: { node: Node; parent: number; depth: number }[] = [{ node: root, parent: -1, depth: 0 }];
  let position = 0;
  try {
    while (stack.length && active) {
      const { node, parent, depth } = stack.pop()!;
      const index = position++;
      if (index >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH) { invalidate('UNSUPPORTED_DOM'); break; }
      const source = expected[index];
      let actual: TreeNode;
      let children: Node[] = [...node.childNodes];
      if (node.nodeType === Node.DOCUMENT_NODE) actual = { parent, kind: 'document', mode: root.compatMode === 'BackCompat' ? 'BackCompat' : 'CSS1Compat' };
      else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) actual = { parent, kind: 'fragment' };
      else if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
        const doctype = node as DocumentType;
        actual = { parent, kind: 'doctype', name: doctype.name, publicId: doctype.publicId, systemId: doctype.systemId };
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.shadowRoot) { invalidate('UNSUPPORTED_DOM'); break; }
        actual = { parent, kind: 'element', name: element.localName, namespace: element.namespaceURI ?? '',
          attributes: orderedAttributes([...element.attributes].map((attribute) => ({ name: attribute.localName,
            namespace: attribute.namespaceURI ?? '', prefix: attribute.prefix ?? '', value: attribute.value }))),
        };
        if (element.namespaceURI === HTML_NAMESPACE && element.localName === 'template') {
          const content = (element as HTMLTemplateElement).content;
          observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });
          children = [content];
        }
      } else if (node.nodeType === Node.COMMENT_NODE) actual = { parent, kind: 'comment', value: node.nodeValue ?? '' };
      else if (node.nodeType === Node.TEXT_NODE && source?.kind === 'text') {
        actual = { parent, kind: 'text', value: node.nodeValue ?? '', nodeId: source.nodeId,
          editable: source.editable, readOnlyReason: source.readOnlyReason };
        if (source.editable) {
          if (byId.has(source.nodeId)) { invalidate('TREE_MISMATCH'); break; }
          byId.set(source.nodeId, node as Text); byObject.set(node as Text, source.nodeId); valueById.set(source.nodeId, source.value);
        }
      } else { invalidate('TREE_MISMATCH'); break; }
      if (JSON.stringify(actual) !== JSON.stringify(source)) { invalidate('TREE_MISMATCH'); break; }
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, parent: index, depth: depth + 1 });
    }
    if (active && position !== expected.length) invalidate('TREE_MISMATCH');
    if (drain()) {
      root.addEventListener('click', onClick, true);
      root.addEventListener('selectionchange', onSelectionChange);
      emit({ identity, kind: 'ready', revision: ++revision, editableCount: byId.size });
    }
  } catch { invalidate('UNSUPPORTED_DOM'); }
  return {
    check(request: MappingCheck): boolean {
      if (!drain() || crossesText() || !sameMapping(request.identity, identity) || request.revision !== revision || request.nodeId !== selected) return false;
      const node = byId.get(request.nodeId);
      return !!node && node.isConnected && node.getRootNode() === root && byObject.get(node) === request.nodeId
        && node.data === valueById.get(request.nodeId) && !hasGeneratedContent(node);
    },
    close: (): void => invalidate('CLOSED'),
  };
}
