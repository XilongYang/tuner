// A static file server for the end-to-end tests: the repo root is the site, so
// serving it as-is is exactly what the deployed app is.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = 8934;
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function startServer(port = PORT) {
  const server = createServer(async (request, response) => {
    // Normalised and re-rooted: a path that climbs out of the site is a bug in
    // the test, and serving it would hide that.
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) {
      response.writeHead(403).end('outside the site');
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
