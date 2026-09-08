import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { isMappingApply, isMappingApplyResult, isMappingCheckResult, isMappingEvent, MAPPING_APPLY, MAPPING_APPLY_RESULT, MAPPING_CHECK, MAPPING_CHECK_RESULT, MAPPING_EVENT, MAPPING_INSTALL, MAPPING_REVOKE, sameMapping } from '../../contracts/mapping.ts';
import type { MappingApply, MappingApplyOutcome, MappingCheck, MappingEvent, MappingIdentity, MappingSelection } from '../../contracts/mapping.ts';
import { parseSource } from '../parser/parse-source.ts';
import { acceptsPreviewSender } from './authority.ts';
import type { ProjectPreview } from './project-preview.ts';
import { createEditGuard } from './edit-guard.ts';

const installed = new WeakSet<object>();

export async function createPreviewMapping(outputRoot: string, preview: ProjectPreview,
  signal: AbortSignal = new AbortController().signal) {
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
  }, parsing.signal).finally(() => {
    preview.contents.removeListener('destroyed', abortParse);
    signal.removeEventListener('abort', abortParse);
  });
  if (!preview.isActive() || preview.contents.isDestroyed() || signal.aborted) throw new Error('MAPPING_CLOSED');
  const identity: MappingIdentity = Object.freeze({ preview: preview.identity,
    documentId: source.identity.documentId, baseHash: source.baseHash });
  const editableIds = new Set(source.nodes.filter((node) => node.editable).map((node) => node.nodeId));
  let status: 'binding' | 'ready' | 'invalidated' | 'closed' = 'binding';
  let reason: string | null = null;
  let revision = 0;
  let selection: MappingSelection | null = null;
  const listeners = new Set<(event: MappingEvent) => void>();
  const checks = new Map<string, { request: MappingCheck; finish: (valid: boolean) => void }>();
  let mutation: { request: MappingApply; finish: (outcome: MappingApplyOutcome) => void } | undefined;
  let editGuard: ReturnType<typeof createEditGuard> | undefined;
  let finishBinding: () => void = () => {};
  const bound = new Promise<void>((resolveBound) => { finishBinding = resolveBound; });
  const fail = (failure: string): void => {
    status = 'invalidated'; reason = failure; selection = null;
    for (const pending of checks.values()) pending.finish(false);
    mutation?.finish('unknown');
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
    revision = payload.nextRevision;
    selection = Object.freeze({ identity, revision, nodeId: payload.nodeId });
    pending.finish('applied');
    for (const listener of listeners) listener({ kind: 'selection', identity, revision, nodeId: payload.nodeId });
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
    preview.contents.removeListener('destroyed', close);
    signal.removeEventListener('abort', close);
    try { if (!preview.contents.isDestroyed()) preview.contents.send(MAPPING_REVOKE, identity); }
    catch { /* A gone renderer cannot receive revocation; Main cleanup is already complete. */ }
  };
  const timeout = setTimeout(() => fail('MAPPING_BIND_TIMEOUT'), 3000);
  editGuard = createEditGuard(preview, identity, {
    ready: () => active() && status === 'ready', mutating: () => !!mutation,
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
  preview.contents.once('destroyed', close);
  signal.addEventListener('abort', close, { once: true });
  try { preview.contents.send(MAPPING_INSTALL, { identity, tree: source.tree }); }
  catch { close(); throw new Error('MAPPING_CLOSED'); }
  await bound;
  clearTimeout(timeout);
  if (!active()) { close(); throw new Error('MAPPING_CLOSED'); }
  return {
    identity, source,
    get status() { return status; },
    get reason() { return reason; },
    get selection(): MappingSelection | null { return active() && status === 'ready' ? selection : null; },
    get editing() { return editGuard!.state; },
    beginEditing: editGuard.begin, finishEditing: editGuard.finish, onEditState: editGuard.onState,
    onEvent(listener: (event: MappingEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // A point-in-time identity check, not a write lease. applyText performs its own
    // synchronous registry check after Main has prepared a verified byte candidate.
    validateSelection(candidate: MappingSelection): Promise<boolean> {
      if (!active() || status !== 'ready' || checks.size >= 8 || !sameMapping(candidate.identity, identity)
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
      if (!active() || status !== 'ready' || mutation || editGuard?.busy || !isMappingApply(request) || !sameMapping(candidate.identity, identity)
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
    close,
  };
}

export type PreviewMapping = Awaited<ReturnType<typeof createPreviewMapping>>;
