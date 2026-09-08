import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { app, ipcMain, session, WebContentsView } from 'electron';
import type { IpcMainEvent } from 'electron';
import type { PreviewIdentity, PreviewMode, PreviewReady } from '../../contracts/preview.ts';
import { PREVIEW_ARGUMENT, PREVIEW_READY_CHANNEL } from '../../contracts/preview.ts';
import { authorizeProject } from '../protocol/project-files.ts';
import { registerProjectProtocol } from '../protocol/project-protocol.ts';
import { acceptsPreviewReady } from './authority.ts';
import { installDocumentGuard, verifyDocumentGuard, lockContents, lockSession, securePreferences } from './security.ts';

export async function createProjectPreview(
  outputRoot: string, entryPath: string, mode: PreviewMode = 'proofread', generation = 1,
  signal: AbortSignal = new AbortController().signal,
) {
  if (!['proofread', 'interactive'].includes(mode) || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('INVALID_PREVIEW_IDENTITY');
  }
  signal.throwIfAborted();
  const grant = await authorizeProject(entryPath, [app.getPath('userData'), app.getPath('sessionData')]);
  signal.throwIfAborted();
  const identity: PreviewIdentity = Object.freeze({ version: 1, sessionId: randomUUID(), generation, mode });
  const previewSession = session.fromPartition(`hae-project-${identity.sessionId}`, { cache: false });
  lockSession(previewSession);
  const resources = await registerProjectProtocol(previewSession, grant, identity);
  if (signal.aborted) { resources.revoke(); signal.throwIfAborted(); }
  const view = new WebContentsView({ webPreferences: {
    ...securePreferences, devTools: false, session: previewSession,
    preload: resolve(outputRoot, 'preload/preview/index.cjs'),
    additionalArguments: [`${PREVIEW_ARGUMENT}${JSON.stringify(identity)}`],
  } });
  const contents = view.webContents;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    resources.revoke(); // Synchronous revocation before any destruction/cleanup await.
    const destroyed = contents.isDestroyed() ? Promise.resolve() : once(contents, 'destroyed');
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    closing = (async () => {
      await destroyed;
      await previewSession.closeAllConnections();
      await previewSession.clearStorageData();
      await previewSession.clearCache();
    })();
    return closing;
  };
  const abort = (): void => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  const startupTimeout = setTimeout(abort, 15_000);
  contents.once('destroyed', () => { resources.revoke(); signal.removeEventListener('abort', abort); });
  lockContents(contents);
  try {
    // Start a renderer on a trusted empty document before issuing CDP commands.
    // No project HTML is loaded until the guard has been installed successfully.
    await contents.loadURL('about:blank');
    await installDocumentGuard(contents, resources.revoke);
    signal.throwIfAborted();
    const ready = new Promise<PreviewReady>((resolveReady, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        ipcMain.removeListener(PREVIEW_READY_CHANNEL, onReady);
        contents.removeListener('destroyed', onDestroyed);
        contents.removeListener('preload-error', onError);
      };
      const onReady = (event: IpcMainEvent, payload: unknown): void => {
        if (!acceptsPreviewReady({ contents, session: previewSession, url: resources.url, identity,
          isActive: resources.isActive }, event, payload)) return;
        cleanup(); resolveReady(payload as PreviewReady);
      };
      const onDestroyed = (): void => { cleanup(); reject(new Error('PREVIEW_CLOSED')); };
      const onError = (): void => { cleanup(); reject(new Error('PREVIEW_PRELOAD_FAILED')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('PREVIEW_STARTUP_TIMEOUT')); }, 15_000);
      ipcMain.on(PREVIEW_READY_CHANNEL, onReady);
      contents.once('destroyed', onDestroyed);
      contents.once('preload-error', onError);
    });
    const [acknowledgement] = await Promise.all([ready, contents.loadURL(resources.url)]);
    await verifyDocumentGuard(contents);
    signal.throwIfAborted();
    if (!resources.isActive()) throw new Error('PREVIEW_CLOSED');
    signal.removeEventListener('abort', abort);
    return { view, contents, session: previewSession, identity, url: resources.url,
      acknowledgement, sourceBytes: resources.snapshot, diagnostics: resources.diagnostics,
      isActive: resources.isActive, close };
  } catch (error) {
    await close();
    throw error;
  } finally { clearTimeout(startupTimeout); signal.removeEventListener('abort', abort); }
}

export type ProjectPreview = Awaited<ReturnType<typeof createProjectPreview>>;

// Main owns switching. Failed/cancelled loads keep the last successfully loaded view.
export class PreviewController {
  current: ProjectPreview | undefined;
  #generation = 0;
  #pending: AbortController | undefined;
  #closed = false;
  constructor(readonly outputRoot: string) {}

  async open(entryPath: string, mode: PreviewMode = 'proofread'): Promise<ProjectPreview> {
    if (this.#closed) throw new Error('PREVIEW_CLOSED');
    this.#pending?.abort();
    const pending = new AbortController();
    this.#pending = pending;
    try {
      const candidate = await createProjectPreview(this.outputRoot, entryPath, mode, ++this.#generation, pending.signal);
      if (this.#closed || this.#pending !== pending) {
        await candidate.close();
        throw new Error('STALE_PREVIEW');
      }
      const previous = this.current;
      this.current = candidate;
      if (previous) await previous.close();
      if (this.#closed || this.current !== candidate) throw new Error('STALE_PREVIEW');
      return candidate;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#pending?.abort();
    this.#pending = undefined;
    const current = this.current;
    this.current = undefined;
    await current?.close();
  }
}
