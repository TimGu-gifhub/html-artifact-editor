import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { planHiddenContent } from '../../core/parser/hidden-content.ts';
import type { HiddenContentPlan } from '../../core/parser/hidden-content.ts';
import type { HiddenContentState } from '../../contracts/desktop.ts';
import type { Workspace } from '../workspace/controller.ts';
import type { ProofreadDocument } from '../workspace/document.ts';

type View = { plan: HiddenContentPlan; key: string | null; marker: string | null; enabled: boolean; uncertain: boolean; blocked: boolean };

// A private isolated world reads presentation only. Neither page code nor the
// renderer supplies these selectors, and the result is never patch authority.
async function inspect(contents: WebContents, plan: HiddenContentPlan, marker: string): Promise<{ present: boolean; visible: number }> {
  const result: unknown = await contents.executeJavaScriptInIsolatedWorld(1003, [{ code: `(() => {
    const selectors = ${JSON.stringify(plan.selectors)};
    return { present: getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(marker)}).trim() === 'active',
      visible: selectors.filter(selector => {
        const element = document.querySelector(selector);
        return element && element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
      }).length };
  })()` }]);
  if (!result || typeof result !== 'object' || !('present' in result) || typeof result.present !== 'boolean'
    || !('visible' in result) || !Number.isInteger(result.visible) || typeof result.visible !== 'number'
    || result.visible < 0 || result.visible > plan.count) throw new Error('HIDDEN_CONTENT_FAILED');
  return { present: result.present, visible: result.visible };
}
export function createHiddenContentController(workspace: () => Workspace | null, notify: () => void,
  beforeChange?: (document: ProofreadDocument) => Promise<void>) {
  const views = new WeakMap<ProofreadDocument, View>();
  let pending: Promise<void> | null = null;
  let disposed = false;
  const viewFor = (document: ProofreadDocument): View => {
    let view = views.get(document);
    if (!view) { view = { plan: planHiddenContent(document.mapping.source), key: null, marker: null, enabled: false, uncertain: false, blocked: false }; views.set(document, view); }
    return view;
  };
  return Object.freeze({
    get busy() { return pending !== null; },
    snapshot(): HiddenContentState {
      const document = workspace()?.current;
      const view = document?.mode === 'proofread' ? viewFor(document) : null;
      return { documentId: document?.id ?? null, count: view?.plan.count ?? 0, enabled: view?.enabled ?? false,
        busy: pending !== null, uncertain: view?.uncertain ?? false, limited: view?.plan.limited ?? false,
        available: !disposed && document?.mode === 'proofread' && document.mapping.status === 'ready'
          && !!view?.plan.count && !view.plan.limited && !view.uncertain && !view.blocked };
    },
    async set(documentId: string, stateRevision: number, enabled: boolean, active: () => boolean, signal: AbortSignal): Promise<void> {
      if (disposed || pending) throw new Error('HIDDEN_CONTENT_BUSY');
      const owner = workspace();
      if (!owner) throw new Error('DESKTOP_UNAVAILABLE');
      const document = owner.current;
      if (!active() || signal.aborted || owner.snapshot().stateRevision !== stateRevision || document?.id !== documentId) throw new Error('STALE_WORKSPACE');
      if (document.mode !== 'proofread') throw new Error('READ_ONLY_MODE');
      const view = viewFor(document);
      if (!view.plan.count || view.plan.limited || view.uncertain || view.blocked || document.mapping.status !== 'ready') throw new Error('HIDDEN_CONTENT_UNAVAILABLE');
      const input = document.input.snapshot();
      if (owner.snapshot().phase !== 'idle' || input.phase !== 'idle' || input.draftPhase !== 'idle'
        || input.input?.composing || input.hasUnappliedInput) throw new Error('INPUT_FLUSH_REQUIRED');
      if (enabled === view.enabled) return;
      const release = document.input.holdDeparture(input.stateRevision);
      const contents = document.preview.contents;
      const current = () => !disposed && active() && !signal.aborted && owner.current === document
        && !contents.isDestroyed() && document.preview.isActive() && document.mapping.status === 'ready';
      const remove = async () => {
        if (!view.key || !view.marker) throw new Error('HIDDEN_CONTENT_FAILED');
        if (!contents.isDestroyed()) {
          await contents.removeInsertedCSS(view.key);
          if ((await inspect(contents, view.plan, view.marker)).present) throw new Error('HIDDEN_CONTENT_FAILED');
        }
        view.key = null; view.marker = null; view.enabled = false;
      };
      const operation = (async () => {
        try {
          if (beforeChange) await beforeChange(document);
          if (!current()) throw new Error('STALE_WORKSPACE');
          if (enabled) {
            const marker = '--hae-hidden-view-' + randomUUID();
            view.marker = marker;
            // Electron 44 removes author-origin sheets; a user-origin sheet can
            // remain installed despite removeInsertedCSS resolving successfully.
            const key = await contents.insertCSS(view.plan.css + `@media screen{:root{${marker}:active!important}}`, { cssOrigin: 'author' });
            view.key = key;
            if (!current()) {
              await remove();
              throw new Error('STALE_WORKSPACE');
            }
            const display = await inspect(contents, view.plan, marker);
            if (!current()) { await remove(); throw new Error('STALE_WORKSPACE'); }
            if (!display.present || display.visible !== view.plan.count) {
              await remove(); view.blocked = true;
              throw new Error('HIDDEN_CONTENT_UNAVAILABLE');
            }
          } else {
            if (!view.key) throw new Error('HIDDEN_CONTENT_UNAVAILABLE');
            await remove();
            if (!current()) throw new Error('STALE_WORKSPACE');
          }
          view.enabled = enabled;
        } catch (error) {
          if (error instanceof Error && ['STALE_WORKSPACE', 'HIDDEN_CONTENT_UNAVAILABLE'].includes(error.message) && view.key === null) throw error;
          view.uncertain = true;
          throw new Error('HIDDEN_CONTENT_FAILED');
        } finally { release(); }
      })();
      pending = operation; notify();
      try { await operation; } finally { pending = null; notify(); }
    },
    async dispose(): Promise<void> {
      disposed = true;
      await pending?.catch(() => {});
      const document = workspace()?.current;
      if (document?.mode !== 'proofread' || document.preview.contents.isDestroyed()) return;
      const view = views.get(document);
      if (view?.key && view.marker) {
        await document.preview.contents.removeInsertedCSS(view.key);
        if ((await inspect(document.preview.contents, view.plan, view.marker)).present) throw new Error('HIDDEN_CONTENT_FAILED');
        view.key = null; view.marker = null; view.enabled = false;
      }
    },
  });
}
