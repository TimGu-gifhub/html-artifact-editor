import { MAX_DRAFT_INTENTS } from '../../contracts/draft-checkpoint.ts';
import { MAX_SOURCE_BYTES } from '../../contracts/source-tree.ts';
import { createSourceIndex } from '../parser/source-index.ts';
import type { HashBytes, SourceIdentity, SourceLineage } from '../parser/source-index.ts';
import { encodeUtf8 } from '../parser/utf8.ts';
import { buildTextIntentCandidate, createPatchEngine } from '../patch/engine.ts';
import type { PatchCandidate, TextChange } from '../patch/engine.ts';
import { normalizeText } from '../patch/encoding.ts';
import { createHistorySource } from './source.ts';

export const MAX_HISTORY_STEPS = 1000;
export const MAX_HISTORY_TEXT_BYTES = 8 * 1024 * 1024;
export type HistoryOperation = Readonly<{ target: string; before: string; after: string }>;
// Private logical record. originBytes is stored separately; no executable
// offsets, selectors, file paths, DOM serialization or candidate bytes occur here.
export type HistoryRecord = Readonly<{
  version: 1; originHash: string; originSize: number; baseHash: string; baseSize: number; candidateHash: string;
  revision: number; cursor: number; operations: readonly HistoryOperation[]; savedValues: SourceLineage['values'];
}>;
export type HistoryCheckpoint = Readonly<{ originBytes: Uint8Array; record: HistoryRecord }>;
export type HistoryTransition = Readonly<{
  changed: boolean; candidate: PatchCandidate; revision: number;
  changes: readonly Readonly<{ nodeId: string; expectedText: string; newText: string }>[];
}>;
const keys = (value: unknown, names: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hex = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const count = (value: unknown, max: number): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const fail = (): never => { throw new Error('HISTORY_RECORD_INVALID'); };
function freezeRecord(record: HistoryRecord): HistoryRecord {
  return Object.freeze({ ...record, operations: Object.freeze(record.operations.map(operation => Object.freeze({ ...operation }))),
    savedValues: Object.freeze(record.savedValues.map(value => Object.freeze({ ...value }))),
  });
}

export function createTextHistory(bytes: Uint8Array, identity: SourceIdentity, hash: HashBytes, checkpoint?: HistoryCheckpoint) {
  if (checkpoint !== undefined && (!keys(checkpoint, ['originBytes', 'record']) || !(checkpoint.originBytes instanceof Uint8Array))) return fail();
  const originBytes = new Uint8Array(checkpoint?.originBytes ?? bytes);
  const origin = createSourceIndex(originBytes, identity, hash);
  const originals = new Map(origin.nodes.filter(node => node.editable).map(node => [node.nodeId, node]));
  const initial: HistoryRecord = checkpoint?.record ?? { version: 1, originHash: origin.baseHash, originSize: originBytes.length,
    baseHash: origin.baseHash, baseSize: bytes.length, candidateHash: origin.baseHash, revision: 1, cursor: 0, operations: [], savedValues: [] };
  if (!keys(initial, ['version', 'originHash', 'originSize', 'baseHash', 'baseSize', 'candidateHash', 'revision', 'cursor', 'operations', 'savedValues'])
    || initial.version !== 1 || !hex(initial.originHash) || !hex(initial.baseHash) || !hex(initial.candidateHash)
    || !count(initial.originSize, MAX_SOURCE_BYTES) || initial.originSize !== originBytes.length || initial.originHash !== origin.baseHash
    || !count(initial.baseSize, MAX_SOURCE_BYTES) || initial.baseSize !== bytes.length || initial.baseHash !== hash(bytes)
    || !count(initial.revision, Number.MAX_SAFE_INTEGER - 1) || initial.revision < 1
    || !Array.isArray(initial.operations) || initial.operations.length > MAX_HISTORY_STEPS
    || !count(initial.cursor, initial.operations.length) || initial.revision <= initial.operations.length
    || !Array.isArray(initial.savedValues) || initial.savedValues.length > MAX_DRAFT_INTENTS) return fail();
  let textBytes = 0;
  const targets = new Set<string>();
  const charge = (text: unknown): string => {
    if (typeof text !== 'string' || normalizeText(text) !== text) return fail();
    textBytes += encodeUtf8(text).length;
    if (textBytes > MAX_HISTORY_TEXT_BYTES) throw new Error('HISTORY_STORAGE_LIMIT');
    return text;
  };
  const saved = new Set<string>();
  for (const value of initial.savedValues) {
    if (!keys(value, ['nodeId', 'text']) || typeof value.nodeId !== 'string' || !originals.has(value.nodeId) || saved.has(value.nodeId)) return fail();
    charge(value.text); saved.add(value.nodeId); targets.add(value.nodeId);
  }
  const replay = new Map<string, string>();
  let desired = new Map<string, string>();
  for (const [i, operation] of initial.operations.entries()) {
    if (!keys(operation, ['target', 'before', 'after']) || typeof operation.target !== 'string' || !originals.has(operation.target)) return fail();
    const before = charge(operation.before); const after = charge(operation.after);
    if (before === after || before !== (replay.get(operation.target) ?? originals.get(operation.target)!.decodedText)) return fail();
    replay.set(operation.target, after); targets.add(operation.target);
    if (i + 1 === initial.cursor) desired = new Map(replay);
  }
  if (targets.size > MAX_DRAFT_INTENTS) throw new Error('HISTORY_TARGET_LIMIT');
  const withinBudget = (operations: readonly HistoryOperation[], savedValues: SourceLineage['values']): void => {
    const maxima = new Map<string, number>(); let operationBytes = 0;
    const retain = (target: string, text: string): void => {
      const originalSize = maxima.get(target) ?? encodeUtf8(normalizeText(originals.get(target)!.decodedText)).length;
      maxima.set(target, Math.max(originalSize, encodeUtf8(text).length));
    };
    for (const value of savedValues) retain(value.nodeId, value.text);
    for (const operation of operations) {
      operationBytes += encodeUtf8(operation.before).length + encodeUtf8(operation.after).length;
      retain(operation.target, operation.before); retain(operation.target, operation.after);
    }
    // Reserve enough for the saved values at any cursor, so saving after Undo
    // cannot discover a history quota error only after the disk commit.
    if (operationBytes + [...maxima.values()].reduce((sum, size) => sum + size, 0) > MAX_HISTORY_TEXT_BYTES) {
      throw new Error('HISTORY_STORAGE_LIMIT');
    }
  };
  withinBudget(initial.operations, initial.savedValues);
  const rebound = createHistorySource(bytes, identity, { originBytes, values: initial.savedValues }, hash);
  const source = rebound.source;
  const fromLogical = new Map(rebound.bindings.map(binding => [binding.originNodeId, binding.nodeId]));
  const toLogical = new Map(rebound.bindings.map(binding => [binding.nodeId, binding.originNodeId]));
  const nodes = new Map(source.nodes.map(node => [node.nodeId, node]));
  const logicalText = (target: string, values = desired): string => values.get(target) ?? originals.get(target)!.decodedText;
  const intents = [...originals.keys()].flatMap(target => {
    const node = nodes.get(fromLogical.get(target)!)!; const text = logicalText(target);
    return text === node.decodedText ? [] : [{ nodeId: node.nodeId, expectedText: node.decodedText, newText: text,
      rawSliceHash: node.rawSliceHash, contextFingerprint: node.contextFingerprint }];
  });
  let candidate = buildTextIntentCandidate(source, intents, hash);
  if (candidate.resultHash !== initial.candidateHash) return fail();
  let record = freezeRecord(initial);
  const plans = new WeakMap<HistoryTransition, { before: HistoryRecord; next: HistoryRecord; desired: Map<string, string> }>();
  const transition = (nextCandidate: PatchCandidate, next: HistoryRecord, nextValues: Map<string, string>, change?: TextChange): HistoryTransition => {
    const plan: HistoryTransition = Object.freeze({ changed: nextCandidate.resultHash !== candidate.resultHash,
      candidate: nextCandidate, revision: next.revision,
      changes: Object.freeze(change && nextCandidate.resultHash !== candidate.resultHash
        ? [Object.freeze({ nodeId: change.nodeId, expectedText: change.expectedText, newText: logicalText(toLogical.get(change.nodeId)!, nextValues) })] : []),
    });
    plans.set(plan, { before: record, next, desired: nextValues }); return plan;
  };
  const nextRevision = (): number => {
    if (record.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('HISTORY_REVISION_LIMIT');
    return record.revision + 1;
  };
  return Object.freeze({
    source,
    get candidate(): PatchCandidate { return candidate; },
    get revision(): number { return record.revision; },
    summary() { return Object.freeze({ canUndo: record.cursor > 0, canRedo: record.cursor < record.operations.length,
      undoCount: record.cursor, redoCount: record.operations.length - record.cursor,
      dirty: candidate.resultHash !== source.baseHash, baseHash: source.baseHash, candidateHash: candidate.resultHash, revision: record.revision }); },
    capture(): HistoryCheckpoint { return Object.freeze({ get originBytes() { return new Uint8Array(originBytes); }, record }); },
    logicalTarget(nodeId: string): string | undefined { return toLogical.get(nodeId); },
    sourceTarget(target: string): string | undefined { return fromLogical.get(target); },
    textFor(nodeId: string): string | undefined { const target = toLogical.get(nodeId); return target === undefined ? undefined : logicalText(target); },
    prepareEdit(change: TextChange): HistoryTransition {
      const nextCandidate = createPatchEngine(source, hash, candidate.patches).apply(change);
      if (nextCandidate.resultHash === candidate.resultHash) return transition(candidate, record, desired);
      const target = toLogical.get(change.nodeId);
      if (!target) throw new Error('TARGET_READ_ONLY');
      const before = logicalText(target); const after = nextCandidate.patches.find(patch => patch.nodeId === change.nodeId)?.newText
        ?? nodes.get(change.nodeId)!.decodedText;
      // Both directions must satisfy the text limit before committing an edit.
      normalizeText(before);
      const operations = [...record.operations.slice(0, record.cursor), { target, before, after }];
      if (operations.length > MAX_HISTORY_STEPS) throw new Error('HISTORY_OPERATION_LIMIT');
      const used = new Set([...record.savedValues.map(value => value.nodeId), ...operations.map(operation => operation.target)]);
      if (used.size > MAX_DRAFT_INTENTS) throw new Error('HISTORY_TARGET_LIMIT');
      withinBudget(operations, record.savedValues);
      const nextValues = new Map(desired); nextValues.set(target, after);
      return transition(nextCandidate, freezeRecord({ ...record, operations, cursor: operations.length,
        candidateHash: nextCandidate.resultHash, revision: nextRevision() }), nextValues, change);
    },
    prepareMove(direction: 'undo' | 'redo'): HistoryTransition {
      if (direction !== 'undo' && direction !== 'redo') throw new Error('HISTORY_DIRECTION_INVALID');
      const index = direction === 'undo' ? record.cursor - 1 : record.cursor;
      const operation = record.operations[index];
      if (!operation) throw new Error('HISTORY_UNAVAILABLE');
      const text = direction === 'undo' ? operation.before : operation.after;
      const nodeId = fromLogical.get(operation.target)!;
      const change: TextChange = { identity: source.identity, baseHash: source.baseHash,
        nodeId, expectedText: logicalText(operation.target), newText: text };
      const nextCandidate = createPatchEngine(source, hash, candidate.patches).apply(change);
      const nextValues = new Map(desired); nextValues.set(operation.target, text);
      return transition(nextCandidate, freezeRecord({ ...record, cursor: record.cursor + (direction === 'undo' ? -1 : 1),
        candidateHash: nextCandidate.resultHash, revision: nextRevision() }), nextValues, change);
    },
    commit(plan: HistoryTransition): void {
      const retained = plans.get(plan);
      if (!retained || retained.before !== record) throw new Error('STALE_HISTORY_TRANSITION');
      plans.delete(plan); record = retained.next; desired = retained.desired; candidate = plan.candidate;
    },
    rebaseSaved(savedBytes: Uint8Array, nextIdentity: SourceIdentity) {
      const frozen = candidate.bytes;
      if (savedBytes.length !== frozen.length || hash(savedBytes) !== candidate.resultHash || !savedBytes.every((value, i) => value === frozen[i])) {
        throw new Error('HISTORY_SAVED_BYTES_MISMATCH');
      }
      if (nextIdentity.projectId === source.identity.projectId && nextIdentity.documentId === source.identity.documentId
        && nextIdentity.generation === source.identity.generation) throw new Error('HISTORY_REBASE_IDENTITY');
      const touched = new Set([...record.savedValues.map(value => value.nodeId), ...record.operations.map(operation => operation.target)]);
      const savedValues = [...touched].sort((a, b) => originals.get(a)!.treeIndex - originals.get(b)!.treeIndex)
        .map(nodeId => ({ nodeId, text: logicalText(nodeId) }));
      return createTextHistory(savedBytes, nextIdentity, hash, { originBytes, record: freezeRecord({ ...record,
        baseHash: candidate.resultHash, baseSize: savedBytes.length, candidateHash: candidate.resultHash,
        savedValues, revision: nextRevision() }) });
    },
  });
}
export type TextHistory = ReturnType<typeof createTextHistory>;
