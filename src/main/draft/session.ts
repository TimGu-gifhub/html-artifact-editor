import { isDraftApply } from '../../contracts/draft.ts';
import { sameMapping } from '../../contracts/mapping.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';
import type { PreviewMapping } from '../preview/source-mapping.ts';
import { freezeCandidate, prepareDraft } from './prepare.ts';
import type { NewFileOutcome, NewFileWriter } from '../../platform/new-file.ts';
import type { OriginalSaveResult } from '../storage/original.ts';
import { createHash } from 'node:crypto';
import { captureTextIntents } from '../../core/history/checkpoint.ts';

type MappingPort = Pick<PreviewMapping, 'source' | 'identity' | 'status' | 'selection' | 'applyText' | 'restoreTexts'>;
type Phase = 'idle' | 'preparing' | 'applying' | 'saving' | 'uncertain' | 'closed';
export function createDraftSession(outputRoot: string, mapping: MappingPort, prepare = prepareDraft,
  persistence?: Readonly<{ enqueue: (candidate: PatchCandidate, revision: number) => void }>) {
  const source = mapping.source;
  let current = freezeCandidate({ identity: source.identity, baseHash: source.baseHash, resultHash: source.baseHash,
    patches: [], bytes: source.bytes });
  let uncertain: PatchCandidate | null = null;
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
    get lastCopy(): NewFileOutcome | null { return copyOutcome; },
    get revision() { return revision; },
    get phase(): Phase { return phase; },
    textFor,
    async restore(candidate: PatchCandidate, restoredRevision: number): Promise<void> {
      if (closed || phase !== 'idle' || revision !== 1 || current.patches.length || mapping.status !== 'ready' || mapping.selection !== null
        || !Number.isSafeInteger(restoredRevision) || restoredRevision < 1 || restoredRevision >= Number.MAX_SAFE_INTEGER) throw new Error('DRAFT_RESTORE_UNAVAILABLE');
      const frozen = freezeCandidate(candidate);
      const intents = captureTextIntents(source, frozen, bytes => createHash('sha256').update(bytes).digest('hex'));
      if (!intents.length) throw new Error('DRAFT_RESTORE_EMPTY');
      phase = 'applying';
      try {
        let outcome;
        try { outcome = await mapping.restoreTexts(intents.map(({ nodeId, expectedText, newText }) => ({ nodeId, expectedText, newText }))); }
        catch { outcome = 'unknown'; }
        if (outcome === 'unknown' || closed) { uncertain = frozen; phase = 'uncertain'; throw new Error('DRAFT_RESTORE_OUTCOME_UNKNOWN'); }
        if (outcome !== 'applied') throw new Error('DRAFT_RESTORE_REJECTED');
        current = frozen; revision = restoredRevision;
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
        const prepared = await prepare(outputRoot, source, current, {
          identity: source.identity, baseHash: source.baseHash, nodeId: selection.nodeId, expectedText, newText: requestedText,
        }, cancellation.signal);
        if (closed || cancellation.signal.aborted) throw new Error('DRAFT_PREPARE_CANCELLED');
        const newText = textFor(selection.nodeId, prepared)!;
        phase = 'applying';
        let outcome;
        try { outcome = await mapping.applyText(selection, expectedText, newText); }
        catch { outcome = 'unknown'; }
        if (outcome === 'unknown') {
          uncertain = prepared; phase = 'uncertain'; throw new Error('DRAFT_OUTCOME_UNKNOWN');
        }
        if (outcome !== 'applied') throw new Error('STALE_SELECTION');
        const changed = prepared.resultHash !== current.resultHash;
        if (changed) { current = prepared; ++revision; persistence?.enqueue(current, revision); }
        return Object.freeze({ changed, draftRevision: revision });
      } finally {
        if (!uncertain) phase = closed ? 'closed' : 'idle';
      }
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
      if (closed || phase !== 'idle' || mapping.status !== 'ready') throw new Error('DRAFT_UNAVAILABLE');
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
