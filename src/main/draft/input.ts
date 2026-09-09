import { basename } from 'node:path';
import { isInputBegin, isInputChange, isInputResolution, isInputVersion } from '../../contracts/input.ts';
import type { ActiveInput, InputPhase, InputSnapshot, InputVersion } from '../../contracts/input.ts';
import type { NewFileWriter } from '../../platform/new-file.ts';
import type { PreviewMapping } from '../preview/source-mapping.ts';
import type { DraftSession } from './session.ts';
import type { OriginalSaveResult } from '../storage/original.ts';
import type { PatchCandidate } from '../../core/patch/engine.ts';

// Main owns pending input as data. This module renders no controls and grants no
// renderer direct access; a future trusted UI bridge must validate its sender.
export function createInputController(mapping: PreviewMapping, draft: DraftSession) {
  let input: ActiveInput | null = null;
  let phase: InputPhase = 'idle';
  let closed = false;
  let stateRevision = 1;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    ++stateRevision;
    for (const listener of listeners) { try { listener(); } catch { /* A gone UI cannot veto retained Main state. */ } }
  };
  const unsubscribeMapping = mapping.onEvent(notify);
  const unsubscribeEdit = mapping.onEditState(notify);
  const idle = (): void => { if (closed || phase !== 'idle') throw new Error('INPUT_BUSY'); };
  const current = (request: InputVersion): ActiveInput => {
    if (!input || input.editToken !== request.editToken || input.revision !== request.inputRevision) throw new Error('STALE_INPUT');
    return input;
  };
  const notComposing = (value: ActiveInput): void => { if (value.composing) throw new Error('INPUT_COMPOSING'); };
  const ownsSelection = (value: ActiveInput): boolean => mapping.status === 'ready' && mapping.editing?.token === value.editToken
    && mapping.selection?.nodeId === value.nodeId;
  const applyInput = async (value: ActiveInput): Promise<void> => {
    if (!ownsSelection(value)) throw new Error('INPUT_MAPPING_LOST');
    await draft.apply({ selection: mapping.selection, draftRevision: draft.revision, newText: value.text });
    if (closed) throw new Error('INPUT_CLOSED');
    const appliedText = draft.textFor(value.nodeId)!;
    input = Object.freeze({ ...value, text: appliedText, appliedText, revision: value.revision + 1 });
  };
  const finish = (): void => { phase = closed ? 'closed' : 'idle'; notify(); };
  const snapshot = (): InputSnapshot => {
    const selected = mapping.selection;
    const intent = mapping.editing?.intent;
    const copy = draft.lastCopy;
    return Object.freeze({ stateRevision, phase, mappingStatus: mapping.status, mappingReason: mapping.reason,
      selection: selected ? Object.freeze({ reference: selected, text: draft.textFor(selected.nodeId)! }) : null,
      input, hasUnappliedInput: !!input && input.text !== input.appliedText,
      intent: intent ? Object.freeze({ sequence: intent.sequence, nodeId: intent.nodeId,
        text: intent.nodeId === null ? null : draft.textFor(intent.nodeId)! }) : null,
      draftRevision: draft.revision, draftPhase: draft.phase, candidateHash: draft.candidate.resultHash,
      changes: Object.freeze(draft.candidate.patches.map((patch) => Object.freeze({ nodeId: patch.nodeId,
        oldText: patch.expectedText, newText: patch.newText }))),
      lastCopy: copy ? Object.freeze({ status: copy.status, name: basename(copy.path), expectedHash: copy.expectedHash, code: copy.code }) : null,
      canApply: phase === 'idle' && !!input && !input.composing && ownsSelection(input) && draft.phase === 'idle',
      canSaveCopy: phase === 'idle' && (!input || (!input.composing && input.text === input.appliedText)) && draft.phase === 'idle',
    });
  };
  return Object.freeze({
    snapshot,
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Main-only departure hold: keep raw input and mapping alive while private
    // evidence settles. A failed preflight can release it; uncertainty retains it.
    holdDeparture(expectedStateRevision: number): () => void {
      idle();
      if (expectedStateRevision !== stateRevision) throw new Error('STALE_INPUT_STATE');
      if (draft.phase !== 'idle') throw new Error('DRAFT_UNAVAILABLE');
      if (input) notComposing(input);
      phase = 'leaving'; notify();
      return () => { if (!closed && phase === 'leaving') { phase = 'idle'; notify(); } };
    },
    async begin(request: unknown) {
      idle();
      if (!isInputBegin(request) || request.draftRevision !== draft.revision || draft.phase !== 'idle' || input) throw new Error('STALE_INPUT_BEGIN');
      const selected = Object.freeze({ ...request.selection });
      phase = 'beginning'; notify();
      try {
        const editToken = await mapping.beginEditing(selected);
        if (closed) throw new Error('INPUT_CLOSED');
        if (!editToken) throw new Error(mapping.status === 'ready' ? 'STALE_SELECTION' : 'INPUT_MAPPING_LOST');
        const text = draft.textFor(selected.nodeId)!;
        input = Object.freeze({ editToken, nodeId: selected.nodeId, revision: 1, text, appliedText: text, composing: false });
      } finally { finish(); }
      return snapshot();
    },
    change(request: unknown) {
      idle();
      if (!isInputChange(request) || !input || request.editToken !== input.editToken || request.inputRevision !== input.revision + 1) throw new Error('STALE_INPUT');
      // Retain even invalid pending text or input arriving after mapping loss.
      // Core validation runs only on explicit Apply, which may reject safely.
      input = Object.freeze({ ...input, revision: request.inputRevision, text: request.newText, composing: request.composing });
      notify(); return snapshot();
    },
    async apply(request: unknown) {
      idle();
      if (!isInputVersion(request)) throw new Error('STALE_INPUT');
      const value = current(request); notComposing(value);
      phase = 'applying'; notify();
      try { await applyInput(value); } finally { finish(); }
      return snapshot();
    },
    async resolve(request: unknown) {
      idle();
      if (!isInputResolution(request)) throw new Error('STALE_INPUT');
      const value = current(request); notComposing(value);
      if (request.intentSequence !== (mapping.editing?.intent?.sequence ?? null)) throw new Error('STALE_EDIT_INTENT');
      phase = 'resolving'; notify();
      try {
        if (request.decision === 'discard' && mapping.status !== 'ready' && !mapping.editing) {
          input = null; // Explicit input cancellation; candidate/recovery evidence stays in DraftSession.
        } else {
          if (!ownsSelection(value)) throw new Error('INPUT_MAPPING_LOST');
          if (request.decision === 'apply') await applyInput(value);
          const decision = request.decision === 'stay' ? 'stay' : request.intentSequence === null ? 'release' : 'accept';
          if (!await mapping.finishEditing(value.editToken, decision, request.intentSequence)) {
            throw new Error(mapping.status === 'ready' ? 'STALE_EDIT_INTENT' : 'INPUT_MAPPING_LOST');
          }
          if (closed) throw new Error('INPUT_CLOSED');
          if (request.decision !== 'stay') input = null;
        }
      } finally { finish(); }
      return snapshot();
    },
    async saveCopy(expectedStateRevision: number, choose: () => Promise<string | undefined>, writer: NewFileWriter) {
      idle();
      if (expectedStateRevision !== stateRevision) throw new Error('STALE_INPUT_STATE');
      if (input) {
        notComposing(input);
        if (input.text !== input.appliedText) throw new Error('UNAPPLIED_INPUT');
      }
      phase = 'saving'; notify();
      try { return await draft.saveCopy(choose, writer); } finally { finish(); }
    },
    async saveOriginal(expectedStateRevision: number, write: (candidate: PatchCandidate) => Promise<OriginalSaveResult>) {
      idle();
      if (expectedStateRevision !== stateRevision) throw new Error('STALE_INPUT_STATE');
      if (input) { notComposing(input); if (input.text !== input.appliedText) throw new Error('UNAPPLIED_INPUT'); }
      phase = 'saving'; notify();
      try { return await draft.saveOriginal(write); } finally { finish(); }
    },
    close(): void {
      if (closed) return;
      closed = true; phase = 'closed';
      unsubscribeMapping(); unsubscribeEdit();
      draft.close(); mapping.close(); notify(); listeners.clear();
    },
  });
}
export type InputController = ReturnType<typeof createInputController>;
