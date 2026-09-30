/**
 * Autonomous paper auto-trading.
 *
 * The gap this file closes: signal *entries* used to exist only when a tab
 * was open to compute the A+ confluence. The server now runs the same engine
 * (lib/engine.js, extracted from terminal.js) inside the monitor tick, so
 * these tests drive nothing but `monitor.tick()` — no browser observation is
 * ever posted — and must still produce: scan → two-sample confirmation →
 * buy → stop/target exit, plus the CryptoQuant entry gate.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-auto-'));
process.env.RADAR_STORE_FILE = path.join(tmp, 'kv.json');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RADAR_TOKEN;
delete process.env.CRON_SECRET;
delete process.env.RADAR_PROXY_ORIGIN;
delete process.env.CRYPTOQUANT_API_KEY;
delete process.env.ONCHAIN_GATE;
process.env.PULSE_INTERVAL_SEC = '90';
process.env.PAPER_AUTO_EXEC = 'true';

const monitor = require('../lib/monitor.js');
const SignalPaper = require('../lib/signal-paper.js');
const Engine = require('../lib/engine.js');
const OnChain = require('../lib/cryptoquant.js');
const proxy = require('../api/proxy.js');

const realFetch = globalThis.fetch;

/* ------------------------------------------------------------------ data */

/** The exact family that reaches A+ under the shared engine (verified):
 *  gentle uptrend whose sine trough sits 6 bars before the end — RSI cools,
 *  Bollinger z stays under 0.8, MACD histogram remains positive. */
function upSeries(g = 0.002, a = 0.045, P = 52, k = 6, n = 168) {
  const troughAt = n - k;
  const phi = 1.5 * Math.PI - 2 * Math.PI * troughAt / P;
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(100 * Math.exp(g * i) * (1 + a * Math.sin(2 * Math.PI * i / P + phi)));
  return out;
}
const FLAT = (() => {
  // Gentle sine: score stays neutral and squeeze stays ~1, so the coin is
  // NEU (grade '—') — a perfectly constant line would read as PRONE.
  const out = [];
  for (let i = 0; i < 168; i++) out.push(100 * (1 + 0.01 * Math.sin(i / 9)));
  return out;
})();
const UP = upSeries();
const UP_END = UP[UP.length - 1];

/** 50 market rows: bitcoin carries the trend, the rest are flat (NEU). */
function scanRows(createdAt, quotePriceOverride) {
  const iso = new Date(createdAt).toISOString();
  const rows = [];
  for (let i = 0; i < 50; i++) {
    const isBtc = i === 0;
    rows.push({
      id: isBtc ? 'bitcoin' : 'alt-' + i,
      symbol: isBtc ? 'bitcoin' : 'alt' + i,
      name: isBtc ? 'Bitcoin' : 'Alt ' + i,
      current_price: isBtc && quotePriceOverride != null ? quotePriceOverride : (isBtc ? UP_END : 100),
      market_cap: (50 - i) * 1e9,
      total_volume: 1e8,
      market_cap_rank: i + 1,
      last_updated: iso,
      sparkline_in_7d: { price: isBtc ? UP : FLAT }
    });
  }
  return rows;
}

let clock = Date.parse('2026-09-30T00:00:00.000Z');
let btcQuotePrice = UP_END;
let cqNetflow = null; // null → cryptoquant endpoint not stubbed

function fakeFetch(url) {
  const u = String(url);
  if (u.includes('api.cryptoquant.com')) {
    if (!cqNetflow) return Promise.reject(new Error('cryptoquant stub off'));
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        status: 'success',
        result: {
          data: u.includes('/sopr')
            ? cqNetflow.sopr.map(v => ({ date: 'd', a_sopr: v }))
            : cqNetflow.netflow.map(v => ({ date: 'd', netflow_value: v }))
        }
      })
    });
  }
  if (u.includes('/coins/markets')) {
    if (u.includes('sparkline=true')) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => scanRows(clock)
      });
    }
    const ids = decodeURIComponent((u.match(/ids=([^&]+)/) || [])[1] || '').split(',').filter(Boolean);
    const iso = new Date(clock).toISOString();
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ids.map(id => ({
        id,
        current_price: id === 'bitcoin' ? btcQuotePrice : 100,
        last_updated: iso
      }))
    });
  }
  return Promise.reject(new Error('unexpected url: ' + u));
}

