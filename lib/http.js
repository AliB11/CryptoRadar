'use strict';
/** Shared helpers for the Vercel function handlers. */

const SPACE = /^[a-zA-Z0-9_-]{1,64}$/;

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-radar-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, body, extraHeaders) {
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function tokenFrom(req) {
  const header = req.headers['x-radar-token'];
  if (header) return String(header);
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  try {
    const url = new URL(req.url, 'http://radar.local');
    if (url.searchParams.get('token')) return url.searchParams.get('token');
  } catch (_) { /* ignore */ }
  return '';
}

function safeEqual(a, b) {
  const left = String(a || ''), right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function readBody(req) {
  if (!req.body) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return null;
    req.body = Buffer.concat(chunks).toString('utf8');
  }
  if (req.body == null) return null;
  if (typeof req.body === 'object') return req.body;           // Vercel parses JSON
  try { return JSON.parse(req.body); } catch (_) { return null; }
}

function spaceOf(req, body) {
  const fromQuery = (() => {
    try { return new URL(req.url, 'http://radar.local').searchParams.get('space'); } catch (_) { return null; }
  })();
  const candidate = fromQuery || (body && body.space) || process.env.RADAR_SPACE || 'default';
  return SPACE.test(String(candidate)) ? String(candidate) : 'default';
}

module.exports = { send, applyCors, tokenFrom, safeEqual, readBody, spaceOf, SPACE };
