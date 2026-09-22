'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../protection.js');
const NOW = Date.parse('2026-09-22T12:00:00Z');
const input = extra => ({ id: 'trade-1', coinId: 'bitcoin', symbol: 'BTC', mode: 'live', entryPrice: 100,
  quantity: 10, enteredAt: NOW - 3600000, stop: 90, target1: 110, target2: 125,
  target1Pct: 50, breakeven: true, ...extra });
const make = extra => E.create(input(extra), NOW);
const quote = (price, extra) => ({ coinId: 'bitcoin', price, asOf: NOW, source: 'live', status: 'fresh', ...extra });
const run = (p, price, extra, now = NOW) => E.evaluate(p, quote(price, extra), now);
const restored = p => JSON.parse(JSON.stringify(p));
const signals = result => result.events.filter(e => e.type === 'SIGNAL');
const execute = (p, quantity, price = 110) => E.recordExecution(p, { signalId: p.pending.id, quantity, price }, NOW + 1000);

test('creates an immutable-in-practice snapshot with trade id and entry time; legacy positions are not auto-armed', () => {
  const p = make();
  assert.equal(p.enteredAt, NOW - 3600000);
  assert.equal(p.plan.initialStop, 90);
  assert.equal(p.remainingQty, 10);
  assert.equal(E.validPosition(restored(p)), true);
  assert.equal(E.active({ id: 'bitcoin', qty: 10, buy: 100 }), false);
  assert.equal(E.validPosition({ version: 1 }), false);
  assert.equal(E.validPosition({ ...p, remainingQty: -1 }), false);
  assert.equal(E.validPosition({ ...p, plan: { ...p.plan, trailActivation: null } }), false);
  assert.equal(E.validPosition({ ...p, stop: 200 }), false);
});

test('rejects invalid numbers, levels, percentages and future entry times', () => {
  for (const extra of [{ entryPrice: 0 }, { entryPrice: Infinity }, { quantity: -1 }, { stop: 0 }, { stop: 100 },
    { entryPrice: 1e308, quantity: 10 }, { stop: NaN }, { target1: 99 }, { target2: 105 }, { target1Pct: 100 }, { target1Pct: 0 },
    { trailPct: -3 }, { trailPct: 100 }, { maxHours: -1 }, { invalidation: 90 }, { invalidation: 101 },
    { enteredAt: NOW + 1 }, { enteredAt: NaN }, { coinId: '../bitcoin' }, { mode: 'unknown' }])
    assert.throws(() => make(extra), JSON.stringify(extra));
});

test('optional rules stay disabled; no risk percentages are silently selected', () => {
  const p = make({ target1: '', target2: '', trailPct: '', maxHours: '', invalidation: '' });
  for (const name of ['target1', 'target2', 'trailPct', 'maxHours', 'invalidation']) assert.equal(p.plan[name], null);
  assert.equal(signals(run(p, 150)).length, 0);
  assert.equal(run(p, 150).position.stop, 90);
});

test('stop loss fires inclusively despite BUY2, extreme oversold RSI or high grade', () => {
  const p = { ...make(), label: 'BUY2', rsi: 0, grade: 'A+' };
  const result = run(p, 90);
  assert.equal(signals(result).length, 1);
  assert.equal(result.position.pending.action, 'EXIT_LONG');
  assert.equal(result.position.pending.reason, 'STOP_LOSS');
  assert.equal(result.position.pending.quantity, 10);
  assert.equal(result.position.remainingQty, 10, 'an advisory is not a fill');
  assert.equal(p.pending, null, 'input not mutated');
});

test('gap below stop uses observed price, not a fabricated fill at the stop', () => {
  const p = run(make(), 70).position;
  assert.equal(p.pending.observedPrice, 70);
  assert.equal(p.remainingQty, 10);
  assert.equal(p.events.some(e => e.type === 'EXECUTION_RECORDED'), false);
});

test('target 1 produces one half-exit advisory, including after serialization/reload', () => {
  const first = run(make(), 110);
  assert.equal(first.position.pending.action, 'REDUCE_LONG');
  assert.equal(first.position.pending.quantity, 5);
  assert.equal(first.position.stop, 90, 'do not assume target fill');
  const next = run(restored(first.position), 112, { asOf: NOW + 1000 }, NOW + 1000);
  assert.equal(signals(next).length, 0);
  assert.equal(next.position.pending.id, first.position.pending.id);
  assert.equal(next.position.remainingQty, 10);
});

