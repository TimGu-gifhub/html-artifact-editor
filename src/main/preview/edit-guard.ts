import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { isMappingEditIntent, isMappingEditRequest, isMappingEditResult, MAPPING_EDIT, MAPPING_EDIT_INTENT, MAPPING_EDIT_RESULT } from '../../contracts/edit-guard.ts';
import type { EditDecision, MappingEditIntent, MappingEditRequest, MappingEditResult } from '../../contracts/edit-guard.ts';
import { sameMapping } from '../../contracts/mapping.ts';
import type { MappingIdentity, MappingSelection } from '../../contracts/mapping.ts';
import { acceptsPreviewSender } from './authority.ts';
import type { ProjectPreview } from './project-preview.ts';

type Port = Readonly<{
  ready: () => boolean; mutating: () => boolean; selection: () => MappingSelection | null; revision: () => number;
  knownId: (nodeId: string) => boolean;
  transition: (nodeId: string | null, revision: number) => void; fail: (reason: string) => void;
}>;
export function createEditGuard(preview: ProjectPreview, identity: MappingIdentity, port: Port) {
  let owner: Readonly<{ token: string; nodeId: string }> | null = null;
  let intent: MappingEditIntent | null = null;
  let lastSequence = 0;
  let closed = false;
  let pending: { request: MappingEditRequest; finish: (value: MappingEditResult | null) => void } | undefined;
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const reset = (): void => {
    owner = null; intent = null;
    pending?.finish(null); notify();
  };
  const onIntent = (event: IpcMainEvent, input: unknown): void => {
    if (closed || !port.ready() || !acceptsPreviewSender(preview, event) || !isMappingEditIntent(input)
      || !sameMapping(input.identity, identity) || !owner || owner.token !== input.editToken || input.sequence <= lastSequence) return;
    if (input.nodeId !== null && !port.knownId(input.nodeId)) return;
    const selected = port.selection();
    if (!selected || selected.nodeId !== owner.nodeId) { port.fail('EDIT_STATE_UNKNOWN'); return; }
    lastSequence = input.sequence;
    intent = Object.freeze({ identity, editToken: owner.token, sequence: input.sequence, nodeId: input.nodeId });
    notify();
  };
  const onResult = (event: IpcMainEvent, input: unknown): void => {
    if (closed || !port.ready() || !acceptsPreviewSender(preview, event) || !isMappingEditResult(input)
      || !sameMapping(input.identity, identity)) return;
    const operation = pending;
    if (!operation || input.requestId !== operation.request.requestId || input.nodeId !== operation.request.nodeId
      || input.revision !== operation.request.revision || input.kind !== operation.request.kind) return;
    if (!input.accepted) { operation.finish(null); return; }
    const request = operation.request;
    if (port.revision() !== request.revision || port.selection()?.nodeId !== request.nodeId) {
      port.fail('EDIT_STATE_UNKNOWN'); return;
    }
    if (request.kind === 'begin') {
      if (owner || input.editToken !== request.requestId || input.nextRevision !== request.revision || input.nextNodeId !== request.nodeId) {
        port.fail('EDIT_STATE_UNKNOWN'); return;
      }
      owner = Object.freeze({ token: request.requestId, nodeId: request.nodeId }); intent = null;
    } else {
      const stay = request.decision === 'stay';
      const target = request.decision === 'accept' ? intent?.nodeId : request.nodeId;
      if (!owner || request.editToken !== owner.token || request.intentSequence !== (intent?.sequence ?? null)
        || target === undefined || input.nextNodeId !== target || input.nextRevision !== request.revision + (stay ? 0 : 1)
        || input.editToken !== (stay ? owner.token : null)) { port.fail('EDIT_STATE_UNKNOWN'); return; }
      intent = null;
      if (!stay) owner = null;
      if (!stay) port.transition(input.nextNodeId, input.nextRevision);
    }
    operation.finish(input); notify();
  };
  ipcMain.on(MAPPING_EDIT_INTENT, onIntent);
  ipcMain.on(MAPPING_EDIT_RESULT, onResult);
  const request = (value: MappingEditRequest): Promise<MappingEditResult | null> => {
    const selected = port.selection();
    if (closed || !port.ready() || port.mutating() || pending || !selected || !isMappingEditRequest(value)
      || !sameMapping(value.identity, identity) || value.nodeId !== selected.nodeId || value.revision !== selected.revision) return Promise.resolve(null);
    return new Promise((resolveResult) => {
      const deadline = setTimeout(() => port.fail('EDIT_STATE_UNKNOWN'), 2000);
      const finish = (result: MappingEditResult | null): void => {
        clearTimeout(deadline); pending = undefined; resolveResult(result);
      };
      pending = { request: value, finish };
      try { preview.contents.send(MAPPING_EDIT, value); } catch { port.fail('EDIT_STATE_UNKNOWN'); }
    });
  };
  return {
    get busy() { return !!pending; },
    get state() { return owner ? Object.freeze({ ...owner, intent }) : null; },
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async begin(selection: MappingSelection): Promise<string | null> {
      if (owner) return null;
      const result = await request(Object.freeze({ ...selection, requestId: randomUUID(), kind: 'begin' }));
      return result?.editToken ?? null;
    },
    async finish(token: string, decision: EditDecision, sequence: number | null): Promise<boolean> {
      const selected = port.selection();
      if (!owner || owner.token !== token || !selected || sequence !== (intent?.sequence ?? null)
        || (decision === 'accept' && !intent)) return false;
      return (await request(Object.freeze({ ...selected, kind: 'finish', requestId: randomUUID(),
        editToken: token, decision, intentSequence: sequence }))) !== null;
    },
    reset,
    close(): void {
      if (closed) return;
      closed = true; reset(); listeners.clear();
      ipcMain.removeListener(MAPPING_EDIT_INTENT, onIntent); ipcMain.removeListener(MAPPING_EDIT_RESULT, onResult);
    },
  };
}
