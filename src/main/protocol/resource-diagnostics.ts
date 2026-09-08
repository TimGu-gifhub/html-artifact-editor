import type { ResourceDiagnostic, ResourceDiagnostics, ResourceFailure, ResourceKind } from '../../contracts/resources.ts';
import { resourcePath } from './resource-policy.ts';

export function resourceKind(value: unknown, url = ''): ResourceKind {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  const kinds: Record<string, ResourceKind> = { mainframe: 'document', document: 'document', subframe: 'frame', frame: 'frame', other: 'other',
    stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', xhr: 'fetch', fetch: 'fetch',
    media: 'media', websocket: 'websocket' };
  if (Object.hasOwn(kinds, key)) return kinds[key]!;
  const suffix = new URL(url || 'about:blank').pathname.split('.').at(-1)?.toLowerCase();
  if (suffix === 'css') return 'stylesheet';
  if (suffix === 'js' || suffix === 'mjs') return 'script';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'svg'].includes(suffix ?? '')) return 'image';
  if (['woff', 'woff2', 'ttf', 'otf'].includes(suffix ?? '')) return 'font';
  return 'other';
}

// Display-only targets. Neither this string nor any diagnostic authorizes a read
// or write. Strip credentials/query/fragment; never disclose native file paths.
export function resourceTarget(url: string, sessionId: string): string {
  if (url.length > 8192) return '[invalid URL]';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'artifact:') {
      try { return `project:/${resourcePath(url, sessionId)}`.slice(0, 2048); }
      catch { return 'project:/[blocked path]'; }
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 2048);
    }
    return `${parsed.protocol}[blocked]`;
  } catch { return '[invalid URL]'; }
}
const priority: Record<ResourceFailure, number> = {
  RESOURCE_LOAD_FAILED: 0, RESOURCE_BLOCKED: 1, CSP_BLOCKED: 2, RESOURCE_READ_FAILED: 3,
  RESOURCE_MISSING: 4, RESOURCE_CHANGED: 4, RESOURCE_LIMIT: 4,
};
export function createResourceDiagnostics(sessionId: string) {
  const entries = new Map<string, ResourceDiagnostic>();
  const listeners = new Set<() => void>();
  let truncated = false;
  let closed = false;
  const notify = (): void => { for (const fn of listeners) { try { fn(); } catch { /* Data only. */ } } };
  const reportTarget = (target: string, type: ResourceKind, reason: ResourceFailure): void => {
    if (closed) return;
    const key = `${type}\n${target}`;
    const old = entries.get(key);
    if (old && priority[reason] <= priority[old.reason]) return;
    if (!old && entries.size >= 100) { if (!truncated) { truncated = true; notify(); } return; }
    entries.set(key, Object.freeze({ id: old?.id ?? entries.size + 1, target, resourceType: type, reason })); notify();
  };
  const snapshot = (): ResourceDiagnostics => Object.freeze({ items: Object.freeze([...entries.values()]), truncated });
  return Object.freeze({
    snapshot,
    report(url: string, type: unknown, reason: ResourceFailure): void {
      let kind: ResourceKind;
      try { kind = resourceKind(type, url); } catch { kind = 'other'; }
      reportTarget(resourceTarget(url, sessionId), kind, reason);
    },
    // Only the Main CDP observer calls this with already sanitized bounded data.
    reportTarget,
    truncate(): void { if (!closed && !truncated) { truncated = true; notify(); } },
    onState(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close(): void { closed = true; listeners.clear(); },
  });
}
export type ResourceDiagnosticsCollector = ReturnType<typeof createResourceDiagnostics>;
