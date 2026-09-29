'use strict';
/*
 * Binance public market data — the keyless source of *hourly* history.
 *
 * Why this file exists
 * --------------------
 * The signal engine needs seven days of hourly closes per asset. CoinGecko's
 * keyless pool is shared per IP and is the first thing to be rate limited when
 * the caller is a datacenter (a Vercel function, a CI runner, a hosted box).
 * When it answers 429 the recovery chain used to land on a snapshot provider
 * with no hourly history at all, which silently switched the whole terminal
 * off: no compass, no divergence, no backtest, no momentum screen. That is the
 * "still cannot connect" symptom, and it is a data-layer problem, not a UI one.
 *
 * Binance publishes 1h candles with no key and a much larger quota, so the
 * recovery chain can now rebuild the hourly series instead of degrading.
 *
 * Rules this adapter keeps
 * ------------------------
 *   - it never fabricates a candle, a market cap or a project age;
 *   - an asset with no market on the venue is dropped, never padded;
 *   - every row is labelled (`radar_provider: 'binance'`) so callers — and the
 *     footer of the terminal — can say where the numbers came from;
 *   - the venue is not hammered: bounded concurrency, one shared negative cache
 *     for unlisted symbols, and a cool-down after a transport-level failure.
 */
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RadarBinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildBinance() {
  // The public market-data host first: it is the one the venue's own web client
  // uses, it is not geo-fenced the way the trading host is, and it carries the
  // same `/api/v3` surface. `api.binance.com` is the mirror.
  const HOSTS = Object.freeze(['https://data-api.binance.vision', 'https://api.binance.com']);
  // Quote assets, best first. A coin that only trades against USDC is still a
  // usable USD price; one that trades against nothing here is dropped.
  const QUOTES = Object.freeze(['USDT', 'USDC', 'FDUSD', 'TUSD']);
  // Seven days of 1h candles — exactly the depth of CoinGecko's sparkline.
  const HOURLY = 168;
  const MIN_CANDLES = 120;
  const SERIES_TTL = 70;
  const MAX_COINS = 100;
  const CONCURRENCY = 6;
  const VENUE_COOLDOWN_MS = 30000;
  // Tickers whose exchange base asset differs from the market-data ticker.
  const ALIASES = Object.freeze({ miota: 'iota' });

  const num = value => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  const round = value => Math.round(value * 100) / 100;

  function coinloreModule() {
    if (typeof require === 'function') {
      try { return require('./coinlore.js'); } catch (_) { /* browser */ }
    }
    return (typeof globalThis !== 'undefined' && globalThis.RadarCoinLore) || null;
  }

  function unpack(result) {
    if (result && Object.prototype.hasOwnProperty.call(result, 'data') &&
        Object.prototype.hasOwnProperty.call(result, 'cached')) return result;
    return { data: result, cached: false, stale: false };
  }

  // ---------------------------------------------------------------- candles

  function normalizeKlines(raw, limit) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(row => {
        if (!Array.isArray(row) || row.length < 11) return null;
        const t = num(row[0]);
        const o = num(row[1]);
        const h = num(row[2]);
        const l = num(row[3]);
        const c = num(row[4]);
        const q = num(row[7]);
        const close = num(row[6]);
        if (!(t > 0) || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return null;
        const opened = t < 1e12 ? t * 1000 : t;
        return {
          t: opened,
          o, h, l, c,
          q: q == null ? 0 : q,
          // The venue reports the candle's close in ms; a missing one is derived
          // from the open so the row still carries a usable timestamp.
          close: close > 0 ? (close < 1e12 ? close * 1000 : close) : opened + 3600000
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
  }

  function isUnlisted(error) {
    // Binance answers 400 with code -1121 for a symbol it does not list.
    return !!error && error.status === 400;
  }
  function isBlocked(error) {
    // 403/451 is the venue refusing this caller (geo, ban): every asset will
    // answer the same way, so the batch must stop instead of retrying per coin.
    return !!error && (error.status === 403 || error.status === 451);
  }
  function isTransport(error) {
    if (!error) return true;
    if (error.status == null) return true;
    return error.status >= 500;
  }

  const resolved = new Map();   // base asset -> trading symbol
  const rejected = new Set();   // symbols this venue does not list
  let venueBlockedUntil = 0;

  function blockVenue() {
    venueBlockedUntil = Date.now() + VENUE_COOLDOWN_MS;
  }

  async function fetchKlines(symbol, options, fetchJSON) {
    const interval = options && options.interval || '1h';
    const limit = clamp(Math.round(Number(options && options.limit) || HOURLY), 24, 1000);
    if (Date.now() < venueBlockedUntil) throw new Error('binance venue cooling down');
    const query = 'symbol=' + encodeURIComponent(symbol) +
      '&interval=' + encodeURIComponent(interval) + '&limit=' + limit;
    let last = null;
    for (const host of HOSTS) {
      try {
        const reply = unpack(await fetchJSON(host + '/api/v3/klines?' + query, SERIES_TTL));
        const candles = normalizeKlines(reply.data, limit);
        if (candles.length >= Math.min(MIN_CANDLES, limit)) return candles;
        last = new Error('binance candles too short for ' + symbol);
      } catch (error) {
        last = error;
        // An unlisted symbol is a property of the venue, not of the host, so
        // spending the same request on the mirror would only burn quota.
        if (isUnlisted(error) || isBlocked(error)) break;
        if (isTransport(error)) blockVenue();
      }
    }
    throw last || new Error('binance klines unavailable');
  }

  /** One asset: its symbol on the venue plus its hourly candles, or null. */
  async function loadSeries(row, options, fetchJSON) {
    const base = baseAssetOf(row);
    if (!base) return null;
    const known = resolved.get(base);
    const candidates = known ? [known] : QUOTES.map(quote => base + quote);
    for (const symbol of candidates) {
      if (rejected.has(symbol)) continue;
      try {
        const candles = await fetchKlines(symbol, options, fetchJSON);
        resolved.set(base, symbol);
        return { symbol, candles };
      } catch (error) {
        if (!isUnlisted(error)) throw error;
        rejected.add(symbol);
      }
    }
    return null;
  }

  function baseAssetOf(row) {
    const raw = String((row && (row.symbol || row.baseAsset)) || '').trim().toLowerCase();
    if (!raw) return null;
    const base = (ALIASES[raw] || raw).toUpperCase();
    return /^[A-Z0-9]{2,12}$/.test(base) ? base : null;
  }

  /**
   * Hourly candles for a batch of market rows, with bounded concurrency.
   * A venue-wide transport failure stops the batch instead of turning into one
   * failed request per asset.
   */
  async function fetchSeries(rows, options, fetchJSON) {
    const queue = (Array.isArray(rows) ? rows : [])
      .slice(0, MAX_COINS)
      .map(row => ({ row, base: baseAssetOf(row) }))
      .filter(item => item.base);
    const series = new Map();
    let cursor = 0;
    let venueDown = false;
    const worker = async () => {
      while (cursor < queue.length && !venueDown) {
        const item = queue[cursor++];
        try {
          const hit = await loadSeries(item.row, options, fetchJSON);
          if (hit) series.set(item.row.id, hit);
        } catch (error) {
          if (isTransport(error) || isBlocked(error)) venueDown = true;
          // An unlisted or thin asset is skipped: the row is dropped below.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return series;
  }

  // ------------------------------------------------------------------ merge

  /**
   * Turn venue candles into the market shape the terminal already reads,
   * keeping the identity, rank, market cap and 7-day change that only a market
   * aggregator can supply. Nothing is invented for the fields the venue does
   * not publish — they stay absent, exactly like a CoinLore snapshot.
   */
  function merge(rows, series, options = {}) {
    const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
    const withSparkline = options.sparkline !== false;
    const out = [];
    for (const row of rows) {
      const hit = series.get(row.id);
      if (!hit || !hit.candles.length) continue;
      const candles = hit.candles;
      const last = candles[candles.length - 1];
      const previous = candles.length > 1 ? candles[candles.length - 2] : last;
      const dayAgo = candles.length > 24 ? candles[candles.length - 25] : candles[0];
      // `day`, not `window`: this module also runs in a page where `window` is
      // the global, and shadowing it inside a helper is a trap for later edits.
      const day = candles.slice(-24);
      const ch1h = previous.c > 0 ? (last.c / previous.c - 1) * 100 : null;
      const ch24 = dayAgo.c > 0 ? (last.c / dayAgo.c - 1) * 100 : null;
      const merged = {
        id: row.id,
        symbol: row.symbol || row.id || '',
        name: row.name || row.id,
        current_price: last.c,
        market_cap: num(row.market_cap) || 0,
        market_cap_rank: num(row.market_cap_rank),
        total_volume: day.reduce((sum, candle) => sum + (num(candle.q) || 0), 0),
        high_24h: day.reduce((max, candle) => Math.max(max, candle.h), 0),
        low_24h: day.reduce((min, candle) => Math.min(min, candle.l), last.l),
        price_change_percentage_1h_in_currency: ch1h == null ? null : round(ch1h),
        price_change_percentage_24h_in_currency: ch24 == null ? null : round(ch24),
        // Only the aggregator knows the longer windows; the venue does not, so
        // they are carried over when present and left absent otherwise.
        price_change_percentage_7d_in_currency: num(row.price_change_percentage_7d_in_currency),
        // The last candle is the venue's live price, so the observation time is
        // the fetch time — the same convention the snapshot provider uses.
        last_updated: iso(now),
        radar_provider: 'binance',
        radar_timestamp_kind: 'server-observed'
      };
      if (withSparkline) merged.sparkline_in_7d = { price: candles.map(candle => candle.c) };
      out.push(merged);
    }
    return out;
  }

  // --------------------------------------------------------------- recovery

  /**
   * The market universe this deployment can still see. Identity (id, rank,
   * market cap, 7-day change) comes from the aggregator that maps CoinGecko
   * ids; only price history comes from here.
   */
  async function universeRows(path, query, fetchJSON) {
    const CoinLore = coinloreModule();
    if (!CoinLore || typeof CoinLore.fetchFallback !== 'function') {
      throw new Error('no aggregator to resolve asset ids');
    }
    const reply = unpack(await CoinLore.fetchFallback(path, query, fetchJSON));
    return Array.isArray(reply.data) ? reply.data : [];
  }

  /**
   * Recovery for the two history-bearing endpoints. `global` and
   * `search/trending` are not answered here: the venue has no global stats and
   * no trending board, and pretending otherwise would fabricate data.
   */
  async function recover(path, query, fetchJSON, options = {}) {
    const q = query || {};
    if (path === 'coins/markets') {
      const sparkline = String(q.sparkline).toLowerCase() === 'true';
      const requested = String(q.ids || '').split(',').map(id => id.trim()).filter(Boolean);
      const universeQuery = requested
        ? { ids: requested.join(',') }
        : { per_page: String(clamp(Math.round(Number(q.per_page) || 100), 1, MAX_COINS)), page: '1' };
      const rows = await universeRows(path, universeQuery, fetchJSON);
      if (!rows.length) throw new Error('no asset universe to rebuild');
      const series = await fetchSeries(rows, { interval: '1h', limit: HOURLY }, fetchJSON);
      const merged = merge(rows, series, { sparkline, now: options.now });
      if (merged.length < Math.min(50, rows.length)) throw new Error('binance history unavailable');
      return {
        data: merged, cached: false, stale: false,
        provider: 'binance', history: sparkline ? 'hourly' : 'none'
      };
    }
    const match = /^coins\/([a-z0-9-]+)\/ohlc$/.exec(path);
    if (match) {
      const id = match[1];
      const rows = await universeRows('coins/markets', { ids: id }, fetchJSON);
      const row = rows.find(entry => entry && entry.id === id);
      if (!row) throw new Error('binance cannot resolve ' + id);
      const days = clamp(Math.round(Number(q.days) || 7), 1, 41);
      const hit = await loadSeries(row, { interval: '1h', limit: clamp(days * 24, 24, 1000) }, fetchJSON);
      if (!hit || hit.candles.length < 10) throw new Error('binance candles unavailable for ' + id);
      return {
        data: hit.candles.map(candle => [candle.t, candle.o, candle.h, candle.l, candle.c]),
        cached: false, stale: false, provider: 'binance', history: 'hourly'
      };
    }
    throw new Error('binance does not support ' + path);
  }

  // ------------------------------------------------------- direct (browser)

  async function directJSON(fetcher, url, ttl) {
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
    });
    if (!response || !response.ok) {
      const error = new Error('binance HTTP ' + (response && response.status || 'error'));
      error.status = response && response.status;
      throw error;
    }
    return { data: await response.json(), cached: false, stale: false, ttl };
  }

  /**
   * Browser-side snapshot with real hourly history. Used when the page has no
   * same-origin proxy at all (file://, a static host, or a local server whose
   * upstream is unreachable): the aggregator supplies the universe and this
   * module supplies the candles, both straight from the browser.
   */
  async function fetchSnapshot(fetcher) {
    const request = typeof fetcher === 'function' ? fetcher
      : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!request) throw new Error('fetch unavailable');
    const CoinLore = coinloreModule();
    if (!CoinLore || typeof CoinLore.fetchSnapshot !== 'function') {
      throw new Error('no aggregator to resolve asset ids');
    }
    const base = await CoinLore.fetchSnapshot(request);
    const rows = (base.coins || []).slice(0, MAX_COINS);
    const series = await fetchSeries(rows, { interval: '1h', limit: HOURLY },
      (url, ttl) => directJSON(request, url, ttl));
    const coins = merge(rows, series, { sparkline: true });
    if (coins.length < 50) throw new Error('binance snapshot incomplete');
    return {
      coins, global: base.global || null,
      provider: 'binance', historyReady: true, historyResolution: 'hourly', live: true
    };
  }

  /** Quote fallback for the protection monitor: same chain, no proxy. */
  async function fetchQuotes(ids, options = {}) {
    const fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const unique = [...new Set(Array.isArray(ids) ? ids : [])]
      .filter(id => typeof id === 'string' && /^[a-z0-9-]+$/i.test(id));
    if (!unique.length) return [];
    const now = Number(options.now == null ? Date.now() : options.now);
    const reply = await recover('coins/markets', { ids: unique.join(','), sparkline: 'false' },
      (url, ttl) => directJSON(fetcher, url, ttl), { now });
    return reply.data.map(row => ({ ...row, last_updated: row.last_updated || new Date(now).toISOString() }));
  }

  return Object.freeze({
    HOSTS, QUOTES, HOURLY, aliases: ALIASES, isUnlisted, isBlocked,
    baseAssetOf, normalizeKlines, fetchKlines, fetchSeries, merge, recover,
    fetchSnapshot, fetchQuotes
  });
});