test('manual partial fills retain pending quantity and promote stop only after first target completion', () => {
  const signalled = run(make(), 110).position;
  const partial = execute(signalled, 2);
  assert.equal(partial.remainingQty, 8);
  assert.equal(partial.pending.quantity, 3);
  assert.equal(partial.stop, 90);
  const completed = execute(partial, 3);
  assert.equal(completed.remainingQty, 5);
  assert.equal(completed.pending, null);
  assert.equal(completed.target1Completed, true);
  assert.equal(completed.stop, 100);
  assert.equal(completed.plan.initialStop, 90);
  assert.equal(completed.events.filter(e => e.type === 'EXECUTION_RECORDED').length, 2);
  const stop = run(completed, 99, { asOf: NOW + 2000 }, NOW + 2000).position;
  assert.equal(stop.pending.reason, 'BREAKEVEN_STOP');
  assert.equal(stop.pending.quantity, 5);
});

test('full exit outranks pending partial exit and cannot be undone by price recovery', () => {
  const partial = run(make(), 110).position;
  const result = run(partial, 85, { asOf: NOW + 1000 }, NOW + 1000);
  assert.equal(result.position.pending.action, 'EXIT_LONG');
  assert.equal(result.position.pending.quantity, 10);
  assert.equal(result.events.some(e => e.type === 'SUPERSEDED'), true);
  assert.equal(signals(result).length, 1);
  assert.throws(() => E.recordExecution(result.position, { signalId: partial.pending.id, quantity: 5, price: 110 }, NOW));
  const recovered = run(result.position, 115, { asOf: NOW + 2000 }, NOW + 2000);
  assert.equal(recovered.position.pending.id, result.position.pending.id);
  assert.equal(signals(recovered).length, 0);
});

test('an unfilled final-profit exit is escalated once when a protective stop later triggers', () => {
  const profit = run(make(), 130).position;
  assert.equal(profit.pending.reason, 'TARGET_2');
  const loss = run(profit, 85, { asOf: NOW + 1000 }, NOW + 1000);
  assert.equal(loss.position.pending.reason, 'STOP_LOSS');
  assert.equal(loss.position.pending.quantity, 10);
  assert.equal(signals(loss).length, 1);
  assert.equal(loss.events.some(e => e.type === 'SUPERSEDED'), true);
  const rebound = run(loss.position, 130, { asOf: NOW + 2000 }, NOW + 2000);
  assert.equal(rebound.position.pending.reason, 'STOP_LOSS');
  assert.equal(signals(rebound).length, 0);
});

test('gap above both targets creates only the final exit, not two sell advisories', () => {
  const result = run(make(), 130);
  assert.equal(signals(result).length, 1);
  assert.equal(result.position.pending.reason, 'TARGET_2');
  assert.equal(result.position.pending.quantity, 10);
});

test('second target exits remaining units after recorded reduction', () => {
  const half = execute(run(make(), 110).position, 5);
  const final = run(half, 125, { asOf: NOW + 2000 }, NOW + 2000).position;
  assert.equal(final.pending.quantity, 5);
  assert.equal(final.pending.reason, 'TARGET_2');
});

test('trailing starts at 1R, only rises, and remains frozen across reload', () => {
  let p = make({ trailPct: 5, target1: null, target2: null });
  p = run(p, 109).position;
  assert.equal(p.stop, 90);
  assert.equal(p.trailingActive, false);
  p = run(p, 120, { asOf: NOW + 1000 }, NOW + 1000).position;
  assert.equal(p.stop, 114);
  assert.equal(p.highWater, 120);
  p = run(restored(p), 118, { asOf: NOW + 2000 }, NOW + 2000).position;
  assert.equal(p.stop, 114);
  p = run(p, 113, { asOf: NOW + 3000 }, NOW + 3000).position;
  assert.equal(p.pending.reason, 'TRAILING_STOP');
  assert.equal(p.plan.initialStop, 90);
});

test('break-even never lowers a tighter trailing stop', () => {
  let p = run(make({ trailPct: 2 }), 110).position;
  const stop = p.stop;
  p = execute(p, 5);
  assert.equal(p.stop, stop);
  assert(p.stop > 100);
});