function stateOf(space) {
  return monitor.loadState(space);
}

/* -------------------------------------------------------------- scenarios */

test('server scan alone: confirm → buy → take-profit, no browser involved', async t => {
  globalThis.fetch = fakeFetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const space = 'auto-tp';
  const T = Date.parse('2026-09-01T10:00:00.000Z'); // far from other tests' epochs → scan cache can't leak
  clock = T; btcQuotePrice = UP_END;

  // Tick 1 — scan produces the first A+ observation and confirms it.
  const r1 = await monitor.tick({ now: T, space, force: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.signalScan.status, 'scanned');
  assert.equal(r1.signalScan.queued, 1, 'exactly bitcoin qualifies (flat alts stay NEU)');
  assert.equal(r1.signalFills.length, 0, 'one observation is never enough');
  let s = await stateOf(space);
  assert.deepEqual(s.signalQueue.map(x => x.coinId), [], 'consumed by execute');
  assert.equal(s.signalConfirm.bitcoin.side, 'BUY');

  // Between scans: cadence gate keeps the second observation ≥120s apart.
  const rMid = await monitor.tick({ now: T + 90000, space, force: true });
  assert.equal(rMid.signalScan.status, 'not-due');

  // Tick 2 — a fresh scan 130s later is the second sample → paper buy.
  const T2 = T + 130000;
  clock = T2;
  const r2 = await monitor.tick({ now: T2, space, force: true });
  assert.equal(r2.signalScan.status, 'scanned');
  assert.equal(r2.signalFills.length, 1, 'autonomous entry without any browser POST');
  const buy = r2.signalFills[0];
  assert.equal(buy.side, 'BUY');
  assert.equal(buy.reason, 'CONFIRMED_SIGNAL');
  assert.equal(buy.paper, true);
  const entry = UP_END * 1.001; // pessimistic 10 bps buy slippage
  assert.ok(Math.abs(buy.price - entry) < 1e-9);

  s = await stateOf(space);
  const open = s.signalPositions.find(p => p.status === 'OPEN');
  assert.ok(open, 'position opened');
  assert.ok(Math.abs(open.stop - entry * 0.95) < 1e-9, 'stop = entry × 0.95');
  assert.ok(Math.abs(open.target - entry * 1.10) < 1e-9, 'target = entry × 1.10');

  // Tick 3 — price runs past the target: resting limit fills AT the target,
  // never better (the old model booked the observed price — too optimistic).
  const T3 = T2 + 130000;
  clock = T3; btcQuotePrice = entry * 1.12;
  const r3 = await monitor.tick({ now: T3, space, force: true });
  const tp = r3.signalFills.find(f => f && f.reason === 'TAKE_PROFIT');
  assert.ok(tp, 'target exit fired autonomously');
  assert.equal(tp.side, 'SELL');
  assert.ok(Math.abs(tp.price - entry * 1.10 * 0.999) < 1e-9,
    'gap past target books at target minus 10 bps, not at the observed price');

  s = await stateOf(space);
  assert.equal(s.signalPositions.find(p => p.id === open.id).status, 'CLOSED');
  assert.equal(s.signalPositions.find(p => p.id === open.id).exitReason, 'TAKE_PROFIT');

  // Heartbeat exposes the scan + gate to the UI.
  const pulse = await monitor.readPulse(space);
  assert.equal(pulse.lastSummary.signalScan.status, 'scanned');
  assert.equal(pulse.lastSummary.onchain.status, 'not-configured');
  assert.equal(pulse.lastSummary.onchain.veto, false);
});

test('stop-loss exit runs autonomously and is priced by the quote', async t => {
  globalThis.fetch = fakeFetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const space = 'auto-stop';
  const T = Date.parse('2026-09-02T10:00:00.000Z');
  clock = T; btcQuotePrice = UP_END;

  await monitor.tick({ now: T, space, force: true });                       // confirm
  const T2 = T + 130000; clock = T2;
  await monitor.tick({ now: T2, space, force: true });                      // buy
  const s = await stateOf(space);
  const open = s.signalPositions.find(p => p.status === 'OPEN');
  assert.ok(open, 'position opened');

  const T3 = T2 + 130000; clock = T3;
  btcQuotePrice = open.entryPrice * 0.93; // below the 5% stop
  const r3 = await monitor.tick({ now: T3, space, force: true });
  const stop = r3.signalFills.find(f => f && f.reason === 'STOP_LOSS');
  assert.ok(stop, 'stop fired');
  assert.equal(stop.side, 'SELL');
  assert.ok(Math.abs(stop.price - open.entryPrice * 0.93 * 0.999) < 1e-9,
    'market exit = observed price minus 10 bps');
  const after = (await stateOf(space)).signalPositions.find(p => p.id === open.id);
  assert.equal(after.status, 'CLOSED');
  assert.equal(after.exitReason, 'STOP_LOSS');
});

test('CryptoQuant gate: vetoes new entries but never traps a position', async t => {
  globalThis.fetch = fakeFetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.CRYPTOQUANT_API_KEY;
    delete process.env.ONCHAIN_GATE;
    OnChain.resetCache();
  });
  const space = 'auto-gate';
  const T = Date.parse('2026-09-03T10:00:00.000Z');
  clock = T; btcQuotePrice = UP_END;

  // --- Phase 1: no key → context is honest, nothing is blocked.
  let r = await monitor.tick({ now: T, space, force: true });
  assert.equal(r.onchain.status, 'not-configured');
  assert.equal(r.onchain.veto, false);
  assert.equal(r.signalScan.queued, 1);

  // --- Phase 2: key present, netflow spike → fresh BUY observations are
  //         held back with an explicit reason, not silently dropped.
  process.env.CRYPTOQUANT_API_KEY = 'cq-test-key';
  OnChain.resetCache();
  cqNetflow = {
    netflow: [96, 101, 99, 103, 98, 100, 104, 97, 102, 99, 101, 98, 102, 1000],
    sopr: new Array(14).fill(1.0)
  };
  const T2 = T + 130000; clock = T2;
  r = await monitor.tick({ now: T2, space, force: true });
  assert.equal(r.onchain.status, 'ok');
  assert.equal(r.onchain.veto, true, 'netflow z-score above threshold vetoes');
  assert.deepEqual(r.onchain.reasons, ['netflow-spike']);
  assert.equal(r.signalFills.length, 0, 'no entry while the gate is closed');
  let s = await stateOf(space);
  assert.equal(s.signalResults[0].result, 'onchain-veto');

  // --- Phase 3: lift the gate (env switch). The confirmation from phase 1
  // is 260s old — inside the 5-minute window — so this tick fills.
  process.env.ONCHAIN_GATE = 'off';
  const T3 = T2 + 130000; clock = T3;
  r = await monitor.tick({ now: T3, space, force: true });
  assert.equal(r.onchain.veto, false, 'ONCHAIN_GATE=off suppresses the veto');
  assert.equal(r.signalFills.length, 1, 'entry completes after the gate lifts');
  s = await stateOf(space);
  const open = s.signalPositions.find(p => p.status === 'OPEN');
  assert.ok(open);

  // --- Phase 4: gate closes again — the stop must still fire (the gate
  //         only ever vetoes NEW entries) and new buys stay blocked.
  delete process.env.ONCHAIN_GATE;
  const T4 = T3 + 130000; clock = T4;
  btcQuotePrice = open.entryPrice * 0.93;
  r = await monitor.tick({ now: T4, space, force: true });
  assert.equal(r.onchain.veto, true);
  const stop = r.signalFills.find(f => f && f.reason === 'STOP_LOSS');
  assert.ok(stop, 'stop fires despite the veto — exits are never gated');
  s = await stateOf(space);
  assert.ok((s.signalResults || []).some(x => x.result === 'onchain-veto'),
    'new entries stay blocked in the same tick');
});

