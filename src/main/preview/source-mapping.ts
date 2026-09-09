import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { isMappingApply, isMappingApplyResult, isMappingCheckResult, isMappingEvent, MAPPING_APPLY, MAPPING_APPLY_RESULT, MAPPING_CHECK, MAPPING_CHECK_RESULT, MAPPING_EVENT, MAPPING_INSTALL, MAPPING_REVOKE, sameMapping } from '../../contracts/mapping.ts';
import type { MappingApply, MappingApplyOutcome, MappingCheck, MappingEvent, MappingIdentity, MappingSelection } from '../../contracts/mapping.ts';
import { parseSource } from '../parser/parse-source.ts';
import { acceptsPreviewSender } from './authority.ts';
import type { ProjectPreview } from './project-preview.ts';
import { createEditGuard } from './edit-guard.ts';
import { isMappingRestore, isMappingRestoreResult, MAPPING_RESTORE, MAPPING_RESTORE_RESULT } from '../../contracts/mapping-restore.ts';
import type { MappingRestore, MappingRestoreChange } from '../../contracts/mapping-restore.ts';
import { isMappingHistory, isMappingHistoryResult, MAPPING_HISTORY, MAPPING_HISTORY_RESULT } from '../../contracts/mapping-history.ts';
import type { MappingHistory } from '../../contracts/mapping-history.ts';
import type { SourceLineage } from '../../core/parser/source-index.ts';

const installed = new WeakSet<object>();

