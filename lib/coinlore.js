'use strict';
/*
 * CoinLore's keyless API adapter.
 *
 * CoinLore supplies current market snapshots and daily OHLC, not the hourly
 * 7-day candles needed by CryptoRadar's signal engine. The adapter intentionally
 * never fabricates a sparkline or interpolates daily candles into hourly data.
 * It is shared by the HTTP proxies, the browser's file:// fallback, and the
 * server-side quote monitor.
 */
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RadarCoinLore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildCoinLore() {
  const BASE = 'https://api.coinlore.net/api/';
  const ASSET_TTL = 6 * 60 * 60;
  const MARKET_TTL = 70;
  const HISTORY_TTL = 10 * 60;
  const ALIASES = Object.freeze({
    'the-open-network': 'toncoin',
    'near': 'near-protocol',
    'matic-network': 'polygon',
    'polygon-pos': 'polygon'
  });
  const directCache = new Map();
  let requestQueue = Promise.resolve();
  let nextRequestAt = 0;

  function rateLimited(fetchJSON) {
    return (url, ttl) => {
      const task = requestQueue.then(async () => {
        const waitMs = Math.max(0, nextRequestAt - Date.now());
        if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
        nextRequestAt = Date.now() + 1000;
        return fetchJSON(url, ttl);
      });
      requestQueue = task.then(() => undefined, () => undefined);
      return task;
    };
  }

  const number = value => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const safeId = value => String(value == null ? '' : value).trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const iso = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const first = (row, keys) => {
    for (const key of keys) if (row && row[key] != null) return row[key];
    return null;
  };
  function listFrom(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.data)) return raw.data;
    return [];
  }
  function observedAt(info, now = Date.now()) {
    const sourceTime = number(info && (info.time || info.timestamp));
    return iso(sourceTime) || new Date(now).toISOString();
  }

  function normalizeTicker(row, idOverride, info, now = Date.now()) {
    if (!row || typeof row !== 'object') return null;
    const id = safeId(idOverride || row.nameid || row.id || row.symbol);
    const price = number(first(row, ['price_usd', 'price']));
    if (!id || !(price > 0)) return null;
    const providerTime = iso(first(row, ['last_updated', 'last_updated_at', 'timestamp']));
    const globalTime = observedAt(info, now);
    return {
      id,
      symbol: String(row.symbol || '').toLowerCase(),
      name: String(row.name || row.symbol || id),
      current_price: price,
      market_cap: number(first(row, ['market_cap_usd', 'market_cap'])) || 0,
      total_volume: number(first(row, ['volume24', 'volume_24h', 'volume_24h_usd', 'volume_usd'])) || 0,
      market_cap_rank: number(first(row, ['rank', 'market_cap_rank'])) || null,
      price_change_percentage_1h_in_currency: number(first(row, ['percent_change_1h', 'percent_change_1h_in_currency'])),
      price_change_percentage_24h_in_currency: number(first(row, ['percent_change_24h', 'percent_change_24h_in_currency'])),
      price_change_percentage_7d_in_currency: number(first(row, ['percent_change_7d', 'percent_change_7d_in_currency'])),
      last_updated: providerTime || globalTime,
      radar_provider: 'coinlore',
      radar_timestamp_kind: providerTime ? 'provider' : (info && number(info.time) ? 'provider-batch' : 'server-observed')
    };
  }

  function normalizeGlobal(raw) {
    const row = raw && raw.data && !Array.isArray(raw.data) ? raw.data
      : (Array.isArray(raw) ? raw[0] : raw) || {};
    const cap = number(first(row, ['total_mcap', 'total_market_cap_usd', 'market_cap_usd'])) ||
      number(row.total_market_cap && row.total_market_cap.usd);
    const volume = number(first(row, ['total_volume', 'total_volume_usd', 'volume24'])) ||
      number(row.volume && row.volume.usd);
    const btc = number(first(row, ['btc_d', 'btc_dominance'])) ||
      number(row.market_cap_percentage && row.market_cap_percentage.btc);
    const eth = number(first(row, ['eth_d', 'eth_dominance'])) ||
      number(row.market_cap_percentage && row.market_cap_percentage.eth);
    const marketChange = number(first(row, ['mcap_change', 'market_cap_change_percentage_24h_usd']));
    const active = number(first(row, ['coins_count', 'active_cryptocurrencies', 'coins']));
    return {
      data: {
        market_cap_percentage: { btc, eth },
        total_market_cap: { usd: cap },
        total_volume: { usd: volume },
        market_cap_change_percentage_24h_usd: marketChange,
        active_cryptocurrencies: active
      }
    };
  }

  function normalizeTrending(raw, now = Date.now()) {
    let rows = listFrom(raw);
    if (!rows.length && raw && raw.data && typeof raw.data === 'object') {
      const winners = Array.isArray(raw.data.winners) ? raw.data.winners : [];
      const losers = Array.isArray(raw.data.losers) ? raw.data.losers : [];
      rows = winners.concat(losers);
    }
    const seen = new Set();
    const coins = rows.map(row => normalizeTicker(row, null, raw && raw.info, now))
      .filter(row => row && !seen.has(row.id) && seen.add(row.id))
      .slice(0, 10)
      .map(row => ({ item: {
        id: row.id, symbol: row.symbol, name: row.name, market_cap_rank: row.market_cap_rank,
        data: {
          price: row.current_price,
          price_change_percentage_24h: { usd: row.price_change_percentage_24h_in_currency }
        }
      } }));
    return { coins };
  }

  function normalizeDailyOhlc(raw, days = 7) {
    const records = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (!records || typeof records !== 'object') return [];
    const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 86400000;
    const values = Array.isArray(records) ? records : Object.values(records);
    return values.filter(row => Array.isArray(row) && row.length >= 5)
      .map(row => {
        const timestamp = number(row[0]);
        const o = number(row[1]), h = number(row[2]), l = number(row[3]), c = number(row[4]);
        if (!(timestamp > 0) || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return null;
        return [timestamp < 1e12 ? timestamp * 1000 : timestamp, o, h, l, c];
      })
      .filter(row => row && row[0] >= cutoff)
      .sort((a, b) => a[0] - b[0]);
  }

  function shouldUseCoinGeckoData(path, query, data) {
    const q = query || {};
    if (path === 'coins/markets') {
      if (!Array.isArray(data) || !data.length) return true;
      if (String(q.sparkline).toLowerCase() === 'true') {
        const perPage = Math.max(1, Number(q.per_page) || 100);
        const required = Math.max(50, Math.min(75, Math.ceil(perPage * 0.5)));
        if (data.length < required) return true;
        const valid = data.filter(row => row && row.sparkline_in_7d &&
          Array.isArray(row.sparkline_in_7d.price) && row.sparkline_in_7d.price.length >= 120).length;
        return valid < required;
      }
      return false;
    }
    if (path === 'global') {
      const globalData = data && typeof data === 'object' && data.data;
      const cap = globalData && globalData.total_market_cap && Number(globalData.total_market_cap.usd);
      const volume = globalData && globalData.total_volume && Number(globalData.total_volume.usd);
      return !(Number.isFinite(cap) && cap > 0 && Number.isFinite(volume) && volume > 0);
    }
    if (path === 'search/trending') return !data || !Array.isArray(data.coins) || data.coins.length < 4;
    if (/^coins\/[a-z0-9-]+\/ohlc$/.test(path)) return !Array.isArray(data) || data.length < 10;
    return false;
  }

  function buildUrl(path, params) {
    const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    return BASE + path + (qs.toString() ? '?' + qs.toString() : '');
  }

  function assetRows(raw) {
    return listFrom(raw).filter(row => row && typeof row === 'object');
  }

  async function resolveAssets(ids, fetchJSON) {
    const result = await fetchJSON(BASE + 'assets/', ASSET_TTL);
    const rows = assetRows(result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result);
    if (!rows.length) throw new Error('CoinLore asset directory unavailable');
    const byName = new Map(), byId = new Map();
    for (const asset of rows) {
      const nameid = safeId(asset.nameid || asset.name_id);
      const id = String(asset.id == null ? '' : asset.id);
      if (nameid) byName.set(nameid, asset);
      if (/^\d+$/.test(id)) byId.set(id, asset);
    }
    const map = new Map();
    for (const requested of ids) {
      const id = safeId(requested);
      const alias = ALIASES[id] || id;
      const asset = byName.get(alias) || (/^\d+$/.test(id) ? byId.get(id) : null);
      if (asset && /^\d+$/.test(String(asset.id))) map.set(requested, asset);
    }
    return map;
  }

  function unpack(result) {
    if (result && Object.prototype.hasOwnProperty.call(result, 'data') &&
        Object.prototype.hasOwnProperty.call(result, 'cached')) return result;
    return { data: result, cached: false, stale: false };
  }

  async function fetchFallback(path, query, fetchJSON) {
    if (typeof fetchJSON !== 'function') throw new TypeError('fetchJSON is required');
    const getJSON = rateLimited(fetchJSON);
    const q = query instanceof URLSearchParams ? Object.fromEntries(query.entries()) : { ...(query || {}) };
    const now = Date.now();
    if (path === 'global') {
      const reply = unpack(await getJSON(buildUrl('global/'), 70));
      const data = normalizeGlobal(reply.data);
      if (shouldUseCoinGeckoData('global', {}, data)) throw new Error('CoinLore global data incomplete');
      return { ...reply, data, provider: 'coinlore', history: 'none' };
    }
    if (path === 'coins/markets') {
      const requested = String(q.ids || '').split(',').map(s => s.trim()).filter(Boolean);
      let rows, reply, info;
      if (requested.length) {
        const assets = await resolveAssets(requested, getJSON);
        if (!assets.size) return { data: [], cached: false, stale: false, provider: 'coinlore', history: 'none' };
        const numericIds = [...new Set([...assets.values()].map(asset => String(asset.id)))];
        reply = unpack(await getJSON(buildUrl('ticker/', { id: numericIds.join(',') }), MARKET_TTL));
        const returned = listFrom(reply.data);
        info = reply.data && reply.data.info;
        const byNumericId = new Map(returned.map(row => [String(row.id), row]));
        rows = requested.map(id => {
          const asset = assets.get(id);
          if (!asset) return null;
          const ticker = byNumericId.get(String(asset.id));
          return normalizeTicker(ticker, id, info, now);
        }).filter(Boolean);
      } else {
        const perPage = Math.max(1, Math.min(100, parseInt(q.per_page || '100', 10) || 100));
        const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
        const start = (page - 1) * perPage;
        reply = unpack(await getJSON(buildUrl('tickers/', { start, limit: perPage }), MARKET_TTL));
        const rawRows = listFrom(reply.data);
        info = reply.data && reply.data.info;
        rows = rawRows.map(row => normalizeTicker(row, null, info, now)).filter(Boolean);
      }
      if (!rows.length && requested.length) {
        return { data: [], cached: !!reply.cached, stale: !!reply.stale, provider: 'coinlore', history: 'none' };
      }
      return { ...reply, data: rows, provider: 'coinlore', history: 'none' };
    }
    if (path === 'search/trending') {
      const reply = unpack(await getJSON(buildUrl('movers/', { sort: '24h' }), 600));
      const data = normalizeTrending(reply.data, now);
      if (!data.coins.length) throw new Error('CoinLore movers unavailable');
      return { ...reply, data, provider: 'coinlore', history: 'none' };
    }
    const match = /^coins\/([a-z0-9-]+)\/ohlc$/.exec(path);
    if (match) {
      const [id] = [match[1]];
      const assets = await resolveAssets([id], getJSON);
      const asset = assets.get(id);
      if (!asset) throw new Error('CoinLore asset not found');
      const reply = unpack(await getJSON(buildUrl('coin/ohlcv/', { coin: asset.id }), HISTORY_TTL));
      const days = Math.max(1, Math.min(365, parseInt(q.days || '7', 10) || 7));
      const candles = normalizeDailyOhlc(reply.data, days);
      if (!candles.length) throw new Error('CoinLore daily OHLC unavailable');
      return { ...reply, data: candles, provider: 'coinlore', history: 'daily' };
    }
    throw new Error('CoinLore does not support ' + path);
  }

  async function directJSON(fetcher, url, ttl) {
    const hit = directCache.get(url);
    if (hit && Date.now() - hit.at < ttl * 1000) return { data: hit.data, cached: true, stale: false };
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
    });
    if (!response || !response.ok) throw new Error('CoinLore HTTP ' + (response && response.status || 'error'));
    const data = await response.json();
    directCache.set(url, { at: Date.now(), data });
    return { data, cached: false, stale: false };
  }

  async function fetchSnapshot(fetcher) {
    const request = typeof fetcher === 'function' ? fetcher : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!request) throw new Error('fetch unavailable');
    const getJSON = rateLimited((url, ttl) => directJSON(request, url, ttl));
    const marketsUrl = buildUrl('tickers/', { start: 0, limit: 100 });
    const [markets, global] = await Promise.all([
      getJSON(marketsUrl, MARKET_TTL),
      getJSON(BASE + 'global/', MARKET_TTL).catch(() => null)
    ]);
    const marketRows = listFrom(markets.data).map(row => normalizeTicker(row, null, markets.data.info)).filter(Boolean);
    if (marketRows.length < 50) throw new Error('CoinLore snapshot incomplete');
    return {
      coins: marketRows,
      global: global ? normalizeGlobal(global.data).data : null,
      provider: 'coinlore', historyReady: false, live: true
    };
  }

  async function fetchQuotes(ids, options = {}) {
    const fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const unique = [...new Set(Array.isArray(ids) ? ids : [])]
      .filter(id => typeof id === 'string' && /^[a-z0-9-]+$/i.test(id));
    if (!unique.length) return [];
    const now = Number(options.now == null ? Date.now() : options.now);
    const result = await fetchFallback('coins/markets', {
      ids: unique.join(','), vs_currency: 'usd', per_page: '250', page: '1'
    }, (url, ttl) => directJSON(fetcher, url, ttl));
    return result.data.map(row => ({ ...row, last_updated: row.last_updated || new Date(now).toISOString() }));
  }

  return Object.freeze({
    BASE, aliases: ALIASES, normalizeTicker, normalizeGlobal, normalizeTrending,
    normalizeDailyOhlc, shouldUseCoinGeckoData, fetchFallback, fetchSnapshot, fetchQuotes
  });
});