test('opposite A+ signal closes the paper position (unit)', () => {
  const state = {};
  SignalPaper.init(state);
  const T = Date.parse('2026-09-04T10:00:00.000Z');
  const factors = Object.fromEntries(
    ['trend', 'macd', 'rsi', 'boll', 'anchor', 'stable', 'robust', 'edge'].map(k => [k, true]));
  const obs = (label, at, price) => ({
    coinId: 'bitcoin', symbol: 'BTC', label, grade: 'A+',
    observedAt: at, observedPrice: price, factors
  });
  const quote = (price, asOf) => ({ coinId: 'bitcoin', source: 'live', status: 'fresh', price, asOf });

  assert.ok(SignalPaper.observe(state, obs('BUY', T, 100), T).queued);
  let r = SignalPaper.execute(state, obs('BUY', T, 100), quote(100, T), T);
  assert.equal(r.reason, 'awaiting-confirmation');
  assert.ok(SignalPaper.observe(state, obs('BUY', T + 90000, 101), T + 90000).queued);
  r = SignalPaper.execute(state, obs('BUY', T + 90000, 101), quote(101, T + 90000), T + 90000);
  assert.ok(r.ok, 'entry filled');
  const entryAt = T + 90000;

  const T2 = T + 240000;
  assert.ok(SignalPaper.observe(state, obs('SELL', T2, 97), T2).queued);
  r = SignalPaper.execute(state, obs('SELL', T2, 97), quote(97, T2), T2);
  assert.ok(r.ok, 'opposite signal closes');
  assert.equal(r.fill.reason, 'OPPOSITE_SIGNAL');
  assert.equal(r.fill.side, 'SELL');
  assert.ok(Math.abs(r.fill.price - 97 * 0.999) < 1e-9, 'market exit with slippage');
  const pos = state.signalPositions.find(p => p.status === 'OPEN');
  assert.equal(pos, undefined, 'position closed');
  assert.equal(state.signalPositions[0].exitReason, 'OPPOSITE_SIGNAL');
  assert.ok(state.signalPositions[0].enteredAt === entryAt);
});

