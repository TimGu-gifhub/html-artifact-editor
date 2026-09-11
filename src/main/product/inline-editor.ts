import { resolve } from 'node:path';
import { BrowserWindow } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';
import type { InlineTextPlacement } from '../../contracts/inline-text.ts';
import type { Workspace } from '../workspace/controller.ts';
import { lockContents, securePreferences } from '../preview/security.ts';

// A trusted, frameless input at the proven Text's location. The original DOM
// stays under the existing strict mutation guard; only confirmed Apply changes
// Text.data. This window uses the same InputController, never a page API.
export function createInlineEditor(parent: BrowserWindow, outputRoot: string, ports: Readonly<{
  workspace: () => Workspace | null; enabled: () => boolean; bounds: () => Rectangle;
  attach: (contents: WebContents) => void; notify: () => void;
  close: () => Promise<void>; fail: () => void;
}>) {
  let window: BrowserWindow | null = null, creating: Promise<void> | null = null;
  let disposed = false, failed = false, placement: InlineTextPlacement | null = null;
  let requested: InlineTextPlacement | null = null, pending = false;
  let lastFocus = '';
  const hide = () => { if (window && !window.isDestroyed()) window.hide(); };
  const render = () => {
    const current = ports.workspace()?.current, bounds = ports.bounds();
    const active = current?.mode === 'proofread' ? current.input.snapshot().input : null;
    if (pending && !active?.composing) {
      pending = false;
      const value = requested ?? (placement && active && current?.id === placement.documentId && active.nodeId === placement.nodeId
        ? { ...placement, detached: true } : null);
      if (JSON.stringify(value) !== JSON.stringify(placement)) { placement = value; ports.notify(); }
    }
    if (!window || window.isDestroyed() || creating || disposed || failed || !ports.enabled()
      || current?.mode !== 'proofread' || placement?.documentId !== current.id || !bounds.width || !bounds.height
      || !parent.isVisible() || parent.isMinimized() || ports.workspace()?.snapshot().phase !== 'idle') { hide(); return; }
    // Keep a failed binding visible and copyable; Main still rejects edits when
    // its mapping is invalidated. Never transfer ownership on renderer failure.
    if (current.mapping.status !== 'ready' && !window.isVisible()) return;
    if (!active || active.nodeId !== placement.nodeId) { hide(); return; }
    if (!active?.composing) {
      const outer = parent.getContentBounds(), rect = placement.rect;
      const nextBounds = placement.detached ? {
        x: Math.floor(outer.x + bounds.x + 8), y: Math.floor(outer.y + bounds.y + 8),
        width: Math.max(8, Math.min(440, bounds.width - 16)), height: Math.max(8, Math.min(180, bounds.height - 16)),
      } : { x: Math.floor(outer.x + bounds.x + rect.x) - 2,
        y: Math.floor(outer.y + bounds.y + rect.y) - 2,
        width: Math.max(8, Math.ceil(rect.width) + 5), height: Math.max(8, Math.ceil(rect.height) + 5) };
      const old = window.getBounds();
      if (old.x !== nextBounds.x || old.y !== nextBounds.y || old.width !== nextBounds.width || old.height !== nextBounds.height) window.setBounds(nextBounds);
    }
    const focus = `${placement.documentId}:${placement.nodeId}:${placement.activation}`;
    if (!window.isVisible()) window.showInactive();
    if (focus !== lastFocus && !active?.composing && current.mapping.status === 'ready') {
      lastFocus = focus; window.show(); window.focus(); window.webContents.focus();
    }
  };
  const create = async () => {
    if (disposed || failed || (window && !window.isDestroyed())) return;
    creating ??= (async () => {
      const child = new BrowserWindow({ parent, title: '原位文字编辑', frame: false, transparent: true,
        backgroundColor: '#00000000', show: false, skipTaskbar: true, hasShadow: false, resizable: false,
        width: 8, height: 8, webPreferences: { ...securePreferences, session: parent.webContents.session,
          preload: resolve(outputRoot, 'preload/ui/index.cjs'), additionalArguments: ['--hae-product'] } });
      window = child; child.setMenu(null); lockContents(child.webContents); ports.attach(child.webContents);
      child.on('close', event => { if (!disposed) { event.preventDefault(); void ports.close().catch(ports.fail); } });
      child.webContents.on('render-process-gone', () => { failed = true; hide(); ports.fail(); });
      await child.loadURL(EDITOR_URL);
      child.setTitle('原位文字编辑');
    })().catch(error => { failed = true; hide(); ports.fail(); throw error; })
      .finally(() => { creating = null; render(); });
    await creating;
  };
  return Object.freeze({ create, refresh: render, get window() { return window; },
    snapshot: () => placement,
    place(value: InlineTextPlacement | null): void {
      // Never unmount/reflow a composing textarea. On loss of geometry retain
      // the exact binding in a labelled fallback, including empty/invalid text.
      requested = value; pending = true;
      render();
    },
    async dispose() { disposed = true; hide(); await creating?.catch(() => {}); if (window && !window.isDestroyed()) window.destroy(); window = null; },
  });
}
