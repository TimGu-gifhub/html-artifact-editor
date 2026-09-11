import { HTML_NAMESPACE, MAX_TREE_DEPTH, MAX_TREE_NODES, orderedAttributes } from '../contracts/source-tree.ts';
import type { SourceTree, TreeNode } from '../contracts/source-tree.ts';
import type { MappingApply, MappingApplyResult, MappingCheck, MappingEvent, MappingFailure, MappingIdentity } from '../contracts/mapping.ts';
import { isMappingInstall, sameMapping } from '../contracts/mapping.ts';
import type { MappingEditIntent, MappingEditRequest, MappingEditResult } from '../contracts/edit-guard.ts';
import type { MappingRestore, MappingRestoreResult } from '../contracts/mapping-restore.ts';
import { isMappingRestore } from '../contracts/mapping-restore.ts';
import { isMappingHistory } from '../contracts/mapping-history.ts';
import type { MappingHistory, MappingHistoryResult } from '../contracts/mapping-history.ts';
import type { TextGeometry } from '../contracts/text-geometry.ts';
import { createTextGeometry } from './text-geometry.ts';

// Called only from the isolated preload. There is no page-world bridge or marker.
export function createNodeRegistry(root: Document, identity: MappingIdentity, expected: SourceTree,
  emit: (event: MappingEvent) => void, emitIntent: (intent: MappingEditIntent) => void = () => {},
  emptyTextIndices: readonly number[] = [], emitGeometry?: (value: TextGeometry) => void) {
  let revision = 0;
  let active = true;
  let selected: string | null = null;
  let editToken: string | null = null;
  let intentSequence = 0;
  let intent: MappingEditIntent | null = null;
  let geometry: ReturnType<typeof createTextGeometry> | undefined;
  const byObject = new WeakMap<Text, string>();
  const byId = new Map<string, Text>();
  const valueById = new Map<string, string>();
  const observer = new MutationObserver(() => invalidate('DOM_MUTATED'));
  const invalidate = (reason: MappingFailure): void => {
    if (!active) return;
    active = false;
    selected = null;
    editToken = null; intent = null;
    observer.disconnect();
    geometry?.close();
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
    if (editToken) {
      // Keep the current edit owner until trusted UI resolves its input. Native
      // clicks can propose a target, but cannot move that owner's authority.
      if ((value === selected && !intent) || intent?.nodeId === value) return;
      intent = Object.freeze({ identity, editToken, sequence: ++intentSequence, nodeId: value });
      emitIntent(intent); return;
    }
    selected = value;
    emit({ identity, kind: 'selection', revision: ++revision, nodeId: value });
    geometry?.schedule();
  };
  const crossesText = (): boolean => {
    const selection = root.getSelection();
    return !!selection && !selection.isCollapsed && (selection.anchorNode !== selection.focusNode
      || selection.anchorNode?.nodeType !== Node.TEXT_NODE);
  };
  const onSelectionChange = (): void => { if (selected && crossesText()) select(null); };
  const hasGeneratedAncestor = (start: Element | null): boolean => {
    for (let element = start; element; element = element.parentElement) {
      for (const pseudo of ['::before', '::after', '::marker']) {
        const content = root.defaultView!.getComputedStyle(element, pseudo).content;
        if (content && content !== 'none' && content !== 'normal' && content !== '""') return true;
      }
    }
    return false;
  };
  const hasGeneratedContent = (text: Node): boolean => hasGeneratedAncestor(text.parentElement);
  const hitText = (event: MouseEvent): string | null => {
    if (!drain() || crossesText()) return null;
    const caret = root.caretRangeFromPoint(event.clientX, event.clientY);
    const text = caret?.startContainer;
    if (!text || text.nodeType !== Node.TEXT_NODE) return null;
    const nodeId = byObject.get(text as Text);
    if (!nodeId || text.getRootNode() !== root || !(event.composedPath().includes(text.parentNode!))) return null;
    // Overlapping pseudo content cannot be proven to identify the source Text.
    // Conservatively leave all text beneath that pseudo-bearing ancestor unselectable.
    if (hasGeneratedContent(text)) return null;
    const range = root.createRange();
    range.selectNodeContents(text);
    // A caret may snap to a nearby node when clicking generated CSS text or blank space.
    if (![...range.getClientRects()].some((rect) => Number.isFinite(rect.x) && Number.isFinite(rect.y)
      && rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom)) return null;
    return nodeId;
  };
  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted || !drain() || event.button !== 0) return;
    select(hitText(event));
  };
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  const matchTree = (omitted: ReadonlySet<number>): Map<number, Node> => {
    const objects = new Map<number, Node>();
    const stack: { node: Node; parent: number; depth: number }[] = [{ node: root, parent: -1, depth: 0 }];
    let position = 0;
    while (stack.length && active) {
      const { node, parent, depth } = stack.pop()!;
      while (omitted.has(position)) ++position;
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
      } else { invalidate('TREE_MISMATCH'); break; }
      if (JSON.stringify(actual) !== JSON.stringify(source)) { invalidate('TREE_MISMATCH'); break; }
      objects.set(index, node);
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, parent: index, depth: depth + 1 });
    }
    while (omitted.has(position)) ++position;
    if (active && position !== expected.length) invalidate('TREE_MISMATCH');
    return objects;
  };
  try {
    if (!isMappingInstall({ identity, tree: expected, emptyTextIndices })) invalidate('TREE_MISMATCH');
    const omitted = new Set(emptyTextIndices);
    let objects = matchTree(omitted);
    if (omitted.size && drain()) {
      const following = new Map<number, Node>();
      const plans: { index: number; parent: Element; before: Node | null }[] = [];
      // Plan against the entire verified DOM, before the first insertion. The
      // nearest surviving sibling is an object, never a selector or a text search.
      for (let index = expected.length - 1; index >= 0; --index) {
        const source = expected[index]!;
        if (!omitted.has(index)) { following.set(source.parent, objects.get(index)!); continue; }
        const parent = objects.get(source.parent); const before = following.get(source.parent) ?? null;
        if (!parent || parent.nodeType !== Node.ELEMENT_NODE || !parent.isConnected || parent.getRootNode() !== root
          || (before && before.parentNode !== parent) || hasGeneratedAncestor(parent as Element)) {
          invalidate('UNSUPPORTED_DOM'); break;
        }
        plans.push({ index, parent: parent as Element, before });
      }
      for (const { parent, before } of plans.reverse()) {
        if (!drain()) break;
        const previous = before ? before.previousSibling : parent.lastChild;
        const node = root.createTextNode('');
        parent.insertBefore(node, before);
        const records = observer.takeRecords(); const record = records[0];
        if (records.length !== 1 || record?.type !== 'childList' || record.target !== parent
          || record.addedNodes.length !== 1 || record.addedNodes[0] !== node || record.removedNodes.length !== 0
          || record.previousSibling !== previous || record.nextSibling !== before || node.parentNode !== parent
          || node.data !== '' || node.getRootNode() !== root) { invalidate('DOM_MUTATED'); break; }
      }
      if (drain()) objects = matchTree(new Set());
    }
    if (drain()) {
      for (const [index, node] of objects) {
        const source = expected[index]!;
        if (source.kind !== 'text' || !source.editable) continue;
        if (byId.has(source.nodeId)) { invalidate('TREE_MISMATCH'); break; }
        byId.set(source.nodeId, node as Text); byObject.set(node as Text, source.nodeId); valueById.set(source.nodeId, source.value);
      }
    }
    if (drain()) {
      root.addEventListener('click', onClick, true);
      root.addEventListener('selectionchange', onSelectionChange);
      emit({ identity, kind: 'ready', revision: ++revision, editableCount: byId.size });
      if (emitGeometry) geometry = createTextGeometry(root, identity, () => ({ active: drain(), revision, selected }), hitText,
        id => { const node = byId.get(id); return node && node.data === valueById.get(id) && !hasGeneratedContent(node) ? node : undefined; }, emitGeometry);
    }
  } catch { invalidate('UNSUPPORTED_DOM'); }
  const check = (request: MappingCheck): boolean => {
      if (!drain() || (!editToken && crossesText()) || !sameMapping(request.identity, identity) || request.revision !== revision || request.nodeId !== selected) return false;
      const node = byId.get(request.nodeId);
      return !!node && node.isConnected && node.getRootNode() === root && byObject.get(node) === request.nodeId
        && node.data === valueById.get(request.nodeId) && !hasGeneratedContent(node);
  };
  return {
    check,
    restore(request: MappingRestore): MappingRestoreResult {
      const result = (outcome: MappingRestoreResult['outcome']): MappingRestoreResult => ({
        identity, requestId: request.requestId, revision: request.revision, nextRevision: revision, outcome,
      });
      // Restoration is only for a fresh, unpublished mapping. It never invents a
      // native selection or reuses this operation to replace an active draft.
      if (!isMappingRestore(request) || !drain() || revision !== 1 || selected !== null || editToken
        || !sameMapping(request.identity, identity)) return result('rejected');
      const targets: { change: MappingRestore['changes'][number]; node: Text }[] = [];
      for (const change of request.changes) {
        const node = byId.get(change.nodeId);
        if (!node || !node.isConnected || node.getRootNode() !== root || byObject.get(node) !== change.nodeId
          || node.data !== change.expectedText || valueById.get(change.nodeId) !== change.expectedText || hasGeneratedContent(node)) return result('rejected');
        targets.push({ change, node });
      }
      try {
        // Check every target before the first assignment. Keep the observer on
        // through this synchronous batch and account for each native Text write.
        for (const { change, node } of targets) {
          node.data = change.newText;
          const records = observer.takeRecords();
          if (records.length !== 1 || records[0]!.type !== 'characterData' || records[0]!.target !== node
            || node.data !== change.newText || !node.isConnected || node.getRootNode() !== root) {
            invalidate('DOM_MUTATED'); return result('unknown');
          }
          valueById.set(change.nodeId, change.newText);
        }
        ++revision; geometry?.schedule(); return result('applied');
      } catch { invalidate('DOM_MUTATED'); return result('unknown'); }
    },
    history(request: MappingHistory): MappingHistoryResult {
      const result = (outcome: MappingHistoryResult['outcome']): MappingHistoryResult => ({ identity,
        requestId: request.requestId, nodeId: request.nodeId, revision: request.revision, nextRevision: revision, outcome });
      if (!isMappingHistory(request) || !drain() || editToken || !sameMapping(request.identity, identity)
        || request.revision !== revision) return result('rejected');
      const node = byId.get(request.nodeId);
      if (!node || !node.isConnected || node.getRootNode() !== root || byObject.get(node) !== request.nodeId
        || node.data !== request.expectedText || valueById.get(request.nodeId) !== request.expectedText
        || hasGeneratedContent(node)) return result('rejected');
      try {
        node.data = request.newText;
        const records = observer.takeRecords();
        if (records.length !== 1 || records[0]!.type !== 'characterData' || records[0]!.target !== node
          || node.data !== request.newText || !node.isConnected || node.getRootNode() !== root) {
          invalidate('DOM_MUTATED'); return result('unknown');
        }
        valueById.set(request.nodeId, request.newText); selected = null; ++revision; geometry?.schedule();
        return result('applied');
      } catch { invalidate('DOM_MUTATED'); return result('unknown'); }
    },
    edit(request: MappingEditRequest): MappingEditResult {
      const result = (accepted: boolean): MappingEditResult => ({
        identity, requestId: request.requestId, nodeId: request.nodeId, revision: request.revision,
        kind: request.kind, accepted, editToken, nextRevision: revision, nextNodeId: selected,
      });
      if (!check(request)) return result(false);
      if (request.kind === 'begin') {
        if (editToken) return result(false);
        editToken = request.requestId; intent = null;
        return result(true);
      }
      if (!editToken || request.editToken !== editToken || request.intentSequence !== (intent?.sequence ?? null)) return result(false);
      if (request.decision === 'stay') { intent = null; return result(true); }
      if (request.decision === 'accept') {
        if (!intent) return result(false);
        if (intent.nodeId !== null) {
          const next = byId.get(intent.nodeId);
          if (!next || !next.isConnected || next.getRootNode() !== root || byObject.get(next) !== intent.nodeId
            || next.data !== valueById.get(intent.nodeId) || hasGeneratedContent(next)) return result(false);
        }
        selected = intent.nodeId;
      }
      editToken = null; intent = null; ++revision; geometry?.schedule();
      return result(true);
    },
    apply(request: MappingApply): MappingApplyResult {
      const result = (outcome: MappingApplyResult['outcome']): MappingApplyResult => ({
        identity, requestId: request.requestId, nodeId: request.nodeId, revision: request.revision,
        outcome, nextRevision: revision,
      });
      if (!check(request) || valueById.get(request.nodeId) !== request.expectedText) return result('rejected');
      const node = byId.get(request.nodeId)!;
      try {
        if (node.data !== request.newText) {
          // Keep observing. Consume exactly our synchronous Text.data record; never
          // leave an observation gap or excuse another mutation with the same value.
          node.data = request.newText;
          const records = observer.takeRecords();
          if (records.length !== 1 || records[0]!.type !== 'characterData' || records[0]!.target !== node
            || node.data !== request.newText || !node.isConnected || node.getRootNode() !== root) {
            invalidate('DOM_MUTATED'); return result('unknown');
          }
          valueById.set(request.nodeId, request.newText);
        }
        ++revision; // Even a no-op retires the request's selection revision.
        geometry?.schedule();
        return result('applied');
      } catch { invalidate('DOM_MUTATED'); return result('unknown'); }
    },
    close: (): void => invalidate('CLOSED'),
  };
}
