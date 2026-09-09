import { contextBridge, ipcRenderer } from 'electron';
import { BOOTSTRAP_CHANNEL, CONTRACT_VERSION } from '../contracts/bootstrap.ts';
import type { EditorBootstrap } from '../contracts/bootstrap.ts';
import { EDITOR_COMMAND, EDITOR_CONNECT, EDITOR_STATE, EDITOR_URL, isEditorCommand } from '../contracts/editor.ts';
import type { EditorAPI, EditorCommand, EditorConnection, EditorReply, EditorResult } from '../contracts/editor.ts';
import type { InputSnapshot } from '../contracts/input.ts';
import { WORKSPACE_COMMAND, WORKSPACE_CONNECT, WORKSPACE_STATE, isWorkspaceCommand } from '../contracts/workspace-editor.ts';
import type { WorkspaceAPI, WorkspaceCommand, WorkspaceConnection, WorkspaceReply, WorkspaceResult } from '../contracts/workspace-editor.ts';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';

const bootstrap: EditorBootstrap = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  stage: 'toolchain',
});
contextBridge.exposeInMainWorld('haeBootstrap', bootstrap);
ipcRenderer.send(BOOTSTRAP_CHANNEL, {
  contractVersion: CONTRACT_VERSION,
  surface: 'ui',
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
});

// Trusted UI page scripts get methods, never IPC objects, channels, sender
// events, connection tokens, file paths or arbitrary invoke authority.
if (process.isMainFrame && location.href === EDITOR_URL) {
  let connection: Promise<EditorConnection | null> | undefined;
  let sessionId: string | null = null;
  let sequence = 0;
  let latest: InputSnapshot | null = null;
  const listeners = new Set<(state: InputSnapshot) => void>();
  const accept = (state: InputSnapshot): void => {
    if (latest && state.stateRevision <= latest.stateRevision) return;
    latest = state;
    for (const listener of listeners) { try { listener(state); } catch { /* A UI callback cannot break transport. */ } }
  };
  const connect = (): Promise<EditorConnection | null> => {
    connection ??= ipcRenderer.invoke(EDITOR_CONNECT).then((value: EditorConnection | null) => {
      if (value) { sessionId = value.sessionId; accept(value.state); }
      else connection = undefined;
      return value;
    }, () => { connection = undefined; return null; });
    return connection;
  };
  ipcRenderer.on(EDITOR_STATE, (_event, value: EditorConnection) => {
    if (sessionId && value.sessionId === sessionId) accept(value.state);
  });
  const failure = (code: string): EditorResult => ({ ok: false, code, state: latest, copy: null });
  const request = async (command: EditorCommand): Promise<EditorResult> => {
    if (!isEditorCommand(command)) return failure('INVALID_EDITOR_REQUEST');
    const connected = await connect();
    if (!connected || sequence >= Number.MAX_SAFE_INTEGER) return failure('EDITOR_DISCONNECTED');
    const current = ++sequence;
    try {
      const reply: EditorReply | null = await ipcRenderer.invoke(EDITOR_COMMAND, { sessionId, sequence: current, command });
      if (!reply || reply.sessionId !== sessionId || reply.sequence !== current) return failure('EDITOR_DISCONNECTED');
      if (reply.result.state) accept(reply.result.state);
      return { ...reply.result, state: latest };
    } catch { return failure('EDITOR_DISCONNECTED'); }
  };
  const api: EditorAPI = Object.freeze({
    read: () => request({ kind: 'read' }),
    begin: (value) => request({ kind: 'begin', value }),
    change: (value) => request({ kind: 'change', value }),
    apply: (value) => request({ kind: 'apply', value }),
    resolve: (value) => request({ kind: 'resolve', value }),
    history: (value) => request({ kind: 'history', value }),
    saveCopy: (stateRevision) => request({ kind: 'save-copy', stateRevision }),
    onState: (listener) => {
      if (typeof listener !== 'function' || listeners.size >= 32) throw new Error('INVALID_EDITOR_LISTENER');
      listeners.add(listener);
      if (latest) { try { listener(latest); } catch { /* See accept. */ } }
      return () => { listeners.delete(listener); };
    },
  });
  contextBridge.exposeInMainWorld('haeEditor', api);
}

