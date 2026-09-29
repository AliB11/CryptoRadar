'use strict';
/**
 * Binance recovery tests.
 *
 * The failure these cover is the one users actually reported: CoinGecko's
 * keyless pool is shared per IP, so a datacenter caller (Vercel, a hosted box)
 * gets a 429 on `/coins/markets`, and the terminal used to fall back to a
 * source with no hourly history — which switched the whole analysis engine off.
 * The recovery chain must rebuild the hourly series from a venue that still
 * publishes it, label it, and never invent the fields the venue does not carry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const NOW = 1790704800000;                 // fixed clock: 2026-09-29T18:00:00Z
const HOUR = 3600000;

const MODULES = [
  path.join(__dirname, '..', 'lib', 'coinlore.js'),
  path.join(__dirname, '..', 'lib', 'binance.js'),
  path.join(__dirname, '..', 'api', 'proxy.js')
];

// Both adapters keep process-wide state (a venue cool-down, a symbol cache, a
// one-request-per-second queue). Reloading them per test keeps every case
// hermetic instead of inheriting the previous case's back-off.
function freshModules() {
  for (const file of MODULES) delete require.cache[require.resolve(file)];
  return { Binance: require('../lib/binance.js'), proxy: require('../api/proxy.js') };
}

/** 168 hourly candles, values exactly as the venue reports them (strings). */
function klines() {
  const rows = [];
  for (let i = 167; i >= 0; i--) {
    const t = NOW - i * HOUR;
    const c = 100 + Math.sin(i / 11) * 4;
    rows.push([t, String(c - 1), String(c + 1), String(c - 2), String(c), '12.5',
      t + HOUR - 1, '250000', 400, '20', '0']);
  }
  return rows;
}

const assets = Array.from({ length: 60 }, (_, i) => ({
  id: String(90 - i), nameid: 'asset-' + i, name: 'Asset ' + i, symbol: 'A' + i
}));
const tickers = assets.map((asset, i) => ({
  id: asset.id, nameid: asset.nameid, symbol: asset.symbol, name: asset.name,
  price_usd: String(10 + i), market_cap_usd: String((10 + i) * 1e6), volume24: '5000000',
  rank: i + 1, percent_change_1h: '0.4', percent_change_24h: '-1.2', percent_change_7d: '3.5'
}));
// What the aggregator hands over: CoinGecko-style ids, already normalized.
// The aggregator lowercases tickers and maps them onto CoinGecko-style ids.
const universe = tickers.map((row, i) => ({
  id: row.nameid, symbol: row.symbol.toLowerCase(), name: row.name, market_cap: (10 + i) * 1e6,
  market_cap_rank: i + 1, price_change_percentage_7d_in_currency: 3.5
}));

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

function stubFetch(overrides = {}) {
  const calls = [];
  const fetch = async url => {
    const target = new URL(String(url), 'http://localhost');
    calls.push(target.href);
    if (target.pathname === '/api/proxy') {
      // The page's own proxy: reachable, but its upstream is rate limited.
      return response(429, { error: 'rate limited' });
    }
    if (target.hostname === 'api.coingecko.com') {
      return overrides.coingecko ? overrides.coingecko(target) : response(429, { error: 'rate limited' });
    }
    if (target.hostname === 'api.coinlore.net') {
      if (target.pathname === '/api/tickers/') {
        if (overrides.aggregatorDown) return response(503, { error: 'offline' });
        return response(200, { data: overrides.tickers || tickers, info: { time: NOW / 1000 } });
      }
      if (target.pathname === '/api/assets/') return response(200, assets);
      if (target.pathname === '/api/ticker/') return response(200, tickers.slice(0, 2));
      if (target.pathname === '/api/global/') {
        return response(200, [{ total_mcap: '2500000000000', total_volume: '90000000000',
          btc_d: '54.2', eth_d: '14.1', mcap_change: '-0.8', coins_count: '14000' }]);
      }
      return response(503, { error: 'offline' });
    }
    if (/binance/.test(target.hostname)) {
      if (overrides.binance) return overrides.binance(target);
      return response(200, klines());
    }
    throw new Error('unexpected URL: ' + target.href);
  };
  return { fetch, calls };
}

