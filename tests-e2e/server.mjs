// Zero-dependency static file server for the project root, so the
// Playwright scripts in this folder can load index.html/js/css the same way
// the app is actually served (a plain static host, no build step). Used by
// run-all.mjs; can also be run standalone (`node tests-e2e/server.mjs`) to
// serve the app manually while iterating on one script by hand.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 8934;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export function startServer(port = PORT) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
    // Refuse to serve outside ROOT (e.g. a "../" in the URL).
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Allow running this file directly to just serve the app (Ctrl+C to stop),
// e.g. while debugging a single Playwright script by hand.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/index.html`);
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
