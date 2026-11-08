// Serves tools/fixture/ over http so a real (non-headless) Edge can be pointed at it.
// Usage: ELECTRON_RUN_AS_NODE=1 "<DSH exe>" edge-bridge/tools/serve-fixture.mjs [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const fixtureDir = resolve(import.meta.dirname, 'fixture');
const port = Number(process.argv[2] || 17899);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const name = url.pathname === '/' ? '/page-fixture.html' : url.pathname;
  const file = join(fixtureDir, name);
  if (!file.startsWith(fixtureDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture server on http://127.0.0.1:${port}/page-fixture.html`);
});
