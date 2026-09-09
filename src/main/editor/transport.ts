import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { acceptsEditorSender } from './authority.ts';

const installed = new WeakSet<WebContents>();
type Envelope<Command> = Readonly<{ sessionId: string; sequence: number; command: Command }>;
type ChannelNames = Readonly<{ connect: string; command: string; state: string }>;

// Fixed Main channels and validated commands; no generic renderer IPC API.
// Workspace and single-document experiments share frame/replay/revocation checks.
export function createEditorTransport<State, Command, Result>(contents: WebContents, channels: ChannelNames,
  handlers: Readonly<{
    snapshot: () => State;
    onState: (listener: () => void) => () => void;
    isRequest: (value: unknown) => value is Envelope<Command>;
    execute: (command: Command, active: () => boolean, signal: AbortSignal) => Promise<Result>;
    onRevoke?: () => void;
  }>) {
  if (installed.has(contents) || contents.isDestroyed()) throw new Error('EDITOR_BRIDGE_UNAVAILABLE');
  installed.add(contents);
  const sessionId = randomUUID();
  const lifetime = new AbortController();
  let frame: WebFrameMain | null = null;
  let closed = false;
  let lastSequence = 0;
  let scheduled = false;
  let connectInstalled = false;
  let commandInstalled = false;
  let unsubscribe = (): void => {};
  const executing = new Set<Promise<void>>();
  const authority = { contents, session: contents.session, frame: () => frame, isActive: () => !closed };
  const active = (): boolean => !!frame && acceptsEditorSender(authority,
    { sender: contents, senderFrame: frame } as IpcMainInvokeEvent);
  const close = (): void => {
    if (closed) return;
    closed = true; lifetime.abort(); unsubscribe(); installed.delete(contents);
    if (connectInstalled) contents.ipc.removeHandler(channels.connect);
    if (commandInstalled) contents.ipc.removeHandler(channels.command);
    contents.removeListener('did-start-navigation', onNavigation);
    contents.removeListener('render-process-gone', close); contents.removeListener('destroyed', close);
    try { handlers.onRevoke?.(); } catch { /* Revoked authority stays revoked. */ }
  };
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (frame && mainFrame) close();
  };
  const publish = (): void => {
    if (scheduled || !active()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!active()) return;
      try { frame!.send(channels.state, { sessionId, state: handlers.snapshot() }); }
      catch { close(); }
    });
  };
  try {
    unsubscribe = handlers.onState(publish);
    contents.on('did-start-navigation', onNavigation);
    contents.on('render-process-gone', close); contents.on('destroyed', close);
    contents.ipc.handle(channels.connect, (event, ...args: unknown[]) => {
      if (args.length !== 0 || !acceptsEditorSender(authority, event)) return null;
      frame = event.senderFrame;
      return { sessionId, state: handlers.snapshot() };
    });
    connectInstalled = true;
    contents.ipc.handle(channels.command, async (event, ...args: unknown[]) => {
      if (!frame || !acceptsEditorSender(authority, event) || args.length !== 1 || !handlers.isRequest(args[0])) return null;
      const request = args[0];
      if (request.sessionId !== sessionId || request.sequence <= lastSequence) return null;
      lastSequence = request.sequence;
      let finish!: () => void;
      const done = new Promise<void>(resolveDone => { finish = resolveDone; }); executing.add(done);
      try {
        const result = await handlers.execute(request.command, active, lifetime.signal);
        return active() ? { sessionId, sequence: request.sequence, result } : null;
      } finally { executing.delete(done); finish(); }
    });
    commandInstalled = true;
  } catch (error) { close(); throw error; }
  return Object.freeze({ close,
    // Main teardown calls close first. Revocation removes handlers immediately;
    // already authorized commands must settle even if their renderer is gone.
    async drain(): Promise<void> { await Promise.all(executing); },
    get active() { return active(); }, get closed() { return closed; } });
}
