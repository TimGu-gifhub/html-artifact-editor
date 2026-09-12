import { resolve } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainEvent, Rectangle } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';
import { sameMapping } from '../../contracts/mapping.ts';
import { isTextGeometry, TEXT_DECORATION, TEXT_GEOMETRY } from '../../contracts/text-geometry.ts';
import type { TextDecoration, TextGeometry, TextShape } from '../../contracts/text-geometry.ts';
import type { InlineTextPlacement } from '../../contracts/inline-text.ts';
import type { Workspace } from '../workspace/controller.ts';
import { acceptsPreviewSender } from '../preview/authority.ts';
import { lockContents, securePreferences } from '../preview/security.ts';

// Click-through native decoration stays outside the untrusted document. It has
// a receive-only preload and cannot connect to Workspace or acquire input.
export function createTextTools(window: BrowserWindow, outputRoot: string, workspace: () => Workspace | null,
  bounds: () => Rectangle, anchor: (rect: Rectangle, nodeId: string) => void,
  inlineTarget: (value: InlineTextPlacement | null) => void = () => {}) {
  let overlay: BrowserWindow | null = null, creating: Promise<void> | null = null;
  let disposed = false, failed = false, geometry: TextGeometry | null = null;
  let ownerId: string | null = null, sequence = 0;
  const hide = () => { if (overlay && !overlay.isDestroyed()) {
    overlay.hide();
    if (!overlay.webContents.isDestroyed()) overlay.webContents.send(TEXT_DECORATION, {hover:null,selected:null});
  } };
  const valid = () => {
    const owner = workspace(), current = owner?.current;
    return !disposed && !failed && current?.mode === 'proofread' && owner?.snapshot().phase === 'idle'
      && current.mapping.status === 'ready' && geometry && sameMapping(current.mapping.identity, geometry.identity)
      && current.mapping.revision === geometry.revision
      && (!geometry.selected || geometry.selected.nodeId === current.mapping.selection?.nodeId);
  };
  const paint = () => {
    const current = workspace()?.current, rect = bounds();
    if (!valid() || !geometry || !current || !rect.width || !rect.height || !window.isVisible() || window.isMinimized()) { hide(); return; }
    const scale = current.preview.contents.getZoomFactor();
    // A resize/zoom event can overtake geometry IPC. Never paint old rectangles
    // in a new viewport, or use pixel coordinates as a Text selection command.
    if (Math.abs(geometry.width * scale - rect.width) > 2 || Math.abs(geometry.height * scale - rect.height) > 2) { hide(); return; }
    const transform = (shape: TextShape | null): TextShape | null => shape ? { nodeId: shape.nodeId,
      rects: shape.rects.map(value => ({ x: value.x * scale, y: value.y * scale, width: value.width * scale, height: value.height * scale })) } : null;
    const data: TextDecoration = { hover: transform(geometry.hover), selected: transform(geometry.selected) };
    const inline = geometry.inline;
    if (inline && inline.nodeId === data.selected?.nodeId) {
      const style = inline.style;
      inlineTarget({ ...inline, documentId: current.id,
        rect: { x: inline.rect.x * scale, y: inline.rect.y * scale, width: inline.rect.width * scale, height: inline.rect.height * scale },
        style: { ...style, fontSize: style.fontSize * scale, lineHeight: style.lineHeight * scale,
          letterSpacing: style.letterSpacing * scale, indent: style.indent * scale } });
    } else inlineTarget(null);
    if (!data.hover && !data.selected) { hide(); return; }
    const outer = window.getContentBounds();
    if (data.selected?.rects[0]) {
      const target = data.selected.rects[0];
      anchor({ x: outer.x + rect.x + target.x, y: outer.y + rect.y + target.y, width: target.width, height: target.height }, data.selected.nodeId);
    }
    if (!overlay || overlay.isDestroyed()) {
      if (!creating && !failed) {
        creating = (async () => {
          const child = new BrowserWindow({ parent: window, frame: false, transparent: true, backgroundColor: '#00000000',
            show: false, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false,
            webPreferences: { ...securePreferences, session: window.webContents.session,
              preload: resolve(outputRoot, 'preload/ui/index.cjs'), additionalArguments: ['--hae-decoration'] } });
          overlay = child; child.setMenu(null); child.setIgnoreMouseEvents(true, { forward: true }); lockContents(child.webContents);
          child.on('close', event => { if (!disposed) { event.preventDefault(); child.hide(); } });
          child.webContents.on('render-process-gone', () => { failed = true; hide(); });
          await child.loadURL(EDITOR_URL);
          if (!disposed) render();
        })().catch(() => { failed = true; hide(); }).finally(() => { creating = null; if (!disposed) render(); });
      }
      return;
    }
    if (creating) return;
    overlay.setBounds({ x: Math.round(outer.x + rect.x), y: Math.round(outer.y + rect.y), width: rect.width, height: rect.height });
    overlay.webContents.send(TEXT_DECORATION, data);
    if (!overlay.isVisible()) overlay.showInactive();
  };
  const render = () => { try { paint(); } catch { failed = true; hide(); } };
  const receive = (event: IpcMainEvent, value: unknown) => {
    const current = workspace()?.current;
    if (disposed || current?.mode !== 'proofread' || !acceptsPreviewSender(current.preview, event)
      || !isTextGeometry(value) || !sameMapping(current.mapping.identity, value.identity) || current.mapping.status !== 'ready'
      || value.revision !== current.mapping.revision) return;
    if (ownerId !== current.id) { ownerId = current.id; sequence = 0; }
    if (value.sequence <= sequence) return;
    sequence = value.sequence;
    const known = (shape: TextShape | null) => !shape || current.mapping.source.nodes.some(node => node.nodeId === shape.nodeId && node.editable);
    if (!known(value.hover) || !known(value.selected) || (value.selected && current.mapping.selection?.nodeId !== value.selected.nodeId)) return;
    if (value.inline && (value.inline.nodeId !== value.selected?.nodeId
      || value.inline.rect.x + value.inline.rect.width > value.width + 1 || value.inline.rect.y + value.inline.rect.height > value.height + 1)) return;
    geometry = value; render();
  };
  const resized = () => { geometry = null; hide(); };
  ipcMain.on(TEXT_GEOMETRY, receive);
  window.on('move', render); window.on('resize', resized); window.on('hide', hide); window.on('minimize', hide); window.on('restore', render);
  return Object.freeze({ refresh: render, clear: resized, get window() { return overlay; },
    async dispose() {
      disposed = true; hide(); ipcMain.removeListener(TEXT_GEOMETRY, receive);
      window.removeListener('move', render); window.removeListener('resize', resized); window.removeListener('hide', hide);
      window.removeListener('minimize', hide); window.removeListener('restore', render);
      await creating; if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = null;
    },
  });
}
