import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isSourceDiff } from '../../contracts/source-diff.ts';
import type { SourceDiff } from '../../contracts/source-diff.ts';
import type { SourceIndex } from '../../core/parser/source-index.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';

export function prepareSourceDiff(outputRoot: string, source: SourceIndex, candidate: PatchCandidate, signal: AbortSignal): Promise<SourceDiff> {
  if (signal.aborted) return Promise.reject(new Error('SOURCE_DIFF_CANCELLED'));
  const original = source.bytes; const bytes = candidate.bytes;
  const baseHash = source.baseHash; const candidateHash = candidate.resultHash;
  const ranges = candidate.patches.map(patch => ({ nodeId: patch.nodeId, startByte: patch.startByte,
    endByte: patch.endByte, replacementSize: patch.replacementBytes.length,
    lineEnding: patch.lineEnding === '\r\n' ? 'crlf' : patch.lineEnding === '\r' ? 'cr' : 'lf',
    mixedLineEndings: patch.mixedLineEndings, leadingLfCompensation: patch.leadingLfCompensation,
  })).sort((a, b) => a.startByte - b.startByte);
  const matches = (diff: SourceDiff): boolean => diff.baseHash === baseHash && diff.candidateHash === candidateHash
    && diff.baseSize === original.length && diff.candidateSize === bytes.length && diff.changes.length === ranges.length
    && diff.changes.every((change, i) => change.nodeId === ranges[i]!.nodeId && change.before.startByte === ranges[i]!.startByte
      && change.before.endByte === ranges[i]!.endByte && change.after.endByte - change.after.startByte === ranges[i]!.replacementSize
      && change.lineEnding === ranges[i]!.lineEnding && change.mixedLineEndings === ranges[i]!.mixedLineEndings
      && change.leadingLfCompensation === ranges[i]!.leadingLfCompensation
      && Buffer.from(change.before.text).equals(original.subarray(change.before.startByte, change.before.endByte))
      && Buffer.from(change.after.text).equals(bytes.subarray(change.after.startByte, change.after.endByte)));
  return new Promise((resolveDiff, reject) => {
    const worker = new Worker(resolve(outputRoot, 'diff-worker/index.cjs'), {
      workerData: { bytes: original, identity: source.identity, candidate: { ...candidate, bytes } },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let finished = false;
    const finish = (diff?: SourceDiff, error = 'SOURCE_DIFF_FAILED'): void => {
      if (finished) return; finished = true; clearTimeout(deadline); signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (!diff) { reject(new Error(error)); return; }
        resolveDiff(Object.freeze({ ...diff, changes: Object.freeze(diff.changes.map(change => Object.freeze({
          ...change, before: Object.freeze({ ...change.before }), after: Object.freeze({ ...change.after }),
        }))) }));
      }, () => reject(new Error('SOURCE_DIFF_STOP_FAILED')));
    };
    const abort = (): void => finish(undefined, 'SOURCE_DIFF_CANCELLED');
    const deadline = setTimeout(() => finish(undefined, 'SOURCE_DIFF_TIMEOUT'), 5000);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    worker.once('error', () => finish()); worker.once('exit', () => { if (!finished) finish(); });
    worker.once('message', (value: { ok?: boolean; diff?: unknown }) => {
      if (value?.ok === true && isSourceDiff(value.diff) && matches(value.diff)) finish(value.diff);
      else finish();
    });
  });
}

type State = Readonly<{ candidate: PatchCandidate; revision: number; phase: string }>;
// At most one worker and one completed snapshot per document. UI loss can leave
// this bounded read running; teardown cancels it and waits for actual termination.
export function createSourceDiffReader(outputRoot: string, source: SourceIndex, read: () => State, prepare = prepareSourceDiff) {
  let closed = false; let closing: Promise<void> | undefined;
  let stopFailed = false;
  let cached: { candidate: PatchCandidate; revision: number; diff: SourceDiff } | null = null;
  let pending: { candidate: PatchCandidate; revision: number; abort: AbortController; result: Promise<SourceDiff> } | null = null;
  const current = (revision: number, hash: string): State => {
    if (stopFailed) throw new Error('SOURCE_DIFF_STOP_FAILED');
    if (closed) throw new Error('SOURCE_DIFF_CANCELLED');
    const state = read();
    if (state.revision !== revision || state.candidate.resultHash !== hash) throw new Error('STALE_SOURCE_DIFF');
    if (state.phase !== 'idle') throw new Error('DRAFT_UNAVAILABLE');
    return state;
  };
  const readDiff = async (revision: number, hash: string): Promise<SourceDiff> => {
    const state = current(revision, hash);
    if (cached?.candidate === state.candidate && cached.revision === revision) return cached.diff;
    if (pending) {
      if (pending.candidate === state.candidate && pending.revision === revision) return pending.result;
      // A new confirmed draft supersedes an old read. Wait for the worker to
      // stop before starting the new one; concurrent latest readers coalesce.
      pending.abort.abort(); await pending.result.catch(() => {}); return readDiff(revision, hash);
    }
    cached = null; const abort = new AbortController();
    const result = Promise.resolve().then(() => prepare(outputRoot, source, state.candidate, abort.signal)).then(diff => {
      if (current(revision, hash).candidate !== state.candidate) throw new Error('STALE_SOURCE_DIFF');
      cached = { candidate: state.candidate, revision, diff }; return diff;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'SOURCE_DIFF_STOP_FAILED') stopFailed = true;
      throw error;
    }).finally(() => { pending = null; });
    pending = { candidate: state.candidate, revision, abort, result }; return result;
  };
  return Object.freeze({ read: readDiff,
    close(): Promise<void> {
      if (!closing) {
        closed = true; cached = null; pending?.abort.abort();
        closing = (pending?.result ?? Promise.resolve()).then(() => {}, () => {}).then(() => {
          if (stopFailed) throw new Error('SOURCE_DIFF_STOP_FAILED');
        });
      }
      return closing;
    },
  });
}