test('time limit is measured from actual entry, not reload or registration', () => {
  const p = make({ maxHours: 1 });
  const result = run(p, 101);
  assert.equal(result.position.pending.reason, 'TIME_EXIT');
  assert.equal(run(restored(result.position), 101, { asOf: NOW + 1000 }, NOW + 1000).events.length, 0);
});

test('invalidation price and stop loss have explicit priority', () => {
  assert.equal(run(make({ invalidation: 95 }), 95).position.pending.reason, 'INVALIDATION');
  assert.equal(run(make({ invalidation: 95, maxHours: 1 }), 89).position.pending.reason, 'STOP_LOSS');
});

test('bad or unavailable quotes never generate an exit or remove a protective stop', () => {
  const p = make({ trailPct: 2, maxHours: 1 });
  const variants = [undefined, quote(80, { status: 'stale' }), quote(80, { asOf: NOW - E.MAX_QUOTE_AGE - 1 }),
    quote(80, { source: 'simulation' }), quote(80, { price: NaN }), quote(80, { price: 0 }),
    quote(80, { coinId: 'ethereum' }), quote(80, { asOf: NOW + 60001 }), quote(80, { asOf: NOW - 7200000 })];
  for (const q of variants) {
    const result = E.evaluate(p, q, NOW);
    assert(result.problem);
    assert.equal(result.position, p);
    assert.equal(result.events.length, 0);
    assert.equal(result.position.stop, 90);
  }
});

test('same timestamp corrections and out-of-order prices cannot trigger duplicate or retroactive exits', () => {
  const p = run(make(), 101).position;
  assert.equal(run(p, 80).position.pending, null);
  assert.equal(run(p, 80, { asOf: NOW - 1 }).problem, 'out-of-order');
});

test('simulation and real positions cannot consume each other’s quotes', () => {
  const p = make({ mode: 'simulation', coinId: 'sim-btc' });
  assert.equal(E.evaluate(p, quote(80), NOW).problem, 'source');
  const result = E.evaluate(p, quote(80, { coinId: 'sim-btc', source: 'simulation' }), NOW);
  assert.equal(result.position.pending.reason, 'STOP_LOSS');
});

test('a low-ranked or absent-from-table asset is evaluated solely by its own quote', () => {
  const p = make({ coinId: 'outside-top-100' });
  const result = E.evaluate(p, quote(89, { coinId: 'outside-top-100' }), NOW);
  assert.equal(result.position.pending.reason, 'STOP_LOSS');
});

test('execution requires the current signal and valid actual quantities/prices', () => {
  assert.throws(() => execute(make(), 2));
  const p = run(make(), 80).position;
  for (const quantity of [0, -1, 11, Infinity, NaN]) assert.throws(() => execute(p, quantity));
  for (const price of [0, -1, Infinity, NaN]) assert.throws(() => execute(p, 1, price));
  const partial = execute(p, 4, 79);
  assert.equal(partial.remainingQty, 6);
  assert.equal(partial.pending.quantity, 6);
  assert.equal(partial.events.at(-1).grossPnl, -84);
  const closed = execute(partial, 6, 78);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.remainingQty, 0);
  assert.equal(E.validPosition(closed), true);
  assert.equal(E.active(closed), false);
  assert.equal(run(closed, 50).events.length, 0);
  assert.throws(() => execute(closed, 1));
});

test('tiny fractional quantities and floating-point target fills do not oversell or leave dust', () => {
  const p = run(make({ quantity: 0.00000001 }), 110).position;
  const half = execute(p, 0.000000005);
  assert.equal(half.remainingQty, 0.000000005);
  const final = run(half, 130, { asOf: NOW + 2000 }, NOW + 2000).position;
  assert.equal(execute(final, 0.000000005).status, 'CLOSED');
});

test('cancellation is not a sale and preserves the audit trail and remaining units', () => {
  const p = run(make(), 80).position;
  const cancelled = E.cancel(p, NOW + 1000);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.remainingQty, 10);
  assert.equal(cancelled.events.at(-1).reason, 'MONITORING_STOPPED_NOT_SOLD');
  assert.equal(run(cancelled, 60).events.length, 0);
  assert.equal(E.validPosition(restored(cancelled)), true);
});

const response = (data, cache = 'MISS') => ({ ok: true, status: 200,
  headers: { get: key => key === 'X-Radar-Cache' ? cache : null }, json: async () => data });