async function invoke(handler, url) {
  const out = { status: 0, headers: {}, body: null };
  const res = {
    statusCode: 200,
    setHeader(key, value) { out.headers[key.toLowerCase()] = value; },
    end(body) { out.body = body ? JSON.parse(body) : null; }
  };
  Object.defineProperty(res, 'statusCode', { get: () => out.status, set: value => { out.status = value; } });
  await handler({ method: 'GET', url }, res);
  return out;
}

test('candles are normalized from the venue shape without inventing precision', () => {
  const { Binance } = freshModules();
  const raw = [
    [NOW - HOUR, '99.5', '101.25', '98.75', '100.125', '1', NOW - 1, '1000', 5, '5', '0'],
    [NOW, '100.125', '102', '99', '101', '2', NOW + HOUR - 1, '2000', 6, '6', '0'],
    // malformed rows are dropped, not repaired
    [NOW - 2 * HOUR, 'x', '1', '1', '1', '1', NOW, '1', 1, '1', '0'],
    null,
    ['short']
  ];
  const candles = Binance.normalizeKlines(raw, 10);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].t, NOW - HOUR);
  assert.equal(candles[0].c, 100.125);
  assert.equal(candles[0].q, 1000);
  assert.equal(candles[1].close, NOW + HOUR - 1);
  // a limit keeps the newest candles
  assert.equal(Binance.normalizeKlines(raw, 1).length, 1);
  assert.equal(Binance.normalizeKlines('nope', 10).length, 0);
});

test('merged rows carry the venue price, the aggregator identity and a labelled sparkline', () => {
  const { Binance } = freshModules();
  const series = new Map(universe.slice(0, 3).map(row =>
    [row.id, { symbol: row.symbol.toUpperCase() + 'USDT', candles: Binance.normalizeKlines(klines(), 168) }]));
  const merged = Binance.merge(universe.slice(0, 3), series, { now: NOW, sparkline: true });
  assert.equal(merged.length, 3);
  const first = merged[0];
  assert.equal(first.id, 'asset-0');
  assert.equal(first.symbol, 'a0');
  assert.equal(first.market_cap, 10000000, 'market cap comes from the aggregator, never the venue');
  assert.equal(first.market_cap_rank, 1);
  assert.equal(first.price_change_percentage_7d_in_currency, 3.5, 'the 7d print is carried over');
  assert.equal(first.radar_provider, 'binance');
  assert.equal(first.radar_timestamp_kind, 'server-observed');
  assert.equal(first.last_updated, new Date(NOW).toISOString());
  assert.equal(first.sparkline_in_7d.price.length, 168);
  assert.ok(first.sparkline_in_7d.price.every(price => price > 0));
  assert.ok(first.total_volume > 0, '24h volume is summed from the candles');
  assert.ok(first.price_change_percentage_24h_in_currency < 0);
  // fields only CoinGecko publishes stay absent instead of being guessed
  assert.equal('atl_date' in first, false);
  assert.equal('price_change_percentage_30d_in_currency' in first, false);
  // and a request without a sparkline gets no fabricated series
  const bare = Binance.merge(universe.slice(0, 3), series, { now: NOW, sparkline: false });
  assert.equal('sparkline_in_7d' in bare[0], false);
});

test('an asset with no market on the venue is dropped, never padded', () => {
  const { Binance } = freshModules();
  const rows = [{ id: 'asset-0', symbol: 'a0' }, { id: 'asset-1', symbol: 'a1' }];
  const series = new Map([['asset-0', { symbol: 'A0USDT', candles: Binance.normalizeKlines(klines(), 168) }]]);
  const merged = Binance.merge(rows, series, { now: NOW });
  assert.deepEqual(merged.map(row => row.id), ['asset-0']);
});

