import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { BrowserWindow, session } from 'electron';
import type { DesktopState, PdfOptions, PdfPreview } from '../../contracts/desktop.ts';
import type { Workspace } from '../workspace/controller.ts';
import { lockContents, lockSession, securePreferences } from '../preview/security.ts';
import { createNewFileWriter } from '../../platform/new-file.ts';
import { chooseWhileActive } from '../editor/commands.ts';
import { allowsPdfFrame, allowsPdfResource } from './pdf-policy.ts';

// Only Chromium-generated PDF bytes enter this memory-only viewer. It has no
// preload or Workspace transport, and cannot fetch project files or the network.
export function createPdfController(parent: BrowserWindow, workspace: () => Workspace,
  choose: (name: string) => Promise<string | undefined>, notify: () => void, report: (code: string) => void) {
  const pdfSession = session.fromPartition(`hae-pdf-${randomUUID()}`, { cache: false });
  lockSession(pdfSession);
  let current: Readonly<{ metadata: PdfPreview; bytes: Buffer }> | null = null;
  let viewer: BrowserWindow | null = null;
  let busy = false;
  let disposed = false;
  let exported: DesktopState['pdfExport'] = null;
  const url = (id: string) => `hae-pdf://preview/${id}.pdf`;
  const allowed = (value: string) => allowsPdfResource(value, current ? url(current.metadata.id) : null);
  pdfSession.protocol.handle('hae-pdf', request => {
    if (request.method !== 'GET' || !current || request.url !== url(current.metadata.id)) return new Response(null, { status: 403 });
    return new Response(new Uint8Array(current.bytes), { headers: {
      'Content-Type': 'application/pdf', 'Content-Length': String(current.bytes.length),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  });
  pdfSession.webRequest.onBeforeRequest((request, done) => done({ cancel: request.method !== 'GET' || !allowed(request.url) }));
  const selected = (id: string) => {
    if (disposed || !current || current.metadata.id !== id) throw new Error('STALE_PDF');
    return current;
  };
  const show = async (id: string): Promise<void> => {
    const value = selected(id);
    if (viewer && !viewer.isDestroyed()) { viewer.show(); viewer.focus(); return; }
    const candidate = new BrowserWindow({ parent, title: `${value.metadata.name} · PDF 打印预览`, width: 1000, height: 800,
      minWidth: 640, minHeight: 480, show: false,
      // PDF support is enabled only in this dedicated, non-privileged session.
      // User HTML and trusted editor preferences continue to disable plugins.
      webPreferences: { ...securePreferences, plugins: true, session: pdfSession } });
    viewer = candidate; candidate.setMenu(null); lockContents(candidate.webContents, allowsPdfFrame);
    candidate.once('closed', () => { if (viewer === candidate) viewer = null; });
    try {
      await candidate.loadURL(url(id));
      if (disposed || current !== value || candidate.isDestroyed()) throw new Error('STALE_PDF');
      candidate.show();
    } catch (error) { if (!candidate.isDestroyed()) candidate.destroy(); throw error; }
  };
  return Object.freeze({
    get metadata() { return current?.metadata ?? null; }, get busy() { return busy; },
    get exported() { return exported; }, get window() { return viewer; },
    show,
    async create(documentId: string, draftRevision: number, candidateHash: string, options: PdfOptions,
      active: () => boolean, signal: AbortSignal): Promise<void> {
      if (disposed || busy) throw new Error('PDF_BUSY');
      const owner = workspace(); const document = owner.current;
      if (document?.mode === 'interactive') throw new Error('READ_ONLY_MODE');
      const before = document?.input.snapshot();
      if (!document || document.id !== documentId || before?.draftRevision !== draftRevision || before.candidateHash !== candidateHash) throw new Error('STALE_SOURCE_DIFF');
      if (owner.snapshot().phase !== 'idle' || before.hasUnappliedInput || before.input?.composing || document.mapping.status !== 'ready') throw new Error('INPUT_FLUSH_REQUIRED');
      const release = document.input.holdDeparture(before.stateRevision);
      busy = true; notify();
      // Do not release the document on timeout while native printing is still
      // unresolved. Its accepted command remains part of runtime disposal.
      const timeout = setTimeout(() => report('PDF_RENDER_TIMEOUT'), 45_000);
      try {
        const bytes = await document.preview.contents.printToPDF({ pageSize: options.paper, landscape: options.landscape,
          printBackground: options.background, displayHeaderFooter: false, preferCSSPageSize: false,
          margins: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 } });
        const after = document.input.snapshot();
        if (disposed || signal.aborted || !active() || owner.current !== document || document.mapping.status !== 'ready'
          || after.draftRevision !== draftRevision || after.candidateHash !== candidateHash) throw new Error('STALE_PDF');
        if (bytes.length > 32 * 1024 * 1024) throw new Error('PDF_TOO_LARGE');
        if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF_RENDER_FAILED');
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        current = Object.freeze({ bytes: Buffer.from(bytes), metadata: Object.freeze({ id: randomUUID(),
          name: document.name.replace(/\.html?$/iu, '') + '.pdf', documentId, draftRevision, candidateHash,
          size: bytes.length, dirty: before.changes.length > 0, options: Object.freeze({ ...options }) }) });
        exported = null; notify();
      } finally { clearTimeout(timeout); release(); busy = false; notify(); }
      await show(current!.metadata.id);
    },
    async export(id: string, active: () => boolean, signal: AbortSignal): Promise<void> {
      if (busy || exported?.status === 'unknown') throw new Error('PDF_BUSY');
      const value = selected(id); busy = true; exported = null; notify();
      try {
        const destination = await chooseWhileActive(() => choose(value.metadata.name), active, signal);
        if (!destination || !active() || signal.aborted) { exported = { status: 'cancelled', name: null, code: null }; return; }
        if (current !== value || disposed) throw new Error('STALE_PDF');
        const writer = await createNewFileWriter(dirname(destination), undefined, 'pdf');
        if (!active() || signal.aborted || current !== value || disposed) { exported = { status: 'cancelled', name: null, code: null }; return; }
        // Once exclusive creation starts, renderer revocation cannot suppress
        // reconciliation or turn an unknown file into an export success.
        const result = await writer.write(destination, value.bytes);
        exported = Object.freeze({ status: result.status, name: basename(result.path), code: result.code });
      } catch { exported = { status: 'failed', name: null, code: 'PDF_EXPORT_FAILED' }; throw new Error('PDF_EXPORT_FAILED'); }
      finally { busy = false; notify(); }
    },
    close(): void {
      if (busy) throw new Error('PDF_BUSY');
      if (exported?.status === 'unknown') throw new Error('PDF_EXPORT_FAILED');
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      current = null; exported = null; notify();
    },
    async dispose(): Promise<void> {
      if (busy) throw new Error('PDF_BUSY');
      disposed = true;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      current = null; pdfSession.protocol.unhandle('hae-pdf');
      await pdfSession.clearCache(); await pdfSession.clearStorageData();
    },
  });
}
