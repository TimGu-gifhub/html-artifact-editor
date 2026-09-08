import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { EDITOR_COMMAND, EDITOR_CONNECT, EDITOR_STATE, isEditorRequest } from '../../contracts/editor.ts';
import type { EditorCopyResult, EditorReply } from '../../contracts/editor.ts';
import type { NewFileWriter } from '../../platform/new-file.ts';
import type { InputController } from '../draft/input.ts';
import { acceptsEditorSender } from './authority.ts';

const installed = new WeakSet<WebContents>();
const publicErrors = new Set(['INPUT_BUSY', 'STALE_INPUT', 'INPUT_COMPOSING', 'INPUT_MAPPING_LOST', 'INPUT_CLOSED',
  'STALE_INPUT_BEGIN', 'STALE_SELECTION', 'STALE_EDIT_INTENT', 'STALE_INPUT_STATE', 'UNAPPLIED_INPUT',
  'DRAFT_UNAVAILABLE', 'STALE_DRAFT_REQUEST', 'TARGET_READ_ONLY', 'DRAFT_PREPARE_CANCELLED',
  'DRAFT_PREPARE_FAILED', 'DRAFT_PREPARE_TIMEOUT', 'DRAFT_OUTCOME_UNKNOWN', 'INVALID_TEXT_NUL',
  'INVALID_UNICODE', 'TEXT_SIZE_LIMIT', 'PATCH_COUNT_LIMIT', 'CANDIDATE_SIZE_LIMIT']);

// One Main-selected UI WebContents, loaded page and InputController per bridge.
// Install before loading the trusted page. The first valid handshake pins its
// main frame; no global ipcMain handler or renderer-supplied file authority.
export function createEditorBridge(contents: WebContents, input: InputController,
  chooseCopy: () => Promise<string | undefined>, writer: NewFileWriter) {
  if (installed.has(contents) || contents.isDestroyed()) throw new Error('EDITOR_BRIDGE_UNAVAILABLE');
  installed.add(contents);
  const sessionId = randomUUID();
  const capturedSession = contents.session;
  let frame: WebFrameMain | null = null;
  let closed = false;
  let lastSequence = 0;
  let scheduled = false;
  const authority = { contents, session: capturedSession, frame: () => frame, isActive: () => !closed };
  const active = (): boolean => !!frame && acceptsEditorSender(authority,
    { sender: contents, senderFrame: frame } as IpcMainInvokeEvent);
  const publish = (): void => {
    if (scheduled || !active()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!active()) return;
      try { frame!.send(EDITOR_STATE, { sessionId, state: input.snapshot() }); }
      catch { close(); }
    });
  };
  const unsubscribe = input.onState(publish);
  const close = (): void => {
    if (closed) return;
    closed = true; unsubscribe(); installed.delete(contents);
    contents.ipc.removeHandler(EDITOR_CONNECT); contents.ipc.removeHandler(EDITOR_COMMAND);
    contents.removeListener('did-start-navigation', onNavigation);
    contents.removeListener('render-process-gone', close); contents.removeListener('destroyed', close);
    // Revocation never discards Main input/candidates or interrupts a started write.
  };
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (frame && mainFrame) close();
  };
  contents.on('did-start-navigation', onNavigation);
  contents.on('render-process-gone', close); contents.on('destroyed', close);
  contents.ipc.handle(EDITOR_CONNECT, (event, ...args: unknown[]) => {
    if (args.length !== 0 || !acceptsEditorSender(authority, event)) return null;
    frame = event.senderFrame;
    return { sessionId, state: input.snapshot() };
  });
  contents.ipc.handle(EDITOR_COMMAND, async (event, ...args: unknown[]): Promise<EditorReply | null> => {
    if (!frame || !acceptsEditorSender(authority, event) || args.length !== 1 || !isEditorRequest(args[0])) return null;
    const request = args[0];
    if (request.sessionId !== sessionId || request.sequence <= lastSequence) return null;
    // Constant-space replay protection. Gaps are allowed so a locally rejected
    // payload cannot force a retry of a previous application-level operation.
    lastSequence = request.sequence;
    let code: string | null = null;
    let copy: EditorCopyResult | null = null;
    try {
      const command = request.command;
      switch (command.kind) {
        case 'read': break;
        case 'begin': await input.begin(command.value); break;
        case 'change': input.change(command.value); break;
        case 'apply': await input.apply(command.value); break;
        case 'resolve': await input.resolve(command.value); break;
        case 'save-copy': {
          const outcome = await input.saveCopy(command.stateRevision, async () => {
            if (!active()) return undefined;
            const path = await chooseCopy();
            return active() ? path : undefined;
          }, writer);
          copy = outcome ? input.snapshot().lastCopy! : { status: 'cancelled' };
          if (outcome?.status === 'failed') code = 'COPY_FAILED';
          if (outcome?.status === 'unknown') code = 'COPY_OUTCOME_UNKNOWN';
          break;
        }
      }
    } catch (error) {
      code = error instanceof Error && publicErrors.has(error.message) ? error.message : 'EDITOR_COMMAND_FAILED';
    }
    if (!active()) return null;
    return { sessionId, sequence: request.sequence, result: { ok: code === null, code, state: input.snapshot(), copy } };
  });
  return Object.freeze({ close, get active() { return active(); } });
}
