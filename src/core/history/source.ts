import { MAX_TREE_NODES } from '../../contracts/source-tree.ts';
import type { TreeNode } from '../../contracts/source-tree.ts';
import { MAX_DRAFT_INTENTS } from '../../contracts/draft-checkpoint.ts';
import { createSourceIndex } from '../parser/source-index.ts';
import type { HashBytes, SourceIdentity, SourceIndex, SourceLineage, TextSource } from '../parser/source-index.ts';
import { decodeUtf8, encodeUtf8, INVALID_BOUNDARY } from '../parser/utf8.ts';
import { normalizeText } from '../patch/encoding.ts';

export type TextBinding = Readonly<{ originNodeId: string; nodeId: string }>;
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i]);
const keys = (value: unknown, names: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const mismatch = (): never => { throw new Error('HISTORY_SOURCE_MISMATCH'); };

// Reconstructs a Text that disappeared on Save only after proving the complete
// current tree and every source fragment outside the original editable Texts.
// The byte cursor follows fresh parsed Text ranges and matched literal gaps;
// no old offset or selector is accepted as a location in the new baseline.
export function createHistorySource(bytes: Uint8Array, identity: SourceIdentity, lineage: SourceLineage, hash: HashBytes): Readonly<{
  source: SourceIndex; bindings: readonly TextBinding[];
}> {
  if (!keys(lineage, ['originBytes', 'values']) || !(lineage.originBytes instanceof Uint8Array)
    || !Array.isArray(lineage.values) || lineage.values.length > MAX_DRAFT_INTENTS) return mismatch();
  const origin = createSourceIndex(lineage.originBytes, identity, hash);
  const fresh = createSourceIndex(bytes, identity, hash);
  const original = origin.bytes; const current = fresh.bytes;
  const origins = new Map(origin.nodes.map(node => [node.nodeId, node]));
  const values = new Map<string, string>();
  for (const value of lineage.values) {
    if (!keys(value, ['nodeId', 'text']) || typeof value.nodeId !== 'string' || typeof value.text !== 'string'
      || !origins.get(value.nodeId)?.editable || values.has(value.nodeId) || normalizeText(value.text) !== value.text) return mismatch();
    values.set(value.nodeId, value.text);
  }
  if (JSON.stringify(origin.parseErrors) !== JSON.stringify(fresh.parseErrors)) return mismatch();
  const positions = new Map<number, number>();
  const actualTexts = new Map(fresh.nodes.map(node => [node.treeIndex, node]));
  const matched = new Map<string, TextSource>();
  const tree: TreeNode[] = [];
  let cursor = 0;
  for (const [index, node] of origin.tree.entries()) {
    const parent = node.parent < 0 ? -1 : positions.get(node.parent);
    if (parent === undefined) return mismatch();
    const text = node.kind === 'text' ? values.get(node.nodeId) ?? node.value : undefined;
    if (node.kind === 'text' && text === '') {
      if (!node.editable || !values.has(node.nodeId)) return mismatch();
      // Reserve a new identity outside the range used by ordinary parsed nodes.
      tree.push(Object.freeze({ ...node, nodeId: `n${MAX_TREE_NODES + index}`, value: '' }));
      continue;
    }
    const actual = fresh.tree[cursor];
    if (!actual || actual.parent !== parent || actual.kind !== node.kind) return mismatch();
    if (node.kind === 'text') {
      if (actual.kind !== 'text' || actual.value !== text || actual.editable !== node.editable
        || actual.readOnlyReason !== node.readOnlyReason) return mismatch();
      const target = actualTexts.get(cursor);
      if (!target) return mismatch();
      matched.set(node.nodeId, target);
    } else if (JSON.stringify({ ...node, parent }) !== JSON.stringify(actual)) return mismatch();
    positions.set(index, cursor++);
    tree.push(Object.freeze({ ...actual, parent: node.parent }));
  }
  if (cursor !== fresh.tree.length) return mismatch();

  const editable = origin.nodes.filter(node => node.editable).sort((a, b) => a.startByte - b.startByte);
  const emptyBoundaries = new Map<string, number>();
  let oldEnd = 0; let newEnd = 0;
  for (const node of editable) {
    if (node.startByte < oldEnd || node.startByte >= node.endByte) return mismatch();
    const gap = original.subarray(oldEnd, node.startByte);
    const target = matched.get(node.nodeId);
    const start = target?.startByte ?? newEnd + gap.length;
    const end = target?.endByte ?? start;
    if (start < newEnd || end < start || end > current.length || !equal(gap, current.subarray(newEnd, start))) return mismatch();
    if (!target) {
      if (values.get(node.nodeId) !== '') return mismatch();
      emptyBoundaries.set(node.nodeId, start);
    } else if (!values.has(node.nodeId) && !equal(original.subarray(node.startByte, node.endByte), current.subarray(start, end))) return mismatch();
    oldEnd = node.endByte; newEnd = end;
  }
  if (!equal(original.subarray(oldEnd), current.subarray(newEnd))) return mismatch();
  // One reverse table is enough even when hundreds of Texts disappeared. A
  // surrogate midpoint can never become an insertion boundary.
  const codeUnits = new Map<number, number>();
  if (emptyBoundaries.size) {
    const wanted = new Set(emptyBoundaries.values());
    const offsets = decodeUtf8(current).byteOffsets;
    for (let unit = 0; unit < offsets.length; ++unit) {
      const byte = offsets[unit]!;
      if (byte !== INVALID_BOUNDARY && wanted.has(byte)) codeUnits.set(byte, unit);
    }
  }
  const bindings: TextBinding[] = [];
  const nodes: TextSource[] = [];
  for (const node of origin.nodes) {
    const target = matched.get(node.nodeId);
    const descriptor = tree[node.treeIndex];
    if (descriptor?.kind !== 'text') return mismatch();
    if (target) nodes.push(Object.freeze({ ...target, treeIndex: node.treeIndex }));
    else {
      const startByte = emptyBoundaries.get(node.nodeId);
      const unit = startByte === undefined ? undefined : codeUnits.get(startByte);
      if (startByte === undefined || unit === undefined) return mismatch();
      nodes.push(Object.freeze({ nodeId: descriptor.nodeId, treeIndex: node.treeIndex,
        startCodeUnit: unit, endCodeUnit: unit, startByte, endByte: startByte,
        rawSliceHash: hash(new Uint8Array()), decodedText: '',
        contextFingerprint: hash(encodeUtf8(JSON.stringify({ baseHash: fresh.baseHash, originHash: origin.baseHash,
          originNodeId: node.nodeId, parent: descriptor.parent, startByte, consumesLeadingLf: node.consumesLeadingLf }))),
        parentTag: node.parentTag, namespace: node.namespace, consumesLeadingLf: node.consumesLeadingLf,
        editable: true, readOnlyReason: null,
      }));
    }
    if (node.editable) bindings.push(Object.freeze({ originNodeId: node.nodeId, nodeId: descriptor.nodeId }));
  }
  const retainedOrigin = new Uint8Array(original);
  const proof: SourceLineage = Object.freeze({ get originBytes() { return new Uint8Array(retainedOrigin); },
    values: Object.freeze([...values].sort(([a], [b]) => origins.get(a)!.treeIndex - origins.get(b)!.treeIndex)
      .map(([nodeId, text]) => Object.freeze({ nodeId, text }))),
  });
  return Object.freeze({ source: Object.freeze({ ...fresh, get bytes() { return new Uint8Array(current); },
    tree: Object.freeze(tree), nodes: Object.freeze(nodes), lineage: proof }), bindings: Object.freeze(bindings) });
}

export function verifySourceIndex(source: SourceIndex, hash: HashBytes): SourceIndex {
  const verified = source.lineage === undefined ? createSourceIndex(source.bytes, source.identity, hash)
    : createHistorySource(source.bytes, source.identity, source.lineage, hash).source;
  if (source.schemaVersion !== 1 || source.baseHash !== verified.baseHash || source.text !== verified.text
    || source.hasBom !== verified.hasBom || JSON.stringify(source.tree) !== JSON.stringify(verified.tree)
    || JSON.stringify(source.nodes) !== JSON.stringify(verified.nodes)
    || JSON.stringify(source.parseErrors) !== JSON.stringify(verified.parseErrors)) throw new Error('SOURCE_INDEX_MISMATCH');
  return verified;
}
