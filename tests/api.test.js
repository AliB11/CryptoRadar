/**
 * API surface tests.
 *
 * The reported failure mode was never a broken rule engine — it was the seam
 * between the two halves: the page recording a signal, and the tick that is
 * supposed to execute it. These tests drive the real HTTP handlers end to end,
 * the way the browser and the scheduler actually call them.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-api-'));
process.env.RADAR_STORE_FILE = path.join(tmp, 'kv.json');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.RADAR_SPACE = 'api';
process.env.PULSE_INTERVAL_SEC = '90';
process.env.PAPER_AUTO_EXEC = 'true';

const pulse = require('../api/pulse.js');
const state = require('../api/state.js');
const Protection = require('../protection.js');

/** Minimal req/res pair matching the contract the handlers use. */
function harness(options = {}) {
  const req = {
    method: options.method || 'GET',
    url: options.url || '/',
    headers: options.headers || {},
    body: options.body
  };
  const out = { statusCode: 0, headers: {}, body: null, res: null };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: payload => { out.body = payload ? JSON.parse(payload) : null; },
    statusCode: 200
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => out.statusCode, set: v => { out.statusCode = v; }
  });
  out.res = res;
  return { req, res, out };
}

async function callPulse(options) {
  const { req, res, out } = harness(options);
  await pulse(req, res);
  return { status: out.statusCode, body: out.body };
}

async function callState(options) {
  const { req, res, out } = harness(options);
  await state(req, res);
  return { status: out.statusCode, body: out.body };
}

function fakeFetch(market) {
  return async url => {
    const target = new URL(String(url), 'https://preview.example');
    const ids = (target.searchParams.get('ids') || '').split(',').filter(Boolean);
    const rows = ids.filter(id => market[id] != null).map(id => ({
      id, current_price: market[id].price, last_updated: new Date(market[id].asOf).toISOString()
    }));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => rows };
  };
}

const TOKEN = 'radar-token-for-tests';
const CRON = 'cron-secret-for-tests';

/** Run `body` with RADAR_TOKEN configured, the way a deployment would be. */
async function withToken(body) {
  const previous = process.env.RADAR_TOKEN;
  process.env.RADAR_TOKEN = TOKEN;
  try { return await body(); } finally {
    if (previous === undefined) delete process.env.RADAR_TOKEN;
    else process.env.RADAR_TOKEN = previous;
  }
}

test('a browser token may ask for a cycle even when a cron secret is configured', async () => {
  process.env.RADAR_TOKEN = TOKEN;
  process.env.CRON_SECRET = CRON;
  try {
    // Without this the page could never drive the heartbeat on a deployment
    // that set CRON_SECRET for Vercel Cron — the monitor would only wake once
    // a day, which is how "nothing ever executes" starts.
    const byCron = await callPulse({ url: '/api/pulse?status=1', headers: { authorization: 'Bearer ' + CRON } });
    assert.equal(byCron.status, 200);
    assert.equal(byCron.body.mode, 'status');

    const byToken = await callPulse({ url: '/api/pulse?status=1', headers: { 'x-radar-token': TOKEN } });
    assert.equal(byToken.status, 200, JSON.stringify(byToken.body));

    const wrong = await callPulse({ url: '/api/pulse?status=1', headers: { 'x-radar-token': 'nope' } });
    assert.equal(wrong.status, 401);
  } finally {
    delete process.env.RADAR_TOKEN;
    delete process.env.CRON_SECRET;
  }
});