test('base assets follow the alias table and reject junk', () => {
  const { Binance } = freshModules();
  assert.equal(Binance.baseAssetOf({ symbol: 'miota' }), 'IOTA');
  assert.equal(Binance.baseAssetOf({ symbol: 'BTC' }), 'BTC');
  assert.equal(Binance.baseAssetOf({ symbol: '' }), null);
  assert.equal(Binance.baseAssetOf({}), null);
  assert.equal(Binance.baseAssetOf({ symbol: 'a-very-long-ticker' }), null);
});

test('the Vercel proxy rebuilds hourly history after a CoinGecko rate limit', async () => {
  const { Binance, proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=150&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'binance');
    assert.equal(out.headers['x-radar-history'], 'hourly', 'the engine must be told the history is real');
    assert.ok(out.body.length >= 50, 'the 100-coin universe must survive: ' + out.body.length);
    assert.ok(out.body.every(row => row.sparkline_in_7d.price.length >= 120));
    assert.equal(out.body[0].radar_provider, 'binance');
    assert.ok(calls.some(url => url.startsWith('https://api.coingecko.com/')), 'CoinGecko stays first');
    assert.ok(calls.some(url => /binance/.test(url)), 'the venue is consulted');
    assert.ok(calls.filter(url => /binance/.test(url)).length >= 50, 'one candle request per asset');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('a rate-limited CoinGecko still answers quotes without sparklines', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&ids=asset-0,asset-1&sparkline=false');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'binance');
    assert.equal(out.headers['x-radar-history'], 'none');
    assert.deepEqual(out.body.map(row => row.id), ['asset-0', 'asset-1']);
    assert.ok(out.body.every(row => typeof row.current_price === 'number' && row.current_price > 0));
    assert.equal('sparkline_in_7d' in out.body[0], false, 'no payload bloat when nobody asked for a series');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('hourly OHLC comes from the venue when CoinGecko cannot serve it', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fasset-0%2Fohlc&vs_currency=usd&days=7');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'binance');
    assert.equal(out.headers['x-radar-history'], 'hourly');
    assert.ok(out.body.length >= 120);
    assert.equal(out.body[0].length, 5, 'OHLC rows stay five fields wide');
    assert.ok(out.body.every(row => row[3] > 0 && row[2] >= row[3]));
    assert.ok(calls.some(url => /binance/.test(url) && url.includes('A0USDT')));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('global is left to the snapshot provider, not fabricated on the venue', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=global');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'coinlore');
    assert.equal(out.body.data.market_cap_percentage.btc, 54.2);
    assert.ok(!calls.some(url => /binance/.test(url)), 'no venue call for a board it cannot answer');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('a browser snapshot keeps real hourly history and the aggregator identity', async () => {
  const { Binance } = freshModules();
  const oldFetch = globalThis.fetch;
  const { fetch, calls } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const snapshot = await Binance.fetchSnapshot();
    assert.equal(snapshot.provider, 'binance');
    assert.equal(snapshot.historyReady, true);
    assert.equal(snapshot.historyResolution, 'hourly');
    assert.equal(snapshot.live, true);
    assert.ok(snapshot.coins.length >= 50);
    assert.ok(snapshot.coins[0].sparkline_in_7d.price.length >= 120);
    assert.equal(snapshot.coins[0].radar_provider, 'binance');
    assert.ok(snapshot.global, 'the macro block still comes from the aggregator');
    assert.ok(calls.some(url => /coinlore/.test(url)), 'identity comes from the aggregator');
    assert.ok(calls.some(url => /binance/.test(url)));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('quotes resolve asset ids through the aggregator and price them on the venue', async () => {
  const { Binance } = freshModules();
  const oldFetch = globalThis.fetch;
  const { fetch } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const quotes = await Binance.fetchQuotes(['asset-0', 'asset-1'], { now: NOW });
    assert.deepEqual(quotes.map(row => row.id), ['asset-0', 'asset-1']);
    assert.ok(quotes.every(row => row.current_price > 0));
    assert.equal(quotes[0].radar_provider, 'binance');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('a protective stop is still priced when the proxy upstream is rate limited', async () => {
  const { Binance } = freshModules();
  const Protection = require('../protection.js');
  const oldFetch = globalThis.fetch;
  const { fetch, calls } = stubFetch();
  globalThis.fetch = fetch;
  try {
    const quotes = await Protection.fetchQuotes(['asset-0', 'asset-1'], {
      now: () => NOW, fetch,
      // exactly what lib/monitor.js and protection-view.js hand the engine
      fallbackQuotes: (ids, options) => Binance.fetchQuotes(ids, options)
    });
    assert.equal(quotes['asset-0'].status, 'fresh', JSON.stringify(quotes['asset-0']));
    assert.ok(quotes['asset-0'].price > 0);
    assert.equal(quotes['asset-0'].provider, 'binance');
    assert.equal(quotes['asset-1'].status, 'fresh');
    assert.ok(calls.some(url => /binance/.test(url)), 'the venue priced the stop');
    // and a crossed stop must still fire off that rebuilt quote
    const position = Protection.create({
      id: 'pos-1', coinId: 'asset-0', symbol: 'A0', mode: 'live',
      entryPrice: quotes['asset-0'].price * 2, quantity: 1,
      enteredAt: NOW - 3600000, stop: quotes['asset-0'].price * 1.5, target1: null
    }, NOW - 3600000);
    const result = Protection.evaluate(position, quotes['asset-0'], NOW);
    assert.equal(result.position.pending.reason, 'STOP_LOSS');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('an unlisted symbol does not burn the whole batch or fabricate a row', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch({
    binance: () => response(400, { code: -1121, msg: 'Invalid symbol.' })
  });
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=100&page=1&sparkline=true');
    assert.equal(out.status, 200);
    assert.equal(out.headers['x-radar-provider'], 'coinlore', 'it degrades to the snapshot, it does not error out');
    const venueCalls = calls.filter(url => /binance/.test(url));
    // USDT then USDC per asset, then the batch stops: no endless quote ladder.
    assert.ok(venueCalls.length > 0, 'the venue is still consulted');
    assert.ok(venueCalls.length <= assets.length * 4, 'bounded attempts: ' + venueCalls.length);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('a venue that refuses this caller stops the batch instead of retrying per asset', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch({ binance: () => response(451, { error: 'unavailable for legal reasons' }) });
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=100&page=1&sparkline=true');
    assert.equal(out.status, 200);
    assert.equal(out.headers['x-radar-provider'], 'coinlore', 'a refusal degrades, it does not error out');
    // The batch gives up as soon as the refusal is seen. What is already in
    // flight still lands — that is the worker pool (6) times the host mirror
    // (2), not one attempt per asset.
    const venueCalls = calls.filter(url => /binance/.test(url));
    assert.ok(venueCalls.length <= 12, 'bounded by the pool, not the universe: ' + venueCalls.length);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('when the venue is down too, the snapshot provider still answers', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch, calls } = stubFetch({ binance: () => response(503, { error: 'venue down' }) });
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=100&page=1&sparkline=true');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'coinlore');
    assert.equal(out.headers['x-radar-history'], 'none');
    assert.equal('sparkline_in_7d' in out.body[0], false);
    assert.ok(calls.filter(url => /binance/.test(url)).length > 0);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('with every source down the proxy reports failure instead of a quote it made up', async () => {
  const { proxy } = freshModules();
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const { fetch } = stubFetch({
    binance: () => response(503, { error: 'venue down' }),
    aggregatorDown: true
  });
  globalThis.fetch = fetch;
  try {
    const out = await invoke(proxy, '/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=100&page=1&sparkline=true');
    assert.equal(out.status, 429, JSON.stringify(out.body));
    assert.equal(out.body.error, 'upstream');
    assert.equal(out.headers['x-radar-provider'], undefined);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});
