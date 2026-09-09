import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { freezeHistoryRecord, isHistoryRecord } from '../../contracts/history.ts';
import type { HistoryCheckpoint } from '../../core/history/timeline.ts';
import type { SourceIndex, SourceIdentity } from '../../core/parser/source-index.ts';
import type { PatchCandidate, TextChange } from '../../core/patch/engine.ts';
import type { MappingRestoreChange } from '../../contracts/mapping-restore.ts';
import { freezeCandidate } from './prepare.ts';

export type HistoryCommand = Readonly<{ kind: 'read' }> | Readonly<{ kind: 'edit'; change: TextChange }>
  | Readonly<{ kind: 'move'; direction: 'undo' | 'redo' }>
  | Readonly<{ kind: 'saved'; bytes: Uint8Array; identity: SourceIdentity }>;
export type PreparedHistory = Readonly<{ candidate: PatchCandidate; checkpoint: HistoryCheckpoint; changes: readonly MappingRestoreChange[] }>;
const blocked = new Set<string>();
export function assertHistoryWorkerAvailable(outputRoot: string): void {
  if (blocked.has(resolve(outputRoot, 'history-worker/index.cjs'))) throw new Error('HISTORY_WORKER_STOP_FAILED');
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a: SourceIdentity, b: SourceIdentity): boolean => a.projectId === b.projectId && a.documentId === b.documentId && a.generation === b.generation;
export function freezeHistoryCheckpoint(value: HistoryCheckpoint): HistoryCheckpoint {
  if (!(value?.originBytes instanceof Uint8Array) || !isHistoryRecord(value.record)) throw new Error('HISTORY_RECORD_INVALID');
  const origin = new Uint8Array(value.originBytes);
  if (origin.length !== value.record.originSize || hash(origin) !== value.record.originHash) throw new Error('HISTORY_RECORD_INVALID');
  return Object.freeze({ get originBytes() { return new Uint8Array(origin); }, record: freezeHistoryRecord(value.record) });
}

export function prepareHistory(outputRoot: string, source: SourceIndex, checkpoint: HistoryCheckpoint | undefined,
  command: HistoryCommand, signal: AbortSignal): Promise<PreparedHistory> {
  if (signal.aborted) return Promise.reject(new Error('HISTORY_PREPARE_CANCELLED'));
  const entry = resolve(outputRoot, 'history-worker/index.cjs');
  try { assertHistoryWorkerAvailable(outputRoot); } catch (error) { return Promise.reject(error); }
  return new Promise((resolveHistory, reject) => {
    const worker = new Worker(entry, { workerData: { bytes: source.bytes, identity: source.identity, checkpoint, command },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 } });
    let finished = false;
    const finish = (result?: PreparedHistory, error = 'HISTORY_PREPARE_FAILED'): void => {
      if (finished) return; finished = true; clearTimeout(deadline); signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (!result) { reject(new Error(error)); return; }
        try {
          const candidate = freezeCandidate(result.candidate); const retained = freezeHistoryCheckpoint(result.checkpoint);
          const identity = command.kind === 'saved' ? command.identity : source.identity;
          const baseHash = command.kind === 'saved' ? hash(command.bytes) : source.baseHash;
          const baseSize = command.kind === 'saved' ? command.bytes.length : source.bytes.length;
          const previousHash = checkpoint?.record.candidateHash ?? source.baseHash;
          const changed = candidate.resultHash !== previousHash;
          const revision = (checkpoint?.record.revision ?? 1) + (command.kind === 'saved' || command.kind === 'move' || (command.kind === 'edit' && changed) ? 1 : 0);
          if (!sameIdentity(candidate.identity, identity) || candidate.baseHash !== baseHash || retained.record.baseHash !== baseHash
            || retained.record.baseSize !== baseSize || retained.record.revision !== revision
            || retained.record.originHash !== (checkpoint?.record.originHash ?? source.baseHash)
            || retained.record.originSize !== (checkpoint?.record.originSize ?? source.bytes.length)
            || candidate.resultHash !== retained.record.candidateHash || hash(candidate.bytes) !== candidate.resultHash
            || !Array.isArray(result.changes) || result.changes.length > 1) throw new Error('HISTORY_PREPARE_FAILED');
          const changes = Object.freeze(result.changes.map(change => {
            if (!change || Object.keys(change).length !== 3 || typeof change.nodeId !== 'string'
              || typeof change.expectedText !== 'string' || typeof change.newText !== 'string') throw new Error('HISTORY_PREPARE_FAILED');
            return Object.freeze({ ...change });
          }));
          if ((command.kind === 'read' && (changed || changes.length))
            || (command.kind === 'saved' && (candidate.patches.length || changes.length || candidate.resultHash !== baseHash))
            || ((command.kind === 'move' || command.kind === 'edit') && changes.length !== (changed ? 1 : 0))
            || (command.kind === 'edit' && changes.length && (changes[0]!.nodeId !== command.change.nodeId
              || changes[0]!.expectedText !== command.change.expectedText))) throw new Error('HISTORY_PREPARE_FAILED');
          resolveHistory(Object.freeze({ candidate, checkpoint: retained, changes }));
        } catch { reject(new Error('HISTORY_PREPARE_FAILED')); }
      }, () => { blocked.add(entry); reject(new Error('HISTORY_WORKER_STOP_FAILED')); });
    };
    const abort = (): void => finish(undefined, 'HISTORY_PREPARE_CANCELLED');
    const deadline = setTimeout(() => finish(undefined, 'HISTORY_PREPARE_TIMEOUT'), 5000);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    worker.once('error', () => finish()); worker.once('exit', () => { if (!finished) finish(); });
    worker.once('message', result => {
      if (result?.ok) finish(result); else finish(undefined, typeof result?.error === 'string' && /^[A-Z_]+$/u.test(result.error) ? result.error : undefined);
    });
  });
}

