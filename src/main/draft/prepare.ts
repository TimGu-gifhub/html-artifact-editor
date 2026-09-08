import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SourceIndex } from '../../core/parser/source-index.ts';
import type { PatchCandidate, TextChange } from '../../core/patch/engine.ts';

export function freezeCandidate(value: PatchCandidate): PatchCandidate {
  const bytes = new Uint8Array(value.bytes);
  const identity = Object.freeze({ ...value.identity });
  const patches = Object.freeze(value.patches.map((patch) => {
    const replacement = new Uint8Array(patch.replacementBytes);
    return Object.freeze({ ...patch, identity, get replacementBytes() { return new Uint8Array(replacement); } });
  }));
  return Object.freeze({ identity, baseHash: value.baseHash, resultHash: value.resultHash, patches,
    get bytes() { return new Uint8Array(bytes); } });
}

export function prepareDraft(outputRoot: string, source: SourceIndex, current: PatchCandidate, change: TextChange,
  signal: AbortSignal): Promise<PatchCandidate> {
  if (signal.aborted) return Promise.reject(new Error('DRAFT_PREPARE_CANCELLED'));
  return new Promise((resolveCandidate, reject) => {
    const worker = new Worker(resolve(outputRoot, 'draft-worker/index.cjs'), {
      workerData: { bytes: source.bytes, identity: source.identity, patches: current.patches, resultHash: current.resultHash, change },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let finished = false;
    const finish = (candidate?: PatchCandidate, error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (!candidate) { reject(new Error(error ?? 'DRAFT_PREPARE_FAILED')); return; }
        try { resolveCandidate(freezeCandidate(candidate)); } catch { reject(new Error('DRAFT_PREPARE_FAILED')); }
      }, () => reject(new Error('DRAFT_PREPARE_FAILED')));
    };
    const abort = (): void => finish(undefined, 'DRAFT_PREPARE_CANCELLED');
    const deadline = setTimeout(() => finish(undefined, 'DRAFT_PREPARE_TIMEOUT'), 5000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('error', () => finish(undefined, 'DRAFT_PREPARE_FAILED'));
    worker.once('exit', () => { if (!finished) finish(undefined, 'DRAFT_PREPARE_FAILED'); });
    worker.once('message', (result: { ok: boolean; candidate?: PatchCandidate; error?: string }) => {
      if (result.ok && result.candidate) finish(result.candidate); else finish(undefined, result.error);
    });
  });
}
