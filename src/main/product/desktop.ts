import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BrowserWindow } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';
import type { DesktopCommand, DesktopState, PanelMode } from '../../contracts/desktop.ts';
import type { WorkspaceCommand } from '../../contracts/workspace-editor.ts';
import type { WorkspaceBridgeExtension } from '../workspace/bridge.ts';
import type { PersistentWorkspaceSession } from '../workspace/persistent-session.ts';
import { lockContents, securePreferences } from '../preview/security.ts';
import { createPdfController } from './pdf.ts';

// Application-owned layout and auxiliary windows. No renderer chooses a URL,
// path, process, web preference, session, or replacement service.
export function createDesktopController(window: BrowserWindow, outputRoot: string,
  runtime: () => PersistentWorkspaceSession, choosePdf: (name: string) => Promise<string | undefined>) {
  let revision = 1; let panel: PanelMode = 'docked'; let floating: BrowserWindow | null = null;
  let layout: Rectangle = { x: 0, y: 0, width: 0, height: 0 }; let visible = false;
  let disposed = false; let error: string | null = null; let documentId: string | null = null;
  const reviewed = new Map<string, Readonly<{ oldText: string; newText: string }>>();
  const listeners = new Set<() => void>();
  const notify = (): void => { ++revision; for (const listener of listeners) { try { listener(); } catch { /* Main retains state. */ } } };
  const report = (code: string): void => { error = code; notify(); };
  let pendingFlush: Readonly<{ id: string; action: 'close' | 'dock' | 'action'; owner: WebContents; promise: Promise<boolean>; finish: (ready: boolean) => void }> | null = null;
  const owner = (): WebContents => panel === 'floating' && floating && !floating.isDestroyed() ? floating.webContents : window.webContents;
  const cleanInput = (): boolean => {
    const state = runtime().workspace.snapshot(); const input = state.current?.input;
    return state.phase === 'idle' && (!input || (input.phase === 'idle' && input.draftPhase === 'idle'
      && !input.hasUnappliedInput && !input.input?.composing));
  };
  const flush = (action: 'close' | 'dock' | 'action'): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (pendingFlush) return pendingFlush.promise;
    const contents = owner();
    if (contents.isDestroyed()) return Promise.resolve(false);
    const id = randomUUID(); let resolveFlush!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolveFlush = done; });
    const finish = (ready: boolean): void => {
      if (pendingFlush?.id !== id) return;
      clearTimeout(timeout); contents.removeListener('destroyed', lost); contents.removeListener('render-process-gone', lost);
      pendingFlush = null;
      const accepted = ready && !disposed && owner() === contents && cleanInput();
      if (!accepted) error = runtime().workspace.current?.input.snapshot().input?.composing ? 'INPUT_COMPOSING' : 'INPUT_FLUSH_REQUIRED';
      else if (error === 'INPUT_COMPOSING' || error === 'INPUT_FLUSH_REQUIRED') error = null;
      notify(); resolveFlush(accepted);
    };
    const lost = (): void => finish(false);
    const timeout = setTimeout(lost, 10_000);
    pendingFlush = { id, action, owner: contents, promise, finish };
    contents.once('destroyed', lost); contents.once('render-process-gone', lost); notify();
    return promise;
  };
  const pdf = createPdfController(window, () => runtime().workspace, choosePdf, notify, report);
  const role = (contents: WebContents): 'main' | 'editor' => {
    if (contents === window.webContents) return 'main';
    if (floating && !floating.isDestroyed() && contents === floating.webContents) return 'editor';
    throw new Error('DESKTOP_UNAVAILABLE');
  };
  const changePanel = async (mode: PanelMode): Promise<void> => {
    if (disposed || !cleanInput() || pendingFlush) throw new Error('INPUT_FLUSH_REQUIRED');
    if (mode === panel) { if (mode === 'floating') floating?.show(); return; }
    if (mode === 'floating' && (!floating || floating.isDestroyed())) {
      const child = new BrowserWindow({ parent: window, title: '校稿栏 · HTML Artifact Editor', width: 440, height: 720,
        minWidth: 360, minHeight: 480, show: false, webPreferences: { ...securePreferences,
          session: window.webContents.session, preload: resolve(outputRoot, 'preload/ui/index.cjs'), additionalArguments: ['--hae-product'] } });
      floating = child; child.setMenu(null); lockContents(child.webContents);
      const connection = runtime().attachEditor(child.webContents);
      child.on('close', event => {
        if (disposed) return;
        event.preventDefault();
        void flush('dock').then(async ready => { if (ready && !disposed) await setPanel('docked'); }).catch(() => report('INPUT_FLUSH_REQUIRED'));
      });
      child.once('closed', () => { if (floating === child) { floating = null; if (!disposed && panel === 'floating') { panel = 'docked'; report('EDITOR_DISCONNECTED'); } } });
      try { await child.loadURL(EDITOR_URL); }
      catch { connection.close(); if (!child.isDestroyed()) child.destroy(); throw new Error('DESKTOP_UNAVAILABLE'); }
      if (disposed || !cleanInput() || pendingFlush) { child.hide(); throw new Error('INPUT_FLUSH_REQUIRED'); }
    }
    panel = mode; error = null; notify();
    if (mode === 'floating') { floating!.show(); floating!.focus(); }
    else floating?.hide();
  };
  let moving = false;
  const setPanel = async (mode: PanelMode): Promise<void> => {
    if (moving) throw new Error('INPUT_FLUSH_REQUIRED');
    moving = true;
    try { await changePanel(mode); } finally { moving = false; }
  };
  let offWorkspace = (): void => {};
  return Object.freeze({
    report,
    bounds: (): Rectangle => visible ? layout : { x: 0, y: 0, width: 0, height: 0 },
    flush,
    ownedWindows: (): readonly BrowserWindow[] => [floating, pdf.window].filter((value): value is BrowserWindow => !!value && !value.isDestroyed()),
    watch(): void {
      offWorkspace();
      offWorkspace = runtime().workspace.onState(() => {
        const current = runtime().workspace.snapshot().current;
        const priorReview = [...reviewed.keys()].join(',');
        if (documentId !== (current?.id ?? null)) { documentId = current?.id ?? null; reviewed.clear(); }
        const changes = current?.input.changes ?? [];
        for (const [id, proof] of reviewed) {
          const change = changes.find(value => value.nodeId === id);
          if (!change || change.oldText !== proof.oldText || change.newText !== proof.newText) reviewed.delete(id);
        }
        // Workspace listeners can have already published their snapshot. Send
        // a desktop revision after clearing a changed item's review marker.
        if (priorReview !== [...reviewed.keys()].join(',')) notify();
        if (!window.isDestroyed()) window.setTitle(`${changes.length || current?.input.hasUnappliedInput ? '* ' : ''}${current?.name ?? 'HTML Artifact Editor'} · HTML Artifact Editor`);
      });
    },
    extension(contents: WebContents): WorkspaceBridgeExtension {
      const surface = role(contents);
      const snapshot = (): DesktopState => ({ revision, role: surface, panel, reviewed: [...reviewed.keys()],
        flush: pendingFlush && pendingFlush.owner === contents ? { id: pendingFlush.id, action: pendingFlush.action } : null,
        pdf: pdf.metadata, pdfBusy: pdf.busy, pdfExport: pdf.exported, error });
      return Object.freeze({ snapshot,
        onState: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        authorize(command: WorkspaceCommand) {
          if (disposed) throw new Error('DESKTOP_UNAVAILABLE');
          if (command.kind === 'edit' && ['begin', 'change', 'apply', 'resolve'].includes(command.value.kind) && owner() !== contents) throw new Error('EDITOR_NOT_OWNER');
          if (command.kind === 'save') {
            const state = runtime().workspace.snapshot().current;
            if (!state || state.id !== command.documentId || !command.review || state.input.changes.some(change => {
              const proof = reviewed.get(change.nodeId); return !proof || proof.oldText !== change.oldText || proof.newText !== change.newText;
            })) throw new Error('REVIEW_REQUIRED');
          }
        },
        async execute(command: DesktopCommand, active: () => boolean, signal: AbortSignal): Promise<void> {
          switch (command.kind) {
            case 'layout': {
              if (surface !== 'main') throw new Error('EDITOR_NOT_OWNER');
              const bounds = window.getContentBounds(); const x = Math.min(command.x, bounds.width); const y = Math.min(command.y, bounds.height);
              layout = { x, y, width: Math.min(command.width, bounds.width - x), height: Math.min(command.height, bounds.height - y) };
              visible = command.visible; runtime().host.refresh(); break;
            }
            case 'panel': await setPanel(command.mode); break;
            case 'flushed':
              if (!pendingFlush || pendingFlush.id !== command.id || pendingFlush.owner !== contents) throw new Error('INPUT_FLUSH_REQUIRED');
              pendingFlush.finish(command.ready); break;
            case 'flush-input': if (!await flush('action')) throw new Error('INPUT_FLUSH_REQUIRED'); break;
            case 'review': {
              const current = runtime().workspace.snapshot().current;
              if (!current || current.id !== command.documentId || current.input.draftRevision !== command.draftRevision
                || current.input.candidateHash !== command.candidateHash) throw new Error('STALE_SOURCE_DIFF');
              const selected = command.nodeIds.map(id => current.input.changes.find(change => change.nodeId === id));
              if (selected.some(value => !value)) throw new Error('STALE_SOURCE_DIFF');
              reviewed.clear(); for (const change of selected) reviewed.set(change!.nodeId, { oldText: change!.oldText, newText: change!.newText });
              error = null; notify(); break;
            }
            case 'pdf-create': await pdf.create(command.documentId, command.draftRevision, command.candidateHash, command.options, active, signal); break;
            case 'pdf-export': await pdf.export(command.id, active, signal); break;
            case 'pdf-show': await pdf.show(command.id); break;
            case 'pdf-close': pdf.close(); break;
          }
        },
      });
    },
    async dispose(): Promise<void> {
      disposed = true; pendingFlush?.finish(false); offWorkspace();
      if (floating && !floating.isDestroyed()) floating.destroy();
      await pdf.dispose(); listeners.clear();
    },
  });
}
