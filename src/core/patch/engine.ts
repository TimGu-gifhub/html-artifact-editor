import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import type { TreeNode } from '../../contracts/source-tree.ts';
import { createSourceIndex } from '../parser/source-index.ts';
import type { HashBytes, SourceIdentity, SourceIndex, TextSource } from '../parser/source-index.ts';
import { chooseLineEnding, defaultLineEnding, encodeText, normalizeText } from './encoding.ts';
import type { LineEnding } from './encoding.ts';
import { isStoredTextIntent, MAX_DRAFT_INTENTS } from '../../contracts/draft-checkpoint.ts';
import type { StoredTextIntent } from '../../contracts/draft-checkpoint.ts';
import { verifySourceIndex } from '../history/source.ts';

export const MAX_PATCHES = MAX_DRAFT_INTENTS;
export type TextChange = Readonly<{
  identity: SourceIdentity; baseHash: string; nodeId: string; expectedText: string; newText: string;
}>;
export type TextPatch = Readonly<{
  schemaVersion: 1; identity: SourceIdentity; baseHash: string; nodeId: string;
  startByte: number; endByte: number; oldSliceHash: string; contextFingerprint: string;
  expectedText: string; newText: string; lineEnding: LineEnding; mixedLineEndings: boolean;
  leadingLfCompensation: boolean; replacementBytes: Uint8Array;
}>;
export type PatchCandidate = Readonly<{
  identity: SourceIdentity; baseHash: string; resultHash: string;
  patches: readonly TextPatch[]; bytes: Uint8Array;
}>;
const keys = (value: unknown, names: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const sameIdentity = (a: unknown, b: SourceIdentity): boolean => keys(a, ['projectId', 'documentId', 'generation'])
  && a.projectId === b.projectId && a.documentId === b.documentId && a.generation === b.generation;
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);
const patchKeys = ['schemaVersion', 'identity', 'baseHash', 'nodeId', 'startByte', 'endByte', 'oldSliceHash',
  'contextFingerprint', 'expectedText', 'newText', 'lineEnding', 'mixedLineEndings', 'leadingLfCompensation', 'replacementBytes'];

function verifySource(source: SourceIndex, hash: HashBytes): SourceIndex {
  return verifySourceIndex(source, hash);
}
function makePatch(source: SourceIndex, node: TextSource, text: string, fallback: LineEnding): TextPatch {
  const { ending, mixed } = chooseLineEnding(source.text.slice(node.startCodeUnit, node.endCodeUnit), fallback);
  const replacement = encodeText(text, ending, node.consumesLeadingLf);
  return Object.freeze({ schemaVersion: 1, identity: source.identity, baseHash: source.baseHash, nodeId: node.nodeId,
    startByte: node.startByte, endByte: node.endByte, oldSliceHash: node.rawSliceHash, contextFingerprint: node.contextFingerprint,
    expectedText: node.decodedText, newText: text, lineEnding: ending, mixedLineEndings: mixed,
    leadingLfCompensation: node.consumesLeadingLf && text.startsWith('\n'),
    get replacementBytes() { return new Uint8Array(replacement); },
  });
}
// Ignore source-only ids/locations while comparing the exact semantic tree.
function semanticTree(tree: readonly TreeNode[], replacements: ReadonlyMap<string, string>) {
  const positions = new Map<number, number>();
  const result: unknown[] = [];
  for (const [index, node] of tree.entries()) {
    const parent = node.parent === -1 ? -1 : positions.get(node.parent);
    if (parent === undefined) throw new Error('CANDIDATE_TREE_MISMATCH');
    if (node.kind === 'text') {
      const value = replacements.get(node.nodeId) ?? node.value;
      if (value === '') continue;
      positions.set(index, result.length);
      result.push({ parent, kind: 'text', value });
    } else {
      positions.set(index, result.length);
      result.push({ ...node, parent });
    }
  }
  return result;
}

