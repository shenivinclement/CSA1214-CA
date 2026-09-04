// Small HTTP helpers shared by the API routes.
// Keeps each route file to just "validate -> call core -> respond".
'use strict';

/** Permissive CORS: every endpoint is stateless pure compute, with no auth and no stored data. */
export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function fail(res, status, message, extra = {}) {
  send(res, status, { ok: false, error: message, ...extra });
}

/**
 * Reads a JSON body. Vercel pre-parses `req.body`; the local dev server does
 * not, so fall back to reading the stream.
 */
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      return JSON.parse(req.body);
    }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body too large (limit 1 MB)');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/**
 * Wraps a route: handles CORS preflight, method checking, body parsing and
 * turns any thrown Error into a clean 400/500 JSON response.
 */
export function route(methods, handler) {
  return async function (req, res) {
    applyCors(res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return fail(res, 405, `Method ${req.method} not allowed on this endpoint (expected ${methods.join(' or ')})`);
    }
    let body = {};
    if (req.method === 'POST') {
      try { body = await readJson(req); }
      catch (e) { return fail(res, 400, `Could not parse request body as JSON: ${e.message}`); }
    }
    try {
      await handler(req, res, body);
    } catch (e) {
      if (e && e.name === 'ValidationError') return fail(res, 400, e.message);
      // eslint-disable-next-line no-console
      console.error('[api] unhandled error:', e);
      return fail(res, 500, 'Internal error while processing the program', { detail: String(e && e.message || e) });
    }
  };
}

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}