test('take-profit gap is capped at the target even in checkStops (unit)', () => {
  const state = {};
  SignalPaper.init(state);
  const T = Date.parse('2026-09-05T10:00:00.000Z');
  state.signalPositions.push({
    id: 'bitcoin-' + T, coinId: 'bitcoin', symbol: 'BTC', status: 'OPEN',
    enteredAt: T, entryPrice: 100, quantity: 1, stop: 95, target: 110,
    label: 'BUY', grade: 'A+', source: 'auto-signal', paper: true
  });
  // Price gapped to 115: a resting limit at 110 cannot fill at 114.885.
  let fills = SignalPaper.checkStops(state, {
    bitcoin: { coinId: 'bitcoin', source: 'live', status: 'fresh', price: 115, asOf: T + 60000 }
  }, T + 60000);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].reason, 'TAKE_PROFIT');
  assert.ok(Math.abs(fills[0].price - 110 * 0.999) < 1e-9, 'capped at target minus slippage');
});

test('scan refuses to trade without hourly history', async t => {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/coins/markets') && u.includes('sparkline=true')) {
      // CoinLore-shaped answer: no sparkline → nothing to analyse.
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => Array.from({ length: 60 }, (_, i) => ({
          id: 'alt-' + i, symbol: 'a' + i, current_price: 1, market_cap: 1e9,
          total_volume: 1e6, market_cap_rank: i + 1, last_updated: new Date(clock).toISOString()
        }))
      };
    }
    return Promise.reject(new Error('unreachable: ' + u));
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const space = 'auto-nohist';
  const T = Date.parse('2026-09-06T10:00:00.000Z');
  clock = T;
  const r = await monitor.tick({ now: T, space, force: true });
  assert.equal(r.ok, true, 'a failed scan never breaks the heartbeat');
  assert.equal(r.signalScan.status, 'no-data');
  assert.equal(r.signalScan.reason, 'no-hourly-history');
  const s = await stateOf(space);
  assert.equal(s.signalQueue.length, 0, 'no fabricated observations');
});

/* ------------------------------------------------------------ engine core */

