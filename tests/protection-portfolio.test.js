'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../protection.js');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('async function pfCommit(');
const commitCode = html.slice(start, html.indexOf('\nfunction pfChanged(', start));
const NOW = Date.parse('2026-09-22T12:00:00Z');
const make = () => E.create({ id: 'trade-1', coinId: 'bitcoin', mode: 'live', symbol: 'BTC', quantity: 10,
  entryPrice: 100, stop: 90, target1: 110, enteredAt: NOW - 3600000 }, NOW);

function harness(rows) {
  let raw = JSON.stringify(rows), writes = 0, failWrites = false, queue = Promise.resolve();
  const ctx = vm.createContext({
    state: { pf: JSON.parse(raw) },
    localStorage: {
      getItem: () => raw,
      setItem: (_, next) => { if (failWrites) throw new Error('storage full'); raw = next; writes++; }
    },
    navigator: { locks: { request: (_, action) => { const next = queue.then(action); queue = next.then(() => {}, () => {}); return next; } } }
  });
  vm.runInContext(commitCode + '\nglobalThis.commit = pfCommit;', ctx);
  return { ctx, commit: ctx.commit, rows: () => JSON.parse(raw), writes: () => writes,
    fail: () => { failWrites = true; }, corrupt: () => { raw = '{bad json'; } };
}

test('legacy portfolio records survive protection setup without automatic rules or quantities changing', async () => {
  const legacy = [{ id: 'bitcoin', qty: 10, buy: 100, name: 'Bitcoin', sym: 'BTC' }];
  const h = harness(legacy);
  await h.commit(() => {});
  assert.deepEqual(h.rows(), legacy);
  assert.equal(h.writes(), 0);
  const result = await h.commit(rows => { rows[0].protections = [make()]; });
  assert.equal(result.ok, true);
  assert.equal(h.rows()[0].qty, 10);
  assert.equal(h.rows()[0].buy, 100);
});

test('manual exit and matching remaining portfolio quantity are saved together in one write', async () => {
  const p = E.evaluate(make(), { coinId: 'bitcoin', price: 111, asOf: NOW, source: 'live' }, NOW).position;
  const h = harness([{ id: 'bitcoin', qty: 10, buy: 100, protections: [p] }]);
  const result = await h.commit(rows => {
    const row = rows[0], before = row.protections[0];
    const after = E.recordExecution(before, { signalId: before.pending.id, quantity: 5, price: 112 }, NOW + 1000);
    row.protections[0] = after;
    row.qty -= before.remainingQty - after.remainingQty;
  });
  assert.equal(result.ok, true);
  assert.equal(h.writes(), 1);
  const row = h.rows()[0];
  assert.equal(row.qty, 5);
  assert.equal(row.protections[0].remainingQty, 5);
  assert.equal(row.protections[0].events.at(-1).type, 'EXECUTION_RECORDED');
});

test('quota failure does not reduce displayed holdings or commit a signal/exit in memory', async () => {
  const p = E.evaluate(make(), { coinId: 'bitcoin', price: 85, asOf: NOW, source: 'live' }, NOW).position;
  const h = harness([{ id: 'bitcoin', qty: 10, buy: 100, protections: [p] }]);
  h.fail();
  const result = await h.commit(rows => {
    rows[0].qty = 0;
    rows[0].protections[0] = E.recordExecution(p, { signalId: p.pending.id, quantity: 10, price: 84 }, NOW);
  });
  assert.equal(result.ok, false);
  assert.equal(h.rows()[0].qty, 10);
  assert.equal(h.ctx.state.pf[0].qty, 10);
  assert.equal(h.ctx.state.pf[0].protections[0].status, 'ACTIVE');
});

test('serialized overlapping evaluations emit a given signal only once', async () => {
  const h = harness([{ id: 'bitcoin', qty: 10, buy: 100, protections: [make()] }]);
  const evaluate = rows => {
    const result = E.evaluate(rows[0].protections[0], { coinId: 'bitcoin', price: 85, asOf: NOW, source: 'live' }, NOW);
    rows[0].protections[0] = result.position;
    return result.events.filter(e => e.type === 'SIGNAL').length;
  };
  const results = await Promise.all([h.commit(evaluate), h.commit(evaluate)]);
  assert.equal(results.reduce((sum, r) => sum + r.value, 0), 1);
  assert.equal(h.rows()[0].qty, 10);
  assert.equal(h.rows()[0].protections[0].pending.quantity, 10);
});

test('adding units leaves an existing protection snapshot unchanged', async () => {
  const p = make(), h = harness([{ id: 'bitcoin', qty: 10, buy: 100, protections: [p] }]);
  await h.commit(rows => { rows[0].qty += 5; rows[0].buy = 105; });
  assert.deepEqual(h.rows()[0].protections[0], p);
  assert.equal(h.rows()[0].qty, 15);
});

test('zero-quantity completed positions retain their history and corrupt storage is not overwritten', async () => {
  const p = E.evaluate(make(), { coinId: 'bitcoin', price: 85, asOf: NOW, source: 'live' }, NOW).position;
  const closed = E.recordExecution(p, { signalId: p.pending.id, quantity: 10, price: 84 }, NOW);
  const h = harness([{ id: 'bitcoin', qty: 0, buy: 100, protections: [closed] }]);
  await h.commit(() => {});
  assert.equal(h.rows()[0].protections[0].events.at(-1).type, 'CLOSED');
  h.corrupt();
  const result = await h.commit(rows => rows.splice(0));
  assert.equal(result.ok, false);
  assert.equal(h.writes(), 0);
});