function compile(source: SourceIndex, input: readonly TextPatch[], hash: HashBytes): PatchCandidate {
  if (!Array.isArray(input) || input.length > MAX_PATCHES) throw new Error('PATCH_COUNT_LIMIT');
  const bytes = source.bytes;
  if (hash(bytes) !== source.baseHash) throw new Error('BASE_HASH_MISMATCH');
  const nodes = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const patches: TextPatch[] = [];
  const seen = new Set<string>();
  const fallback = defaultLineEnding(source.text);
  let replacementBudget = 0;
  for (const patch of input) {
    if (!keys(patch, patchKeys) || patch.schemaVersion !== 1 || !sameIdentity(patch.identity, source.identity)
      || patch.baseHash !== source.baseHash || typeof patch.nodeId !== 'string') throw new Error('PATCH_BINDING_MISMATCH');
    const node = nodes.get(patch.nodeId);
    if (!node || !node.editable) throw new Error('TARGET_READ_ONLY');
    if (seen.has(patch.nodeId)) throw new Error('OVERLAPPING_PATCHES');
    seen.add(patch.nodeId);
    if (patch.startByte !== node.startByte || patch.endByte !== node.endByte || patch.oldSliceHash !== node.rawSliceHash
      || patch.contextFingerprint !== node.contextFingerprint || patch.expectedText !== node.decodedText
      || hash(bytes.slice(node.startByte, node.endByte)) !== patch.oldSliceHash) throw new Error('PATCH_SOURCE_MISMATCH');
    const text = normalizeText(patch.newText);
    if (text !== patch.newText || text === node.decodedText) throw new Error('NONCANONICAL_PATCH');
    const trusted = makePatch(source, node, text, fallback);
    const encoded = trusted.replacementBytes;
    replacementBudget += encoded.length;
    if (replacementBudget > MAX_SOURCE_BYTES + bytes.length) throw new Error('CANDIDATE_SIZE_LIMIT');
    if (!(patch.replacementBytes instanceof Uint8Array) || !equalBytes(patch.replacementBytes, encoded)
      || patch.lineEnding !== trusted.lineEnding || patch.mixedLineEndings !== trusted.mixedLineEndings
      || patch.leadingLfCompensation !== trusted.leadingLfCompensation) throw new Error('PATCH_ENCODING_MISMATCH');
    patches.push(trusted);
  }
  patches.sort((a, b) => a.startByte - b.startByte);
  let cursor = 0;
  let size = bytes.length;
  for (const patch of patches) {
    if (patch.startByte < cursor || patch.startByte > patch.endByte || patch.endByte > bytes.length
      || (patch.startByte === patch.endByte && (!source.lineage || patch.expectedText !== ''))) throw new Error('OVERLAPPING_PATCHES');
    cursor = patch.endByte;
    size += patch.replacementBytes.length - (patch.endByte - patch.startByte);
  }
  if (size > MAX_SOURCE_BYTES) throw new Error('CANDIDATE_SIZE_LIMIT');
  const output = new Uint8Array(size);
  const untouched: { start: number; end: number; outputStart: number }[] = [];
  cursor = 0;
  let destination = 0;
  for (const patch of patches) {
    const original = bytes.subarray(cursor, patch.startByte);
    untouched.push({ start: cursor, end: patch.startByte, outputStart: destination });
    output.set(original, destination); destination += original.length;
    const replacement = patch.replacementBytes;
    output.set(replacement, destination); destination += replacement.length;
    cursor = patch.endByte;
  }
  untouched.push({ start: cursor, end: bytes.length, outputStart: destination });
  output.set(bytes.subarray(cursor), destination);
  // Verify the actual output, not just the patch arithmetic used to build it.
  for (const segment of untouched) {
    if (!equalBytes(bytes.subarray(segment.start, segment.end),
      output.subarray(segment.outputStart, segment.outputStart + segment.end - segment.start))) throw new Error('UNTOUCHED_BYTES_CHANGED');
  }
  if (patches.length) {
    const reparsed = createSourceIndex(output, source.identity, hash);
    if (JSON.stringify(reparsed.parseErrors) !== JSON.stringify(source.parseErrors)) throw new Error('CANDIDATE_PARSE_ERROR');
    const changes = new Map(patches.map((patch) => [patch.nodeId, patch.newText]));
    if (JSON.stringify(semanticTree(source.tree, changes)) !== JSON.stringify(semanticTree(reparsed.tree, new Map()))) {
      throw new Error('CANDIDATE_TREE_MISMATCH');
    }
    // Do not produce a candidate whose surviving edited Text loses its source proof.
    let removed = 0;
    for (const [position, node] of source.tree.entries()) {
      if (node.kind !== 'text') continue;
      if ((changes.get(node.nodeId) ?? node.value) === '') { removed++; continue; }
      if (changes.has(node.nodeId)) {
        const target = reparsed.tree[position - removed];
        if (target?.kind !== 'text' || !target.editable) throw new Error('CANDIDATE_TARGET_UNMAPPABLE');
      }
    }
  }
  return Object.freeze({ identity: source.identity, baseHash: source.baseHash, resultHash: hash(output),
    patches: Object.freeze(patches), get bytes() { return new Uint8Array(output); },
  });
}

