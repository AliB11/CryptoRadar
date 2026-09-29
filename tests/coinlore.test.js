'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CoinLore = require('../lib/coinlore.js');
const proxy = require('../api/proxy.js');

const assets = [
  { id: '90', nameid: 'bitcoin', name: 'Bitcoin', symbol: 'BTC' },
  { id: '80', nameid: 'ethereum', name: 'Ethereum', symbol: 'ETH' }
];
const ticker = (id, nameid, symbol, price, rank) => ({
  id, nameid, symbol, name: nameid[0].toUpperCase() + nameid.slice(1),
  price_usd: String(price), market_cap_usd: String(price * 1000000), volume24: '2300000',
  rank, percent_change_1h: '0.4', percent_change_24h: '-1.2', percent_change_7d: '3.5'
});
const makeFetchJSON = handlers => async (url, ttl) => {
  const target = new URL(url);
  const handler = handlers.find(([testUrl]) => testUrl(target));
  if (!handler) throw new Error('unexpected URL: ' + url);
  return { data: await handler[1](target), cached: false, stale: false, ttl };
};

test('CoinLore market snapshots preserve supported fields and never invent a sparkline', async () => {
  const getJSON = makeFetchJSON([
    [u => u.pathname === '/api/assets/', () => assets],
    [u => u.pathname === '/api/ticker/', () => [ticker('90', 'bitcoin', 'BTC', 68000, 1), ticker('80', 'ethereum', 'ETH', 3400, 2)]]
  ]);
  const reply = await CoinLore.fetchFallback('coins/markets', {
    ids: 'bitcoin,ethereum', sparkline: 'false', per_page: '250'
  }, getJSON);
  assert.equal(reply.provider, 'coinlore');
  assert.equal(reply.history, 'none');
  assert.equal(reply.data.length, 2);
  assert.equal(reply.data[0].id, 'bitcoin');
  assert.equal(reply.data[0].current_price, 68000);
  assert.equal(reply.data[0].price_change_percentage_1h_in_currency, 0.4);
  assert.equal(reply.data[0].price_change_percentage_24h_in_currency, -1.2);
  assert.equal(reply.data[0].price_change_percentage_7d_in_currency, 3.5);
  assert.equal(reply.data[0].radar_provider, 'coinlore');
  assert.equal(reply.data[0].radar_timestamp_kind, 'server-observed');
  assert.equal('sparkline_in_7d' in reply.data[0], false);
});

test('CoinLore global and daily candles are normalized without hourly interpolation', async () => {
  const now = Math.floor(Date.now() / 1000);
  const getJSON = makeFetchJSON([
    [u => u.pathname === '/api/global/', () => [{ total_mcap: 2500000000000, total_volume: 90000000000,
      btc_d: '54.2', eth_d: '14.1', mcap_change: '-0.8', coins_count: 14000 }]],
    [u => u.pathname === '/api/assets/', () => assets],
    [u => u.pathname === '/api/coin/ohlcv/', () => ({
      [now - 86400]: [now - 86400, 100, 115, 95, 110],
      [now - 2 * 86400]: [now - 2 * 86400, 90, 112, 88, 100]
    })]
  ]);
  const global = await CoinLore.fetchFallback('global', {}, getJSON);
  assert.equal(global.data.data.total_market_cap.usd, 2500000000000);
  assert.equal(global.data.data.market_cap_percentage.btc, 54.2);
  const history = await CoinLore.fetchFallback('coins/bitcoin/ohlc', { days: '7' }, getJSON);
  assert.equal(history.history, 'daily');
  assert.equal(history.data.length, 2);
  assert.equal(history.data[0][0], (now - 2 * 86400) * 1000);
  assert.equal(history.data[0].length, 5, 'only actual daily OHLC fields are returned');
});

test('CoinGecko history validation treats missing seven-day sparkline as recoverable', () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ id: 'asset-' + i, current_price: 1 }));
  assert.equal(CoinLore.shouldUseCoinGeckoData('coins/markets', { sparkline: 'true' }, rows), true);
  rows.forEach(row => { row.sparkline_in_7d = { price: Array(168).fill(1) }; });
  assert.equal(CoinLore.shouldUseCoinGeckoData('coins/markets', { sparkline: 'true' }, rows), false);
  assert.equal(CoinLore.shouldUseCoinGeckoData('coins/markets', { sparkline: 'false' }, rows), false);
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function invokeProxy(url) {
  const out = { status: 0, headers: {}, body: null };
  const res = {
    statusCode: 200,
    setHeader(key, value) { out.headers[key.toLowerCase()] = value; },
    end(body) { out.body = body ? JSON.parse(body) : null; }
  };
  Object.defineProperty(res, 'statusCode', { get: () => out.status, set: value => { out.status = value; } });
  await proxy({ method: 'GET', url }, res);
  return out;
}

test('Vercel proxy falls back to CoinLore after a CoinGecko rate limit and labels degradation', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  const calls = [];
  globalThis.fetch = async url => {
    const target = new URL(String(url)); calls.push(target.href);
    if (target.hostname === 'api.coingecko.com') return response(429, { error: 'rate limited' });
    if (target.hostname === 'api.coinlore.net' && target.pathname === '/api/tickers/') {
      return response(200, { data: Array.from({ length: 65 }, (_, i) => ticker(String(100 + i), 'asset-' + i,
        'A' + i, 10 + i, i + 1)), info: { time: Math.floor(Date.now() / 1000) } });
    }
    throw new Error('unexpected URL: ' + target.href);
  };
  try {
    const out = await invokeProxy('/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=150&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.headers['x-radar-provider'], 'coinlore');
    assert.equal(out.headers['x-radar-history'], 'none');
    assert.equal(out.body.length, 65);
    assert.equal(out.body[0].id, 'asset-0');
    assert.equal('sparkline_in_7d' in out.body[0], false);
    assert.ok(calls.some(url => url.startsWith('https://api.coingecko.com/')));
    assert.ok(calls.some(url => url.startsWith('https://api.coinlore.net/')));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});

test('proxy reports failure when both providers are offline instead of returning a fabricated quote', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.__radarCache && globalThis.__radarCache.clear();
  globalThis.fetch = async url => {
    const target = new URL(String(url));
    return response(target.hostname === 'api.coingecko.com' ? 429 : 503, { error: 'offline' });
  };
  try {
    const out = await invokeProxy('/api/proxy?src=cg&path=coins%2Fmarkets&vs_currency=usd&per_page=100&page=1&sparkline=true');
    assert.equal(out.status, 429);
    assert.equal(out.body.error, 'upstream');
    assert.equal(out.headers['x-radar-provider'], undefined);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__radarCache && globalThis.__radarCache.clear();
  }
});