test('engine: universe evaluation grades an A+ uptrend and keeps NEU out', () => {
  const btc = { id: 'bitcoin', sym: 'BITCOIN', spark: upSeries(), mcap: 1e12, vol24: 1e10 };
  const flat = { id: 'flat', sym: 'FLAT', spark: FLAT, mcap: 1e10, vol24: 1e8 };
  const result = Engine.evaluateUniverse([btc, flat], { th: 25 });
  assert.equal(result.btc, btc, 'anchor found by id');
  assert.equal(btc.grade, 'A+', 'steady uptrend passes all eight factors');
  assert.equal(btc.confCount, 8);
  assert.equal(btc.conf8.anchor, true, 'the anchor is aligned with itself');
  assert.equal(flat.grade, '—', 'flat coins are never graded');
  assert.equal(flat.conf8, null);
  assert.equal(Engine.gradeOf(8), 'A+');
  assert.equal(Engine.gradeOf(7), 'A');
  assert.equal(Engine.gradeOf(6), 'B+');
  assert.equal(Engine.gradeOf(5), 'B');
  assert.equal(Engine.gradeOf(4), 'C');
  assert.equal(Engine.gradeOf(3), 'D');
});

test('engine: class edge requires at least eight trades per label', () => {
  const cw = Engine.classEdge({
    BUY: { n: 8, winRate: 0.6 },
    SELL: { n: 7, winRate: 0.9 },
    NEU: { n: 20, winRate: 1 }
  });
  assert.deepEqual(cw, { BUY: 0.6 });
  assert.deepEqual(Engine.classEdge(null), {});
});

/* ----------------------------------------------------------- cryptoquant */

test('cryptoquant: parsing, z-score gate and configuration states', async t => {
  delete process.env.CRYPTOQUANT_API_KEY;
  delete process.env.ONCHAIN_GATE;
  OnChain.resetCache();
  t.after(() => { delete process.env.CRYPTOQUANT_API_KEY; OnChain.resetCache(); });

  // Envelope tolerance.
  assert.deepEqual(OnChain.rowsOf({ result: { data: [1, 2] } }), [1, 2]);
  assert.deepEqual(OnChain.rowsOf({ data: [3] }), [3]);
  assert.equal(OnChain.rowsOf({ status: 'fail' }), null);

  // No key → honest status, never a veto.
  let ctx = await OnChain.getContext({ fetch: () => Promise.reject(new Error('must not be called')) });
  assert.equal(ctx.status, 'not-configured');
  assert.equal(ctx.veto, false);

  // Pure decision logic.
  const ok = { status: 'ok', netflow: { latest: 900, z: 5, samples: 14 }, sopr: { latest: 1.0, samples: 14 } };
  assert.deepEqual(OnChain.decide(ok), { veto: true, reasons: ['netflow-spike'] });
  assert.deepEqual(
    OnChain.decide({ status: 'ok', netflow: { latest: 100, z: 0.2, samples: 14 }, sopr: { latest: 1.08, samples: 14 } }),
    { veto: true, reasons: ['sopr-profit-taking'] });
  assert.deepEqual(
    OnChain.decide({ status: 'ok', netflow: { latest: 100, z: 0.2, samples: 14 }, sopr: { latest: 0.99, samples: 14 } }),
    { veto: false, reasons: [] });
  process.env.ONCHAIN_GATE = 'off';
  assert.deepEqual(OnChain.decide(ok), { veto: false, reasons: [] });
  delete process.env.ONCHAIN_GATE;

  // Full fetch path with a stubbed CryptoQuant API.
  process.env.CRYPTOQUANT_API_KEY = 'cq-key';
  OnChain.resetCache();
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(i === 13 ? 900 : 95 + (i % 5));
  const ctx2 = await OnChain.getContext({
    fetch: async url => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        status: 'success',
        result: { data: String(url).includes('/sopr') ? [{ a_sopr: 1.0 }] : rows.map(v => ({ netflow_value: v })) }
      })
    })
  });
  assert.equal(ctx2.status, 'ok');
  assert.equal(ctx2.veto, true);
  assert.equal(ctx2.netflow.z >= 2, true);
});

/* ------------------------------------------------------------- cq proxy */

test('proxy: /api/proxy?src=cq answers without leaking anything', async t => {
  delete process.env.CRYPTOQUANT_API_KEY;
  OnChain.resetCache();
  const out = { statusCode: 0, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: payload => { out.body = payload ? JSON.parse(payload) : null; },
    statusCode: 200
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => out.statusCode, set: v => { out.statusCode = v; }
  });
  await proxy({ method: 'GET', url: '/api/proxy?src=cq', headers: {} }, res);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.status, 'not-configured');
  assert.equal(out.headers['x-radar-provider'], 'cryptoquant');
});
