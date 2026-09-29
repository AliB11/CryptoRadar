'use strict';
/**
 * Allowlisted market-data proxy with two keyless recovery sources.
 * CoinLore can supply current snapshots and daily OHLC, but not the 7-day
 * hourly sparkline required by CryptoRadar's analysis engine. In that degraded
 * mode the response is explicitly labeled; callers must not infer hourly data.
 * Binance sits between the two: it publishes 1h candles without a key, so a
 * CoinGecko rate limit rebuilds the hourly series instead of switching the
 * engine off.
 */
const ALLOW_PATH = /^(coins\/markets|global|search\/trending|coins\/[a-z0-9-]+\/ohlc)$/;
const ALLOW_QS = new Set([
  'vs_currency', 'order', 'per_page', 'page', 'sparkline',
  'price_change_percentage', 'days', 'ids', 'limit'
]);
const CG = 'https://api.coingecko.com/api/v3/';
const { authenticatedFetch } = require('../lib/coingecko.js');
const CoinLore = require('../lib/coinlore.js');
const Binance = require('../lib/binance.js');
const FNG = 'https://api.alternative.me/fng/';
const UA = 'CryptoRadar/1.1 (signal-terminal; +https://github.com/AliB11/CryptoRadar)';

const cache = globalThis.__radarCache || (globalThis.__radarCache = new Map());

function ttlFor(path, src) {
  if (src === 'fng' || path === 'search/trending') return 600;
  if (/\/ohlc$/.test(path)) return 600;
  return 70;
}
function providerForUrl(url) {
  if (String(url).startsWith('https://api.coinlore.net/')) return 'coinlore';
  if (String(url).startsWith(FNG)) return 'alternative.me';
  return 'coingecko';
}
function cacheHeader(reply) {
  return reply.cached ? (reply.stale ? 'STALE' : 'HIT') : 'MISS';
}

const inflight = new Map();
async function getJSON(url, ttl) {
  const key = String(url);
  if (inflight.has(key)) return inflight.get(key);
  const task = requestJSON(key, ttl).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function requestJSON(url, ttl) {
  const hit = cache.get(url);
  const provider = hit && hit.provider || providerForUrl(url);
  if (hit && Date.now() - hit.t < ttl * 1000) {
    return { data: hit.v, cached: true, stale: false, provider };
  }
  try {
    const r = await authenticatedFetch()(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(12000)
    });
    if (r.status === 429 || r.status >= 500) {
      if (hit) return { data: hit.v, cached: true, stale: true, provider };
      const err = new Error('upstream ' + r.status);
      err.status = r.status;
      throw err;
    }
    if (!r.ok) {
      const err = new Error('upstream ' + r.status);
      err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
      throw err;
    }
    const v = await r.json();
    cache.set(url, { t: Date.now(), v, provider: providerForUrl(url) });
    if (cache.size > 80) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    return { data: v, cached: false, stale: false, provider: providerForUrl(url) };
  } catch (error) {
    // A transport reset, timeout, or malformed JSON is just as transient as a
    // 5xx. Keep an expired value available for explicit stale reporting, but
    // let the caller attempt CoinLore before returning it.
    if (hit && (!error || !error.status || error.status >= 500 || error.status === 429)) {
      return { data: hit.v, cached: true, stale: true, provider };
    }
    throw error;
  }
}

function paramsOf(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://radar.local').searchParams);
  } catch (e) {
    return {};
  }
}

function sendData(res, reply, history) {
  res.setHeader('X-Radar-Cache', cacheHeader(reply));
  res.setHeader('X-Radar-Provider', reply.provider || 'coingecko');
  res.setHeader('X-Radar-History', reply.history || history || 'none');
  res.statusCode = 200;
  res.end(JSON.stringify(reply.data));
}

async function coingeckoWithRecovery(path, query, upstreamUrl) {
  let primary = null, primaryError = null;
  try {
    primary = await getJSON(upstreamUrl, ttlFor(path, 'cg'));
    if (!primary.stale && !CoinLore.shouldUseCoinGeckoData(path, query, primary.data)) {
      return {
        ...primary, provider: 'coingecko',
        history: path === 'coins/markets' && String(query.sparkline).toLowerCase() === 'true'
          ? 'hourly' : 'none'
      };
    }
    primaryError = new Error(primary.stale ? 'CoinGecko cache is stale' : 'CoinGecko response incomplete');
    if (primary.stale) primaryError.status = 503;
  } catch (error) {
    primaryError = error;
    // A caller's malformed query is not an upstream outage and should not be
    // disguised as a provider switch.
    if (error && error.status === 400) throw error;
  }

  // Recovery 1 — a venue that still publishes hourly candles. Skipping this
  // step is what turned a CoinGecko rate limit into "the terminal is offline":
  // the next source has no hourly history, so the analysis engine had to switch
  // itself off. `global` and `search/trending` throw here on purpose and fall
  // through to the snapshot provider, which does carry those two answers.
  try {
    return await Binance.recover(path, query, getJSON);
  } catch (binanceError) {
    try {
      return await CoinLore.fetchFallback(path, query, getJSON);
    } catch (backupError) {
      // An old CoinGecko cache is a last resort only after both live backups
      // have also failed. Its cache header remains STALE so the browser and the
      // quote validator can refuse to use it as fresh market data.
      if (primary && primary.stale) return { ...primary, provider: 'coingecko', history: 'none' };
      throw primaryError || backupError;
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Shared CDN caching amortizes provider quota across serverless instances.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=70, must-revalidate');
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
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, cache: cache.size, ts: Date.now() }));
      return;
    }
    if (src === 'fng') {
      let limit = parseInt(q.limit || '30', 10);
      if (!Number.isFinite(limit)) limit = 30;
      limit = Math.min(30, Math.max(1, limit));
      const reply = await getJSON(FNG + '?limit=' + limit, 600);
      sendData(res, { ...reply, provider: 'alternative.me', history: 'none' }, 'none');
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
      if (!ALLOW_QS.has(k) || v == null) continue;
      fwd.set(k, Array.isArray(v) ? v[0] : String(v));
    }
    const upstreamUrl = CG + path + (fwd.toString() ? '?' + fwd.toString() : '');
    const reply = await coingeckoWithRecovery(path, Object.fromEntries(fwd.entries()), upstreamUrl);
    const ttl = reply.provider === 'coinlore' ? (path === 'search/trending' ? 600 : /\/ohlc$/.test(path) ? 600 : 70)
      : ttlFor(path, src);
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}, must-revalidate`);
    sendData(res, reply, path === 'coins/markets' && fwd.get('sparkline') === 'true' ? 'hourly' : 'none');
  } catch (e) {
    const st = e && e.status ? e.status : 502;
    res.statusCode = st;
    res.setHeader('Cache-Control', 'no-store');
    if (st === 429) res.setHeader('Retry-After', '60');
    res.end(JSON.stringify({ error: 'upstream', detail: String(e && e.message || e) }));
  }
};