const row = (id, price = 89) => ({ id, current_price: price, last_updated: new Date(NOW).toISOString(), sparkline_in_7d: { price: [999] } });

test('quote adapter requests portfolio ids directly, not market ranks, and uses current_price plus upstream timestamp', async () => {
  let requested;
  const quotes = await E.fetchQuotes(['outside-top-100', 'outside-top-100'], { now: () => NOW, fetch: async url => {
    requested = new URL(url, 'https://preview.example'); return response([row('outside-top-100')]);
  } });
  assert.equal(requested.pathname, '/api/proxy');
  assert.equal(requested.searchParams.get('ids'), 'outside-top-100');
  assert.equal(requested.searchParams.get('sparkline'), 'false');
  assert.equal(quotes['outside-top-100'].price, 89);
  assert.equal(quotes['outside-top-100'].asOf, NOW);
  assert.equal(quotes['outside-top-100'].status, 'fresh');
});

test('stale proxy response is rejected without relabeling it live or silently retrying it as fresh', async () => {
  let calls = 0;
  const quotes = await E.fetchQuotes(['bitcoin'], { now: () => NOW, fetch: async () => { calls++; return response([row('bitcoin')], 'STALE'); } });
  assert.equal(calls, 1);
  assert.equal(quotes.bitcoin.status, 'stale');
  assert.equal(run(make(), quotes.bitcoin.price, quotes.bitcoin).events.length, 0);
});

test('direct fallback is timestamp-validated and malformed/missing rows are not fabricated', async () => {
  const urls = [];
  const quotes = await E.fetchQuotes(['bitcoin', 'missing-coin', 'bad-time', 'old-price'], { now: () => NOW, fetch: async url => {
    urls.push(url);
    if (url.startsWith('/api/')) throw new Error('proxy unavailable');
    return response([row('bitcoin'), { ...row('bad-time'), last_updated: null }, { ...row('old-price'), last_updated: new Date(NOW - 3600000).toISOString() }]);
  } });
  assert.equal(urls.length, 2);
  assert(urls[1].startsWith('https://api.coingecko.com/'));
  assert.equal(quotes.bitcoin.status, 'fresh');
  assert.equal(quotes['missing-coin'].status, 'missing');
  assert.equal(quotes['bad-time'].status, 'invalid');
  assert.equal(quotes['old-price'].status, 'stale');
});

test('failed quote requests and simulated ids never produce manufactured live quotes', async () => {
  let calls = 0;
  const quotes = await E.fetchQuotes(['bitcoin', 'sim-btc', '../bad'], { now: () => NOW, fetch: async () => { calls++; throw new Error('offline'); } });
  assert.equal(calls, 2);
  assert.equal(quotes.bitcoin.status, 'error');
  assert.equal(quotes['sim-btc'], undefined);
  assert.equal(quotes['../bad'], undefined);
});

test('quote requests are batched without dropping held assets', async () => {
  let calls = 0;
  const ids = Array.from({ length: 101 }, (_, i) => 'asset-' + i);
  const quotes = await E.fetchQuotes(ids, { now: () => NOW, fetch: async url => {
    calls++; const ids = new URL(url, 'https://preview.example').searchParams.get('ids').split(',');
    return response(ids.map(id => row(id)));
  } });
  assert.equal(calls, 3);
  assert.equal(Object.keys(quotes).length, 101);
});

test('protection signals declare a met condition, not a forecast, and the saved snapshot rejects rule edits', () => {
  const result = run(make(), 90);
  assert.equal(result.position.pending.conditionMet, true);
  assert.equal(result.position.pending.certainty, 'CONDITION_MET');
  assert.equal(E.validPosition({ ...result.position, plan: { ...result.position.plan, target1: 111 } }), false);
  assert.equal(E.validPosition({ ...result.position, events: result.position.events.slice(0, -1) }), false);
});

test('large positions do not turn a meaningful remaining quantity into floating-point dust', () => {
  const p = run(make({ quantity: 1e12, target1: '', target2: '' }), 80).position;
  const partial = execute(p, 1, 79);
  assert.equal(partial.status, 'ACTIVE');
  assert.equal(partial.remainingQty, 999999999999);
  assert.equal(partial.pending.quantity, 999999999999);
});
