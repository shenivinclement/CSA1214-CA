// Local development server - zero dependencies, no Vercel CLI needed.
//
//   npm run dev        (or: node server.mjs)
//   node server.mjs 3000
//
// Serves the static frontend from the project root and dispatches /api/* to the
// same handler modules that Vercel deploys as serverless functions, so what you
// test locally is what ships.
'use strict';

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');   // same static root Vercel serves
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// Everything served lives under public/ - exactly what Vercel deploys as the
// static output - so nothing outside it can ever be reached.
const STATIC_DIRS = ['css', 'js', 'core'];

const apiCache = new Map();
async function loadApiHandler(name) {
  if (apiCache.has(name)) return apiCache.get(name);
  const file = path.join(ROOT, 'api', `${name}.js`);
  try { await fs.access(file); } catch { return null; }
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const handler = mod.default;
  apiCache.set(name, handler);
  return handler;
}

function notFound(res, what) {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: `Not found: ${what}` }));
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return notFound(res, req.url); }

  // ---- API routes -------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/\/+$/, '');
    if (!/^[a-z0-9-]+$/i.test(name)) return notFound(res, pathname);
    const handler = await loadApiHandler(name);
    if (!handler) return notFound(res, pathname);
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[api/${name}]`, e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  // ---- Static files (served from public/, same as the deployment) --------
  if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'));

  const rel = pathname.replace(/^\/+/, '');
  const top = rel.split('/')[0];
  if (!STATIC_DIRS.includes(top)) return notFound(res, pathname);

  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC + path.sep)) return notFound(res, pathname); // path traversal guard
  return sendFile(res, filePath);
});

async function sendFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    notFound(res, path.relative(ROOT, filePath));
  }
}

server.listen(PORT, () => {
  console.log(`\n  8085/8086 Virtual Trainer`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  App   http://localhost:${PORT}/`);
  console.log(`  API   http://localhost:${PORT}/api/health`);
  console.log(`        POST /api/assemble   POST /api/run`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
