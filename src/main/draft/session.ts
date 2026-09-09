import { isDraftApply } from '../../contracts/draft.ts';
import { sameMapping } from '../../contracts/mapping.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import type { PreviewMapping } from '../preview/source-mapping.ts';
import { freezeCandidate, prepareDraft } from './prepare.ts';
import type { NewFileOutcome, NewFileWriter } from '../../platform/new-file.ts';
import type { OriginalSaveResult } from '../storage/original.ts';
import { createHash } from 'node:crypto';
import { captureTextIntents } from '../../core/history/checkpoint.ts';
import { captureHistoryIntents } from '../../core/history/persistence.ts';
import type { HistoryCheckpoint } from '../../core/history/timeline.ts';
import type { HistoryController, PreparedHistory } from './history.ts';

type MappingPort = Pick<PreviewMapping, 'source' | 'identity' | 'status' | 'selection' | 'applyText' | 'restoreTexts'>
  & Partial<Pick<PreviewMapping, 'revision' | 'applyHistory'>>;
type Phase = 'idle' | 'preparing' | 'applying' | 'saving' | 'uncertain' | 'closed';
export function createDraftSession(outputRoot: string, mapping: MappingPort, prepare = prepareDraft,
  persistence?: Readonly<{ enqueue: (candidate: PatchCandidate, revision: number, history?: HistoryCheckpoint) => void }>,
  history?: HistoryController) {
  const source = mapping.source;
  let current = freezeCandidate({ identity: source.identity, baseHash: source.baseHash, resultHash: source.baseHash,
    patches: [], bytes: source.bytes });
  let uncertain: PatchCandidate | null = null;
  let uncertainHistory: PreparedHistory | null = null;
  let restored = false;
  let copyOutcome: NewFileOutcome | null = null;
  let revision = 1;
  let phase: Phase = 'idle';
  let closed = false;
  const cancellation = new AbortController();
  const textFor = (nodeId: string, candidate = current): string | undefined =>
    candidate.patches.find((patch) => patch.nodeId === nodeId)?.newText
    ?? source.nodes.find((node) => node.nodeId === nodeId && node.editable)?.decodedText;
  return Object.freeze({
    get candidate(): PatchCandidate { return current; },
    get uncertainCandidate(): PatchCandidate | null { return uncertain; },
    get uncertainHistory(): PreparedHistory | null { return uncertainHistory; },
    get historyReady(): boolean { return history?.available ?? false; },
    historySummary: () => history?.summary() ?? null,
    historyCheckpoint: () => history?.capture(),
    get lastCopy(): NewFileOutcome | null { return copyOutcome; },
    get revision() { return revision; },
    get phase(): Phase { return phase; },
    textFor,
    async restore(candidate: PatchCandidate, restoredRevision: number): Promise<void> {
      if (closed || restored || phase !== 'idle' || revision !== 1 || current.patches.length || mapping.status !== 'ready' || mapping.selection !== null
        || !Number.isSafeInteger(restoredRevision) || restoredRevision < 1 || restoredRevision >= Number.MAX_SAFE_INTEGER) throw new Error('DRAFT_RESTORE_UNAVAILABLE');
      const frozen = freezeCandidate(candidate);
      const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
      if (history && (history.revision !== restoredRevision || history.candidate.resultHash !== frozen.resultHash)) throw new Error('DRAFT_HISTORY_MISMATCH');
      const intents = history ? captureHistoryIntents(source, frozen, history.capture(), hash) : captureTextIntents(source, frozen, hash);
      if (!intents.length && !history) throw new Error('DRAFT_RESTORE_EMPTY');
      phase = 'applying';
      try {
        let outcome;
        try { outcome = intents.length ? await mapping.restoreTexts(intents.map(({ nodeId, expectedText, newText }) => ({ nodeId, expectedText, newText }))) : 'applied'; }
        catch { outcome = 'unknown'; }
        if (outcome === 'unknown' || closed) { uncertain = frozen; phase = 'uncertain'; throw new Error('DRAFT_RESTORE_OUTCOME_UNKNOWN'); }
        if (outcome !== 'applied') throw new Error('DRAFT_RESTORE_REJECTED');
        current = frozen; revision = restoredRevision; restored = true;
        // The existing checkpoint already owns durability. Its validated session
        // and revision seed the queue when the unpublished document is prepared.
      } finally { if (!uncertain) phase = closed ? 'closed' : 'idle'; }
    },
    async apply(input: unknown): Promise<Readonly<{ changed: boolean; draftRevision: number }>> {
      if (closed || phase !== 'idle' || mapping.status !== 'ready') throw new Error('DRAFT_UNAVAILABLE');
      if (!isDraftApply(input) || input.draftRevision !== revision || !sameMapping(input.selection.identity, mapping.identity)) {
        throw new Error('STALE_DRAFT_REQUEST');
      }
      const selection = Object.freeze({ ...input.selection, identity: mapping.identity });
      const requestedText = input.newText;
      if (mapping.selection?.nodeId !== selection.nodeId || mapping.selection.revision !== selection.revision) throw new Error('STALE_SELECTION');
      const expectedText = textFor(selection.nodeId);
      if (expectedText === undefined) throw new Error('TARGET_READ_ONLY');
      phase = 'preparing';
      try {
        const change = {
          identity: source.identity, baseHash: source.baseHash, nodeId: selection.nodeId, expectedText, newText: requestedText,
        };
        const plan = history ? await history.prepareEdit(change) : null;
        const prepared = plan?.candidate ?? await prepare(outputRoot, source, current, change, cancellation.signal);
        if (closed || cancellation.signal.aborted) throw new Error('DRAFT_PREPARE_CANCELLED');
        const newText = textFor(selection.nodeId, prepared)!;
        phase = 'applying';
        let outcome;
        try { outcome = await mapping.applyText(selection, expectedText, newText); }
        catch { outcome = 'unknown'; }
        if (outcome === 'unknown' || closed) {
          uncertain = prepared; uncertainHistory = plan; phase = 'uncertain'; throw new Error('DRAFT_OUTCOME_UNKNOWN');
        }
        if (outcome !== 'applied') throw new Error('STALE_SELECTION');
        const changed = prepared.resultHash !== current.resultHash;
        if (plan) {
          try { history!.commit(plan); }
          catch { uncertain = prepared; uncertainHistory = plan; phase = 'uncertain'; throw new Error('DRAFT_OUTCOME_UNKNOWN'); }
        }
        if (changed) { current = prepared; revision = history?.revision ?? revision + 1; persistence?.enqueue(current, revision, history?.capture()); }
        return Object.freeze({ changed, draftRevision: revision });
      } finally {
        if (!uncertain) phase = closed ? 'closed' : 'idle';
      }
    },
    async moveHistory(expectedRevision: number, direction: 'undo' | 'redo', beforeApply: () => Promise<number>): Promise<void> {
      if (closed || phase !== 'idle' || mapping.status !== 'ready' || !history || !mapping.applyHistory) throw new Error('HISTORY_UNAVAILABLE');
      if (expectedRevision !== revision) throw new Error('STALE_DRAFT_REQUEST');
      // The input owner checks its frozen input/intent before releasing a clean
      // edit guard. It must supply the exact resulting mapping revision.
      phase = 'preparing';
      try {
        const plan = await history.prepareMove(direction);
        if (closed || cancellation.signal.aborted) throw new Error('HISTORY_PREPARE_CANCELLED');
        const mappingRevision = await beforeApply();
        if (closed || cancellation.signal.aborted) throw new Error('HISTORY_PREPARE_CANCELLED');
        if (plan.changes.length !== 1 || mappingRevision !== mapping.revision) throw new Error('STALE_HISTORY_TRANSITION');
        phase = 'applying'; let outcome;
        try { outcome = await mapping.applyHistory(mappingRevision, plan.changes[0]!); }
        catch { outcome = 'unknown'; }
        if (outcome === 'unknown' || closed) {
          uncertain = plan.candidate; uncertainHistory = plan; phase = 'uncertain'; throw new Error('DRAFT_OUTCOME_UNKNOWN');
        }
        if (outcome !== 'applied') throw new Error('STALE_HISTORY_TRANSITION');
        try { history.commit(plan); }
        catch { uncertain = plan.candidate; uncertainHistory = plan; phase = 'uncertain'; throw new Error('DRAFT_OUTCOME_UNKNOWN'); }
        current = plan.candidate; revision = history.revision; persistence?.enqueue(current, revision, history.capture());
      } finally { if (!uncertain) phase = closed ? 'closed' : 'idle'; }
    },
    async saveCopy(choose: () => Promise<string | undefined>, writer: NewFileWriter): Promise<NewFileOutcome | null> {
      if (closed || phase !== 'idle') throw new Error('DRAFT_UNAVAILABLE');
      phase = 'saving';
      try {
        const path = await choose();
        if (closed || !path) return null;
        try { copyOutcome = await writer.write(path, current.bytes); }
        catch { copyOutcome = Object.freeze({ status: 'unknown', path, expectedHash: current.resultHash, code: 'NEW_FILE_WRITE_FAILED' }); }
        if (copyOutcome.status === 'unknown') phase = 'uncertain';
        // A copy does not replace this session's original baseline or clear drafts.
        return copyOutcome;
      } finally { if (copyOutcome?.status !== 'unknown') phase = closed ? 'closed' : 'idle'; }
    },
    async saveOriginal(write: (candidate: PatchCandidate) => Promise<OriginalSaveResult>): Promise<OriginalSaveResult> {
      if (closed || phase !== 'idle' || mapping.status !== 'ready' || (history && !history.available)) throw new Error('DRAFT_UNAVAILABLE');
      phase = 'saving';
      try {
        const result = await write(current);
        // The old mapping cannot edit against an overwritten baseline. A fresh
        // verified document must replace this session; retain these bytes until then.
        if (result.status === 'committed' || result.status === 'unknown' || result.requiresReview) uncertain = current;
        return result;
      } catch {
        uncertain = current;
        return Object.freeze({ status: 'unknown', code: 'SAVE_OUTCOME_UNKNOWN', transactionId: null,
          expectedHash: current.resultHash, cleanupPending: true, requiresReview: true, verifySaved: null });
      } finally { phase = uncertain ? 'uncertain' : closed ? 'closed' : 'idle'; }
    },
    close(): void { closed = true; cancellation.abort(); if (!uncertain && copyOutcome?.status !== 'unknown') phase = 'closed'; },
  });
}
export type DraftSession = ReturnType<typeof createDraftSession>;
