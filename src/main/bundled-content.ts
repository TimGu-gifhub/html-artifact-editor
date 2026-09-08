import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Session } from 'electron';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// HAE-001 serves only application-owned build output, preloaded into an exact URL
// map. This is NOT the user-project path resolver required by HAE-002.
export async function registerBundledContent(
  session: Session,
  scheme: 'editor' | 'artifact',
  host: string,
  root: string,
): Promise<void> {
  const assets = new Map<string, { bytes: Uint8Array; mime: string }>();
  async function collect(directory: string, relative = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(join(directory, entry.name), key);
      else if (entry.isFile()) {
        const mime = mimeTypes[posix.extname(key)];
        if (!mime) continue;
        assets.set(`${scheme}://${host}/${key}`, {
          bytes: new Uint8Array(await readFile(join(directory, entry.name))), mime,
        });
      }
    }
  }
  await collect(root);
  const csp = scheme === 'editor'
    ? "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  session.protocol.handle(scheme, (request) => {
    const asset = request.method === 'GET' ? assets.get(request.url) : undefined;
    if (!asset) return new Response(null, { status: 403 });
    return new Response(asset.bytes, {
      headers: {
        'Content-Type': asset.mime,
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.method !== 'GET' || !assets.has(details.url) });
  });
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
}
