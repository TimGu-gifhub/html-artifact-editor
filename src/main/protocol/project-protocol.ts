import type { Session } from 'electron';
import type { PreviewIdentity } from '../../contracts/preview.ts';
import type { ProjectGrant } from './project-files.ts';
import { readProjectFile } from './project-files.ts';
import { previewCSP, resourceMime, resourcePath, resourceURL } from './resource-policy.ts';

export type BlockedResource = Readonly<{ reason: 'RESOURCE_BLOCKED'; target: string }>;
export const HTML_LIMIT = 5 * 1024 * 1024;
const RESOURCE_LIMIT = 16 * 1024 * 1024;
const SESSION_LIMIT = 128 * 1024 * 1024;

export async function registerProjectProtocol(
  session: Session, grant: ProjectGrant, identity: PreviewIdentity,
) {
  let active = true;
  let inFlight = 0;
  let servedBytes = 0;
  const blocked: BlockedResource[] = [];
  const reportBlocked = (url: string): void => {
    // Diagnostics stay in Main, bounded, with no query, credentials or file path.
    if (blocked.length >= 100) return;
    let target = 'invalid';
    try {
      const parsed = new URL(url);
      target = parsed.protocol === 'artifact:' ? `artifact://${parsed.host}/[resource]`
        : ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
          ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
    } catch { /* No page-provided text in diagnostics. */ }
    blocked.push({ reason: 'RESOURCE_BLOCKED', target });
  };
  // Preserve the entry's original bytes for the entire preview generation.
  const snapshot = await readProjectFile(grant, grant.entry, HTML_LIMIT);
  new TextDecoder('utf-8', { fatal: true }).decode(snapshot);
  const url = resourceURL(identity.sessionId, grant.entry);
  const allowed = (requestURL: string, method: string): boolean => {
    if (!active || method !== 'GET') return false;
    try {
      resourceMime(resourcePath(requestURL, identity.sessionId), grant.entry, identity.mode);
      return true;
    } catch { return false; }
  };
  session.protocol.handle('artifact', async (request) => {
    if (!allowed(request.url, request.method) || inFlight >= 8 || servedBytes >= SESSION_LIMIT) {
      reportBlocked(request.url);
      return new Response(null, { status: 403 });
    }
    inFlight++;
    try {
      const path = resourcePath(request.url, identity.sessionId);
      const mime = resourceMime(path, grant.entry, identity.mode);
      const bytes = path === grant.entry ? snapshot : await readProjectFile(grant, path, RESOURCE_LIMIT);
      if (!active || servedBytes + bytes.byteLength > SESSION_LIMIT) throw new Error('REVOKED');
      servedBytes += bytes.byteLength;
      return new Response(new Uint8Array(bytes), { headers: {
        'Content-Type': mime, 'Content-Security-Policy': previewCSP(identity.mode),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), usb=(), serial=(), hid=(), local-fonts=(), payment=()',
      } });
    } catch {
      reportBlocked(request.url);
      return new Response(null, { status: 403 });
    } finally { inFlight--; }
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !allowed(details.url, details.method)
      || ['subFrame', 'object', 'media', 'webSocket', 'ping', 'cspReport'].includes(details.resourceType);
    if (cancel) reportBlocked(details.url);
    callback({ cancel });
  });
  return {
    url,
    // Callers receive copies; no renderer can mutate the original entry snapshot.
    snapshot: (): Uint8Array => new Uint8Array(snapshot),
    isActive: (): boolean => active,
    diagnostics: (): readonly BlockedResource[] => blocked.slice(),
    revoke: (): boolean => {
      if (!active) return false;
      active = false;
      session.protocol.unhandle('artifact');
      return true;
    },
    reportBlocked,
  };
}