export async function createPreviewMapping(outputRoot: string, preview: ProjectPreview,
  signal: AbortSignal = new AbortController().signal, lineage?: SourceLineage) {
  if (preview.identity.mode !== 'proofread') throw new Error('INTERACTIVE_PREVIEW_READ_ONLY');
  if (installed.has(preview.contents)) throw new Error('MAPPING_ALREADY_INSTALLED');
  installed.add(preview.contents);
  const parsing = new AbortController();
  const abortParse = (): void => parsing.abort();
  preview.contents.once('destroyed', abortParse);
  signal.addEventListener('abort', abortParse, { once: true });
  if (signal.aborted || !preview.isActive() || preview.contents.isDestroyed()) parsing.abort();
  const source = await parseSource(outputRoot, preview.sourceBytes(), {
    projectId: preview.identity.sessionId, documentId: randomUUID(), generation: preview.identity.generation,
  }, parsing.signal, lineage).finally(() => {
    preview.contents.removeListener('destroyed', abortParse);
    signal.removeEventListener('abort', abortParse);
  });
  if (!preview.isActive() || preview.contents.isDestroyed() || signal.aborted) throw new Error('MAPPING_CLOSED');
  const identity: MappingIdentity = Object.freeze({ preview: preview.identity,
    documentId: source.identity.documentId, baseHash: source.baseHash });
  const editableIds = new Map(source.nodes.filter((node) => node.editable).map((node) => [node.nodeId, node.decodedText]));
  let status: 'binding' | 'ready' | 'invalidated' | 'closed' = 'binding';
  let reason: string | null = null;
  let revision = 0;
  let selection: MappingSelection | null = null;
  const listeners = new Set<(event: MappingEvent) => void>();
  const checks = new Map<string, { request: MappingCheck; finish: (valid: boolean) => void }>();
  let mutation: { request: MappingApply; finish: (outcome: MappingApplyOutcome) => void } | undefined;
  let restoration: { request: MappingRestore; finish: (outcome: MappingApplyOutcome) => void } | undefined;
  let historical: { request: MappingHistory; finish: (outcome: MappingApplyOutcome) => void } | undefined;
  let editGuard: ReturnType<typeof createEditGuard> | undefined;
  let finishBinding: () => void = () => {};
  const bound = new Promise<void>((resolveBound) => { finishBinding = resolveBound; });
  const fail = (failure: string): void => {
    status = 'invalidated'; reason = failure; selection = null;
    for (const pending of checks.values()) pending.finish(false);
    mutation?.finish('unknown');
    restoration?.finish('unknown');
    historical?.finish('unknown');
    editGuard?.reset();
    finishBinding();
  };
  const active = (): boolean => preview.isActive() && !preview.contents.isDestroyed() && !signal.aborted && status !== 'closed';
  const onEvent = (event: IpcMainEvent, payload: unknown): void => {
    if (!active() || !acceptsPreviewSender(preview, event) || !isMappingEvent(payload)
      || !sameMapping(payload.identity, identity) || payload.revision !== revision + 1) return;
    if (payload.kind === 'ready') {
      if (status !== 'binding' || payload.revision !== 1 || payload.editableCount !== editableIds.size) return;
      status = 'ready'; finishBinding();
    } else if (payload.kind === 'invalidated') {
      if (status !== 'binding' && status !== 'ready') return;
      fail(payload.reason);
    } else {
      if (status !== 'ready' || (payload.nodeId !== null && !editableIds.has(payload.nodeId))) return;
      selection = payload.nodeId === null ? null : Object.freeze({ identity, revision: payload.revision, nodeId: payload.nodeId });
    }
    revision = payload.revision;
    for (const listener of listeners) listener(payload);
  };
  const onCheck = (event: IpcMainEvent, payload: unknown): void => {
    if (!active() || !acceptsPreviewSender(preview, event) || !isMappingCheckResult(payload) || !sameMapping(payload.identity, identity)) return;
    const pending = checks.get(payload.requestId);
    if (!pending || pending.request.nodeId !== payload.nodeId || pending.request.revision !== payload.revision) return;
    pending.finish(payload.valid && status === 'ready' && selection?.revision === payload.revision && selection.nodeId === payload.nodeId);
  };
  const onApply = (event: IpcMainEvent, payload: unknown): void => {
    if (!active() || !acceptsPreviewSender(preview, event) || !isMappingApplyResult(payload)
      || !sameMapping(payload.identity, identity)) return;
    const pending = mutation;
    if (!pending || pending.request.requestId !== payload.requestId || pending.request.nodeId !== payload.nodeId
      || pending.request.revision !== payload.revision) return;
    if (payload.outcome === 'rejected') { pending.finish('rejected'); return; }
    if (payload.outcome !== 'applied' || status !== 'ready' || revision !== payload.revision
      || payload.nextRevision !== revision + 1 || selection?.nodeId !== payload.nodeId) {
      fail('DRAFT_OUTCOME_UNKNOWN'); return;
    }
    editableIds.set(payload.nodeId, pending.request.newText);
    revision = payload.nextRevision;
    selection = Object.freeze({ identity, revision, nodeId: payload.nodeId });
    pending.finish('applied');
    for (const listener of listeners) listener({ kind: 'selection', identity, revision, nodeId: payload.nodeId });
  };
  const onRestore = (event: IpcMainEvent, payload: unknown): void => {
    if (!active() || !acceptsPreviewSender(preview, event) || !isMappingRestoreResult(payload) || !sameMapping(payload.identity, identity)) return;
    const pending = restoration;
    if (!pending || pending.request.requestId !== payload.requestId || pending.request.revision !== payload.revision) return;
    if (payload.outcome === 'rejected') { pending.finish('rejected'); return; }
    if (payload.outcome !== 'applied' || status !== 'ready' || revision !== 1 || payload.nextRevision !== 2 || selection !== null) {
      fail('DRAFT_RESTORE_OUTCOME_UNKNOWN'); return;
    }
    for (const change of pending.request.changes) editableIds.set(change.nodeId, change.newText);
    revision = 2; pending.finish('applied');
    for (const listener of listeners) listener({ kind: 'selection', identity, revision, nodeId: null });
  };
  const onHistory = (event: IpcMainEvent, payload: unknown): void => {
    if (!active() || !acceptsPreviewSender(preview, event) || !isMappingHistoryResult(payload) || !sameMapping(payload.identity, identity)) return;
    const pending = historical;
    if (!pending || pending.request.requestId !== payload.requestId || pending.request.nodeId !== payload.nodeId
      || pending.request.revision !== payload.revision) return;
    if (payload.outcome === 'rejected') { pending.finish('rejected'); return; }
    if (payload.outcome !== 'applied' || status !== 'ready' || revision !== payload.revision || payload.nextRevision !== revision + 1) {
      fail('HISTORY_OUTCOME_UNKNOWN'); return;
    }
    editableIds.set(payload.nodeId, pending.request.newText);
    revision = payload.nextRevision; selection = null; pending.finish('applied');
    for (const listener of listeners) listener({ kind: 'selection', identity, revision, nodeId: null });
  };
  const close = (): void => {
    if (status === 'closed') return;
    fail('CLOSED'); status = 'closed';
    editGuard?.close();
    clearTimeout(timeout);
    listeners.clear();
    ipcMain.removeListener(MAPPING_EVENT, onEvent);
    ipcMain.removeListener(MAPPING_CHECK_RESULT, onCheck);
    ipcMain.removeListener(MAPPING_APPLY_RESULT, onApply);
    ipcMain.removeListener(MAPPING_RESTORE_RESULT, onRestore);
    ipcMain.removeListener(MAPPING_HISTORY_RESULT, onHistory);
    preview.contents.removeListener('destroyed', close);
    signal.removeEventListener('abort', close);
    try { if (!preview.contents.isDestroyed()) preview.contents.send(MAPPING_REVOKE, identity); }
    catch { /* A gone renderer cannot receive revocation; Main cleanup is already complete. */ }
  };
  const timeout = setTimeout(() => fail('MAPPING_BIND_TIMEOUT'), 3000);
  editGuard = createEditGuard(preview, identity, {
    ready: () => active() && status === 'ready', mutating: () => !!mutation || !!restoration || !!historical,
    knownId: (nodeId) => editableIds.has(nodeId),
    selection: () => selection, revision: () => revision, fail,
    transition: (nodeId, nextRevision) => {
      if (nodeId !== null && !editableIds.has(nodeId)) { fail('EDIT_STATE_UNKNOWN'); return; }
      revision = nextRevision;
      selection = nodeId === null ? null : Object.freeze({ identity, revision, nodeId });
      for (const listener of listeners) listener({ kind: 'selection', identity, revision, nodeId });
    },
  });
  ipcMain.on(MAPPING_EVENT, onEvent);
  ipcMain.on(MAPPING_CHECK_RESULT, onCheck);
  ipcMain.on(MAPPING_APPLY_RESULT, onApply);
  ipcMain.on(MAPPING_RESTORE_RESULT, onRestore);
  ipcMain.on(MAPPING_HISTORY_RESULT, onHistory);
  preview.contents.once('destroyed', close);
  signal.addEventListener('abort', close, { once: true });
  try { preview.contents.send(MAPPING_INSTALL, { identity, tree: source.tree, ...(source.lineage ? {
    emptyTextIndices: source.nodes.filter(node => node.editable && node.startByte === node.endByte).map(node => node.treeIndex),
  } : {}) }); }
  catch { close(); throw new Error('MAPPING_CLOSED'); }
  await bound;
  clearTimeout(timeout);
  if (!active()) { close(); throw new Error('MAPPING_CLOSED'); }
  return {
    identity, source,
    get status() { return status; },
    get reason() { return reason; },
    get revision() { return revision; },
    get selection(): MappingSelection | null { return active() && status === 'ready' ? selection : null; },
    get editing() { return editGuard!.state; },
    beginEditing: editGuard.begin, finishEditing: editGuard.finish, onEditState: editGuard.onState,
    onEvent(listener: (event: MappingEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // A point-in-time identity check, not a write lease. applyText performs its own
    // synchronous registry check after Main has prepared a verified byte candidate.
    validateSelection(candidate: MappingSelection): Promise<boolean> {
      if (!active() || status !== 'ready' || restoration || historical || checks.size >= 8 || !sameMapping(candidate.identity, identity)
        || candidate.nodeId !== selection?.nodeId || candidate.revision !== selection.revision) return Promise.resolve(false);
      return new Promise((resolveCheck) => {
        const request = Object.freeze({ ...candidate, requestId: randomUUID() });
        const deadline = setTimeout(() => { finish(false); fail('MAPPING_CHECK_TIMEOUT'); }, 2000);
        const finish = (valid: boolean): void => { clearTimeout(deadline); checks.delete(request.requestId); resolveCheck(valid); };
        checks.set(request.requestId, { request, finish });
        try { preview.contents.send(MAPPING_CHECK, request); } catch { finish(false); fail('CLOSED'); }
      });
    },
    applyText(candidate: MappingSelection, expectedText: string, newText: string): Promise<MappingApplyOutcome> {
      const request = Object.freeze({ ...candidate, requestId: randomUUID(), expectedText, newText });
      if (!active() || status !== 'ready' || mutation || restoration || historical || editGuard?.busy || !isMappingApply(request) || !sameMapping(candidate.identity, identity)
        || candidate.nodeId !== selection?.nodeId || candidate.revision !== selection.revision) return Promise.resolve('rejected');
      return new Promise((resolveApply) => {
        const deadline = setTimeout(() => fail('DRAFT_OUTCOME_UNKNOWN'), 2000);
        const finish = (outcome: MappingApplyOutcome): void => {
          clearTimeout(deadline); mutation = undefined; resolveApply(outcome);
        };
        mutation = { request, finish };
        try { preview.contents.send(MAPPING_APPLY, request); } catch { fail('DRAFT_OUTCOME_UNKNOWN'); }
      });
    },
    restoreTexts(changes: readonly MappingRestoreChange[]): Promise<MappingApplyOutcome> {
      const request: MappingRestore = Object.freeze({ identity, requestId: randomUUID(), revision,
        changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))) });
      if (!active() || status !== 'ready' || revision !== 1 || selection !== null || mutation || restoration || historical
        || editGuard?.busy || editGuard?.state !== null || !isMappingRestore(request)
        || request.changes.some(change => editableIds.get(change.nodeId) !== change.expectedText)) return Promise.resolve('rejected');
      return new Promise(resolveRestore => {
        const deadline = setTimeout(() => fail('DRAFT_RESTORE_OUTCOME_UNKNOWN'), 5000);
        const finish = (outcome: MappingApplyOutcome): void => { clearTimeout(deadline); restoration = undefined; resolveRestore(outcome); };
        restoration = { request, finish };
        try { preview.contents.send(MAPPING_RESTORE, request); } catch { fail('DRAFT_RESTORE_OUTCOME_UNKNOWN'); }
      });
    },
    applyHistory(expectedRevision: number, change: MappingRestoreChange): Promise<MappingApplyOutcome> {
      const request = Object.freeze({ ...change, identity, requestId: randomUUID(), revision: expectedRevision });
      if (!active() || status !== 'ready' || mutation || restoration || historical || editGuard?.busy || editGuard?.state !== null
        || revision !== expectedRevision || !isMappingHistory(request) || editableIds.get(change.nodeId) !== change.expectedText) return Promise.resolve('rejected');
      return new Promise(resolveHistory => {
        const deadline = setTimeout(() => fail('HISTORY_OUTCOME_UNKNOWN'), 2000);
        const finish = (outcome: MappingApplyOutcome): void => { clearTimeout(deadline); historical = undefined; resolveHistory(outcome); };
        historical = { request, finish };
        try { preview.contents.send(MAPPING_HISTORY, request); } catch { fail('HISTORY_OUTCOME_UNKNOWN'); }
      });
    },
    close,
  };
}

export type PreviewMapping = Awaited<ReturnType<typeof createPreviewMapping>>;