test('the page can push a portfolio and then execute it through the tick it triggers', () => withToken(async () => {
  const space = 'loop';
  const now = Date.now();
  const enteredAt = now - 6 * 3600 * 1000;
  const position = Protection.create({
    id: 'pos-loop', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 2, enteredAt, stop: 90, target1: 120, target1Pct: 50, breakeven: true
  }, enteredAt);

  // 1 — the browser mirrors its portfolio (live.js pushUp), with base = version read.
  const empty = await callState({ url: '/api/state?space=' + space, headers: { 'x-radar-token': TOKEN } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.portfolio.length, 0);
  const put = await callState({
    method: 'PUT', url: '/api/state?space=' + space, headers: { 'x-radar-token': TOKEN },
    body: { base: empty.body.version, portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [position] }], alerts: [] }
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.portfolio.length, 1);

  // 2 — the same page flags the crossed stop on its own 90-second clock and
  //     pushes that copy up, exactly like ProtectionView.refresh() does.
  const evaluated = Protection.evaluate(position,
    { coinId: 'bitcoin', price: 85, asOf: now - 1000, source: 'live' }, now);
  assert.equal(evaluated.position.pending.reason, 'STOP_LOSS');
  const put2 = await callState({
    method: 'PUT', url: '/api/state?space=' + space, headers: { 'x-radar-token': TOKEN },
    body: { base: put.body.version, portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [evaluated.position] }], alerts: [] }
  });
  assert.equal(put2.status, 200, JSON.stringify(put2.body));

  // 3 — the page (or any scheduler) asks for a cycle; the tick must execute the
  //     standing signal instead of leaving it flagged forever.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  let tick;
  try {
    tick = await callPulse({ url: '/api/pulse?space=' + space + '&force=1', headers: { 'x-radar-token': TOKEN } });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(tick.status, 200, JSON.stringify(tick.body));
  assert.equal(tick.body.fills.length, 1, 'the paper engine must book the fill');
  assert.equal(tick.body.adopted.length, 1);

  // 4 — the browser reads the ledger and the closed plan back.
  const after = await callState({ url: '/api/state?space=' + space, headers: { 'x-radar-token': TOKEN } });
  assert.equal(after.body.ledger.length, 1);
  assert.equal(after.body.ledger[0].paper, true);
  assert.equal(after.body.portfolio[0].protections[0].status, 'CLOSED');
  assert.equal(after.body.pulse.lastSummary.fills, 1);

  // 5 — and a stale tab can no longer overwrite that fill: the version moved.
  const stale = await callState({
    method: 'PUT', url: '/api/state?space=' + space, headers: { 'x-radar-token': TOKEN },
    body: { base: 1, portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [position] }], alerts: [] }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version-conflict');
  assert.equal(stale.body.portfolio[0].protections[0].status, 'CLOSED');
}));

test('pulse status answers the page with a cadence it can schedule against', async () => {
  const space = 'status-shape';
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    await callPulse({ url: '/api/pulse?space=' + space + '&force=1' });
  } finally { globalThis.fetch = realFetch; }

  const status = await callPulse({ url: '/api/pulse?status=1&space=' + space });
  assert.equal(status.status, 200);
  assert.equal(status.body.mode, 'status');
  assert.ok(status.body.pulse.lastRun > 0, 'the heartbeat must be readable');
  assert.ok(status.body.nextInMs >= 0);
  assert.equal(status.body.late, false);
  assert.equal(status.body.pulse.lastSummary.positions, 0);
});

test('state refuses to serve without the token once one is configured', async () => {
  process.env.RADAR_TOKEN = TOKEN;
  try {
    const refused = await callState({ url: '/api/state' });
    assert.equal(refused.status, 401);
    const allowed = await callState({ url: '/api/state', headers: { 'x-radar-token': TOKEN } });
    assert.equal(allowed.status, 200);
  } finally {
    delete process.env.RADAR_TOKEN;
  }
});

test('an unconfigured deployment says so instead of handing out its state', async () => {
  const previous = process.env.RADAR_TOKEN;
  delete process.env.RADAR_TOKEN;
  try {
    const answer = await callState({ url: '/api/state' });
    assert.equal(answer.status, 503);
    assert.equal(answer.body.error, 'not-configured');
  } finally {
    if (previous) process.env.RADAR_TOKEN = previous;
  }
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
