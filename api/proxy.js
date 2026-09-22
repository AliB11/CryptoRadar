'use strict';
/**
 * Allowlisted market-data proxy.
 * Caches upstream responses so the browser never talks to CoinGecko directly
 * (avoids CORS + 429 bursts). Used by Vercel and mirrored in server.py.
 */
const ALLOW_PATH = /^(coins\/markets|global|search\/trending|coins\/[a-z0-9-]+\/ohlc)$/;
const ALLOW_QS = new Set([
  'vs_currency', 'order', 'per_page', 'page', 'sparkline',
  'price_change_percentage', 'days', 'ids', 'limit'
]);
const CG = 'https://api.coingecko.com/api/v3/';
const FNG = 'https://api.alternative.me/fng/';
const UA = 'CryptoRadar/1.1 (signal-terminal; +https://github.com/AliB11/CryptoRadar)';

const cache = globalThis.__radarCache || (globalThis.__radarCache = new Map());

function ttlFor(path, src) {
  if (src === 'fng' || path === 'search/trending') return 600;
  if (/\/ohlc$/.test(path)) return 600;
  return 70;
}

async function getJSON(url, ttl) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl * 1000) return { data: hit.v, cached: true, stale: false };
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(12000)
  });
  if (r.status === 429) {
    if (hit) return { data: hit.v, cached: true, stale: true };
    const err = new Error('rate limited');
    err.status = 429;
    throw err;
  }
  if (!r.ok) {
    const err = new Error('upstream ' + r.status);
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  const v = await r.json();
  cache.set(url, { t: Date.now(), v });
  if (cache.size > 80) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return { data: v, cached: false, stale: false };
}

function paramsOf(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://radar.local').searchParams);
  } catch (e) {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method && req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method' }));
    return;
  }

  const q = paramsOf(req);
  const src = q.src || '';

  try {
    if (src === 'health') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, cache: cache.size, ts: Date.now() }));
      return;
    }
    if (src === 'fng') {
      let limit = parseInt(q.limit || '30', 10);
      if (!Number.isFinite(limit)) limit = 30;
      limit = Math.min(30, Math.max(1, limit));
      const { data, cached, stale } = await getJSON(FNG + '?limit=' + limit, 600);
      res.setHeader('X-Radar-Cache', cached ? (stale ? 'STALE' : 'HIT') : 'MISS');
      res.statusCode = 200;
      res.end(JSON.stringify(data));
      return;
    }
    if (src !== 'cg') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'src' }));
      return;
    }
    const path = String(q.path || '');
    if (!ALLOW_PATH.test(path)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'path' }));
      return;
    }
    const fwd = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k === 'src' || k === 'path') continue;
      if (!ALLOW_QS.has(k)) continue;
      if (v == null) continue;
      fwd.set(k, Array.isArray(v) ? v[0] : String(v));
    }
    const qs = fwd.toString();
    const up = CG + path + (qs ? '?' + qs : '');
    const { data, cached, stale } = await getJSON(up, ttlFor(path, src));
    res.setHeader('X-Radar-Cache', cached ? (stale ? 'STALE' : 'HIT') : 'MISS');
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (e) {
    const st = e && e.status ? e.status : 502;
    res.statusCode = st;
    res.end(JSON.stringify({ error: 'upstream', detail: String(e && e.message || e) }));
  }
};