// Internal/storage callers may validate patches, but cannot supply new byte ranges.
export function buildPatchCandidate(source: SourceIndex, patches: readonly TextPatch[], hash: HashBytes): PatchCandidate {
  return compile(verifySource(source, hash), patches, hash);
}

// Recovery supplies logical intent only. Reparse/verify the full baseline, then
// derive every byte range and replacement from these newly verified Text nodes.
export function buildTextIntentCandidate(input: SourceIndex, intents: readonly StoredTextIntent[], hash: HashBytes): PatchCandidate {
  const source = verifySource(input, hash);
  if (!Array.isArray(intents) || intents.length > MAX_PATCHES) throw new Error('PATCH_COUNT_LIMIT');
  const nodes = new Map(source.nodes.map(node => [node.nodeId, node]));
  const fallback = defaultLineEnding(source.text);
  const patches = intents.map(intent => {
    // A proven history source can contain fresh ids for emptied Text nodes.
    // Keep the old persisted v1 id format unchanged; private history intents
    // instead bind every field to the newly reconstructed source below.
    const fields = ['nodeId', 'expectedText', 'newText', 'rawSliceHash', 'contextFingerprint'];
    const valid = source.lineage
      ? keys(intent, fields) && fields.every(field => typeof intent[field] === 'string')
      : isStoredTextIntent(intent);
    if (!valid) throw new Error('DRAFT_INTENT_INVALID');
    const node = nodes.get(intent.nodeId);
    if (!node?.editable || node.decodedText !== intent.expectedText || node.rawSliceHash !== intent.rawSliceHash
      || node.contextFingerprint !== intent.contextFingerprint) throw new Error('DRAFT_INTENT_MISMATCH');
    const text = normalizeText(intent.newText);
    if (text !== intent.newText || text === node.decodedText) throw new Error('NONCANONICAL_PATCH');
    return makePatch(source, node, text, fallback);
  });
  return compile(source, patches, hash);
}

export function createPatchEngine(input: SourceIndex, hash: HashBytes, initialPatches: readonly TextPatch[] = []) {
  const source = verifySource(input, hash);
  const nodes = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const fallback = defaultLineEnding(source.text);
  let current = compile(source, initialPatches, hash);
  return Object.freeze({
    source,
    get candidate(): PatchCandidate { return current; },
    apply(change: TextChange): PatchCandidate {
      if (!keys(change, ['identity', 'baseHash', 'nodeId', 'expectedText', 'newText'])
        || !sameIdentity(change.identity, source.identity) || change.baseHash !== source.baseHash) throw new Error('CHANGE_BINDING_MISMATCH');
      const node = nodes.get(change.nodeId);
      if (!node || !node.editable) throw new Error('TARGET_READ_ONLY');
      const previous = current.patches.find((patch) => patch.nodeId === node.nodeId);
      if (change.expectedText !== (previous?.newText ?? node.decodedText)) throw new Error('STALE_TEXT_CHANGE');
      const text = normalizeText(change.newText);
      if (text === (previous?.newText ?? node.decodedText)) return current;
      const patches = current.patches.filter((patch) => patch.nodeId !== node.nodeId);
      if (text !== node.decodedText) patches.push(makePatch(source, node, text, fallback));
      const candidate = compile(source, patches, hash);
      current = candidate; // A failed validation cannot change the prior draft/candidate.
      return current;
    },
  });
}
