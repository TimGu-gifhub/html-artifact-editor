import { posix } from 'node:path';
import type { PreviewMode } from '../../contracts/preview.ts';

export class ResourceDenied extends Error {
  constructor() { super('RESOURCE_BLOCKED'); }
}

const privateNames = new Set([
  'backup', 'backups', 'recovery', 'drafts', 'credentials', 'secrets', 'node_modules',
]);
const types: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export function validateSegments(segments: readonly string[]): void {
  if (!segments.length || segments.length > 64) throw new ResourceDenied();
  for (const part of segments) {
    // One portable policy, including Windows normalization and 8.3 aliases.
    if (!part || part.length > 255 || /^[.$]/.test(part) || /[. ]$/.test(part)
      || /[\x00-\x1f\x7f<>:"|?*\\/%~]/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
      || privateNames.has(part.toLowerCase())) throw new ResourceDenied();
  }
}

export function resourcePath(url: string, sessionId: string): string {
  if (url.length > 8192 || /[\x00-\x20\x7f\\]/u.test(url)) throw new ResourceDenied();
  const match = /^artifact:\/\/([^/?#]+)\/([^?#]*)(?:\?[^#]*)?(?:#.*)?$/.exec(url);
  if (!match || match[1] !== sessionId) throw new ResourceDenied();
  let segments: string[];
  try { segments = match[2]!.split('/').map((part) => decodeURIComponent(part)); }
  catch { throw new ResourceDenied(); }
  validateSegments(segments);
  return segments.join('/');
}

export function resourceURL(sessionId: string, relative: string): string {
  const parts = relative.split('/');
  validateSegments(parts);
  return `artifact://${sessionId}/${parts.map(encodeURIComponent).join('/')}`;
}

export function resourceMime(relative: string, entry: string, mode: PreviewMode): string {
  if (relative === entry) return 'text/html; charset=utf-8';
  const extension = posix.extname(relative).toLowerCase();
  if (mode === 'proofread' && ['.js', '.mjs'].includes(extension)) throw new ResourceDenied();
  const mime = types[extension];
  if (!mime) throw new ResourceDenied();
  return mime;
}

export function previewCSP(mode: PreviewMode): string {
  return [
    "default-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-ancestors 'none'",
    "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "manifest-src 'none'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self'", "font-src 'self'", "connect-src 'self'",
    mode === 'proofread' ? "script-src 'none'" : "script-src 'self' 'unsafe-inline'",
    // This is a response-header sandbox, so page code cannot remove it.
    'sandbox allow-scripts allow-same-origin',
  ].join('; ');
}