// Window-scoped API for the unified Main session. The single-document API above
// remains only for earlier experiments; Main installs exactly one transport.
if (process.isMainFrame && location.href === EDITOR_URL) {
  let connection: Promise<WorkspaceConnection | null> | undefined;
  let sessionId: string | null = null;
  let sequence = 0;
  let latest: WorkspaceSnapshot | null = null;
  const listeners = new Set<(state: WorkspaceSnapshot) => void>();
  const accept = (state: WorkspaceSnapshot): void => {
    if (latest && state.stateRevision <= latest.stateRevision) return;
    latest = state;
    for (const listener of listeners) { try { listener(state); } catch { /* Main still owns the state. */ } }
  };
  const connect = (): Promise<WorkspaceConnection | null> => {
    connection ??= ipcRenderer.invoke(WORKSPACE_CONNECT).then((value: WorkspaceConnection | null) => {
      if (value) { sessionId = value.sessionId; accept(value.state); }
      else connection = undefined;
      return value;
    }, () => { connection = undefined; return null; });
    return connection;
  };
  ipcRenderer.on(WORKSPACE_STATE, (_event, value: WorkspaceConnection) => {
    if (sessionId && value.sessionId === sessionId) accept(value.state);
  });
  const failure = (code: string, documentId: string | null): WorkspaceResult =>
    ({ ok: false, code, state: latest, documentId, copy: null, outcome: null });
  const request = async (command: WorkspaceCommand): Promise<WorkspaceResult> => {
    const documentId = command && typeof command === 'object' && 'documentId' in command ? command.documentId : null;
    if (!isWorkspaceCommand(command)) return failure('INVALID_WORKSPACE_REQUEST', documentId);
    const connected = await connect();
    if (!connected || sequence >= Number.MAX_SAFE_INTEGER) return failure('EDITOR_DISCONNECTED', documentId);
    const current = ++sequence;
    try {
      const reply: WorkspaceReply | null = await ipcRenderer.invoke(WORKSPACE_COMMAND, { sessionId, sequence: current, command });
      if (!reply || reply.sessionId !== sessionId || reply.sequence !== current) return failure('EDITOR_DISCONNECTED', documentId);
      if (reply.result.state) accept(reply.result.state);
      // State may already describe a newer document. Per-request documentId and
      // copy/outcome are retained; never attribute an old save to the new page.
      return { ...reply.result, state: latest };
    } catch { return failure('EDITOR_DISCONNECTED', documentId); }
  };
  const api: WorkspaceAPI = Object.freeze({
    read: () => request({ kind: 'read' }),
    listRecovery: () => request({ kind: 'recovery-list' }),
    restore: (recoverySessionId, stateRevision, sourceMode = 'file') => request({ kind: 'restore', recoverySessionId, stateRevision, sourceMode }),
    open: (stateRevision) => request({ kind: 'open', stateRevision }),
    openDirectory: (stateRevision) => request({ kind: 'open-directory', stateRevision }),
    switchEntry: (documentId, stateRevision) => request({ kind: 'switch-entry', documentId, stateRevision }),
    readDiff: (documentId, draftRevision, candidateHash) => request({ kind: 'source-diff', documentId, draftRevision, candidateHash }),
    save: (documentId, stateRevision, review) => request({ kind: 'save', documentId, stateRevision, ...(review === undefined ? {} : { review }) }),
    retryPersistence: (documentId, draftRevision) => request({ kind: 'retry-persistence', documentId, draftRevision }),
    edit: (documentId, value) => request({ kind: 'edit', documentId, value }),
    onState: (listener) => {
      if (typeof listener !== 'function' || listeners.size >= 32) throw new Error('INVALID_EDITOR_LISTENER');
      listeners.add(listener);
      if (latest) { try { listener(latest); } catch { /* See accept. */ } }
      return () => { listeners.delete(listener); };
    },
  });
  contextBridge.exposeInMainWorld('haeWorkspace', api);
}
