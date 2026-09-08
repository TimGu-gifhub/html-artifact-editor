import type { BaseWindow, Rectangle, WebContentsView } from 'electron';

export type PreviewHostStep = 'attached' | 'sized' | 'detached';
export function createPreviewHost(window: BaseWindow, bounds: () => Rectangle,
  reportError: (code: string) => void, onStep: (step: PreviewHostStep) => void = () => {}) {
  let current: WebContentsView | null = null;
  let unavailable = false;
  let disposed = false;
  const children = () => window.contentView.children;
  const live = (): void => {
    if (disposed || unavailable || window.isDestroyed()) throw new Error('DOCUMENT_ACTIVATION_UNKNOWN');
  };
  const report = (): void => { try { reportError('DOCUMENT_ACTIVATION_UNKNOWN'); } catch { /* Keep evidence. */ } };
  const resize = (): void => {
    if (!current || disposed || unavailable || window.isDestroyed()) return;
    try { current.setBounds(bounds()); } catch { unavailable = true; report(); }
  };
  window.on('resize', resize);
  const restore = (previous: WebContentsView | null, next: WebContentsView | null): void => {
    try {
      if (window.isDestroyed() || disposed) throw new Error('HOST_GONE');
      if (previous) {
        if (previous.webContents.isDestroyed()) throw new Error('PREVIOUS_GONE');
        window.contentView.addChildView(previous); previous.setBounds(bounds());
      }
      if (next && next !== previous && children().includes(next)) window.contentView.removeChildView(next);
      if ((previous && !children().includes(previous)) || (next && next !== previous && children().includes(next))) throw new Error('RESTORE_MISMATCH');
      current = previous;
    } catch { unavailable = true; report(); throw new Error('DOCUMENT_ACTIVATION_UNKNOWN'); }
  };
  return Object.freeze({
    get current() { return current; },
    get available() { return !disposed && !unavailable && !window.isDestroyed(); },
    swap(next: WebContentsView | null): () => void {
      live();
      const previous = current;
      if (next === previous) return () => {};
      try {
        if (next) {
          if (next.webContents.isDestroyed()) throw new Error('NEXT_GONE');
          window.contentView.addChildView(next); onStep('attached');
          next.setBounds(bounds()); onStep('sized');
        }
        if (previous) { window.contentView.removeChildView(previous); onStep('detached'); }
        if ((next && !children().includes(next)) || (previous && children().includes(previous))) throw new Error('HOST_MISMATCH');
        current = next;
      } catch {
        restore(previous, next);
        throw new Error('DOCUMENT_ACTIVATION_FAILED');
      }
      let rolledBack = false;
      return () => { if (!rolledBack) { rolledBack = true; restore(previous, next); } };
    },
    // Workspace owns Preview teardown. This adapter only owns native attachment.
    dispose(): void {
      if (disposed) return;
      disposed = true; window.removeListener('resize', resize);
      if (!window.isDestroyed() && current && children().includes(current)) window.contentView.removeChildView(current);
      current = null;
    },
  });
}