// Main retains only confirmed state. Parsing, replay and patch computation run
// in a bounded Worker; a returned plan is not confirmation that Preview changed.
export async function createHistoryController(outputRoot: string, source: SourceIndex, checkpoint?: HistoryCheckpoint,
  signal: AbortSignal = new AbortController().signal, prepare = prepareHistory) {
  let state = await prepare(outputRoot, source, checkpoint, { kind: 'read' }, signal);
  let active: Promise<PreparedHistory> | null = null; let closed = false; let stopFailed = false;
  const cancellation = new AbortController();
  const plans = new WeakMap<PreparedHistory, PreparedHistory>();
  const run = async (command: HistoryCommand): Promise<PreparedHistory> => {
    if (closed || active || stopFailed) throw new Error('HISTORY_UNAVAILABLE');
    const before = state;
    active = prepare(outputRoot, source, before.checkpoint, command, cancellation.signal);
    try {
      const result = await active;
      if (closed || state !== before) throw new Error('STALE_HISTORY_TRANSITION');
      plans.set(result, before); return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'HISTORY_WORKER_STOP_FAILED') stopFailed = true;
      throw error;
    } finally { active = null; }
  };
  return Object.freeze({
    get available() { return !closed && !active && !stopFailed; },
    get candidate() { return state.candidate; },
    get revision() { return state.checkpoint.record.revision; },
    capture(): HistoryCheckpoint { return state.checkpoint; },
    summary() { const record = state.checkpoint.record; return Object.freeze({ undoCount: record.cursor, redoCount: record.operations.length - record.cursor }); },
    prepareEdit(change: TextChange) { return run({ kind: 'edit', change }); },
    prepareMove(direction: 'undo' | 'redo') { return run({ kind: 'move', direction }); },
    commit(plan: PreparedHistory): void {
      if (closed || plans.get(plan) !== state || active) throw new Error('STALE_HISTORY_TRANSITION');
      plans.delete(plan); state = plan;
    },
    async savedCheckpoint(bytes: Uint8Array): Promise<HistoryCheckpoint> {
      const result = await run({ kind: 'saved', bytes, identity: { ...source.identity, documentId: randomUUID() } });
      plans.delete(result); return result.checkpoint;
    },
    async close(): Promise<void> {
      closed = true; cancellation.abort();
      try { await active; } catch (error) { if (error instanceof Error && error.message === 'HISTORY_WORKER_STOP_FAILED') stopFailed = true; }
      if (stopFailed) throw new Error('HISTORY_WORKER_STOP_FAILED');
    },
  });
}
export type HistoryController = Awaited<ReturnType<typeof createHistoryController>>;
