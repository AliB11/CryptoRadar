'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../momentum.js');

const NOW = Date.parse('2026-09-22T12:00:00Z');
const T = E.THRESHOLDS;
const supportive = { now: NOW, btc: { ch24: 1.2, score: 22 }, dominance: 54.2, marketCh24: 1.8, fearGreed: 28 };

function pullbackPath() {
  const prices = [];
  for (let i = 0; i < 96; i++) prices.push(100 + i * 0.04);
  for (let i = 1; i <= 16; i++) prices.push(103.8 + i * 0.85);
  prices.push(116.2, 115.4, 114.6, 114.1, 113.8, 114.0, 113.9, 114.3);
  return prices;
}

function base(extra) {
  const prices = extra && extra.prices ? extra.prices : pullbackPath();
  const price = extra && extra.price != null ? extra.price : prices[prices.length - 1];
  const ch24 = extra && extra.ch24 != null ? extra.ch24 : (price / prices[prices.length - 25] - 1) * 100;
  return {
    id: 'example', symbol: 'EX', name: 'Example', price, ch24,
    vol24: 82e6, mcap: 1.2e9, historyDays: 400, ch30d: 12, ch200d: 40,
    prices, high24: Math.max(...prices.slice(-24)), low24: Math.min(...prices.slice(-24)),
    source: 'live', ...extra, prices: extra && extra.prices === null ? undefined : prices
  };
}

const screen = (extra, ctx) => E.screen(base(extra), ctx || supportive);
const codes = row => row.reasons.map(r => r.code);

test('clean pullback inside the band is a watchlist approval and never a market buy', () => {
  const before = JSON.stringify(base());
  const row = screen();
  assert.equal(JSON.stringify(base()), before, 'input is not mutated');
  assert.equal(row.ok, true);
  assert.equal(row.hardPass, true);
  assert.equal(row.verdict, 'approve');
  assert.equal(row.verdictLabel, 'تأیید برای واچ‌لیست');
  assert.ok(['low', 'medium'].includes(row.risk), row.risk + ' ' + JSON.stringify(row.structure));
  assert.equal(row.plan.marketAtHighForbidden, true);
  assert.ok(row.plan.stop < row.plan.entry);
  assert.ok(row.plan.entry <= row.quote.price);
  assert.ok(row.plan.tp1 > row.plan.entry);
  assert.ok(Math.abs((row.plan.tp2 - row.plan.entry) / (row.plan.entry - row.plan.stop) - 2.2) < 1e-9);
  assert.ok(row.plan.riskPct >= 2.5 && row.plan.riskPct <= 12);
  assert.equal(row.plan.sizePct <= 25, true);
  assert.equal(row.warnings.some(w => w.code === 'FNG_IGNORED'), true);
  assert.equal(codes(row).includes('BREAKOUT') || row.structure.breakoutValid || row.plan.mode === 'wait-pullback', true);
});

test('fear and greed never changes the verdict, risk or plan', () => {
  const calm = screen({}, { ...supportive, fearGreed: 8 });
  const mania = screen({}, { ...supportive, fearGreed: 96 });
  assert.equal(calm.verdict, mania.verdict);
  assert.equal(calm.risk, mania.risk);
  assert.equal(calm.hardPass, mania.hardPass);
  assert.equal(calm.plan.entry, mania.plan.entry);
  assert.equal(calm.plan.stop, mania.plan.stop);
  assert.equal(calm.environment.fearGreedIgnored, true);
  assert.notEqual(calm.environment.fearGreed, mania.environment.fearGreed);
});

test('liquidity floor is inclusive at 40 million and fails with the observed number', () => {
  const pass = screen({ vol24: T.minVolumeUsd });
  const fail = screen({ vol24: T.minVolumeUsd - 1 });
  assert.equal(pass.filters.liquidity.pass, true);
  assert.equal(pass.filters.liquidity.code, 'VOL_OK');
  assert.equal(fail.filters.liquidity.pass, false);
  assert.equal(fail.filters.liquidity.code, 'VOL_LOW');
  assert.match(fail.filters.liquidity.text, /39\.99M|40\.00M|\$39/);
  assert.equal(fail.verdict, 'reject-filter');
  assert.notEqual(fail.verdict, 'reject-fomo');
});

test('24h band is closed at 10 and 50; above 50 is a FOMO reject', () => {
  assert.equal(screen({ ch24: 10, sparkCh24: 10 }).filters.momentum.code, 'BAND_OK');
  assert.equal(screen({ ch24: 50, sparkCh24: 50 }).filters.momentum.code, 'BAND_OK');
  const quiet = screen({ ch24: 9.99, sparkCh24: 9.99 });
  assert.equal(quiet.filters.momentum.code, 'BAND_LOW');
  assert.equal(quiet.verdict, 'reject-filter');
  const hot = screen({ ch24: 50.01, sparkCh24: 50.01 });
  assert.equal(hot.filters.momentum.code, 'BAND_HIGH');
  assert.equal(hot.risk, 'exit');
  assert.equal(hot.verdict, 'reject-fomo');
  assert.equal(hot.verdictLabel, 'رد به دلیل فومو');
});

test('history fails closed under 30 days, at the boundary, and when unproven', () => {
  const young = screen({ historyDays: 29.9, ch30d: null, ch200d: null, ch1y: null, atlDate: null, listedAt: null });
  assert.equal(young.filters.history.code, 'HISTORY_SHORT');
  assert.equal(young.verdict, 'reject-filter');
  const edge = screen({ historyDays: 30, ch30d: null, ch200d: null, ch1y: null });
  assert.equal(edge.filters.history.pass, true);
  const unknown = screen({ historyDays: null, ch30d: null, ch200d: null, ch1y: null, atlDate: null, listedAt: null });
  assert.equal(unknown.filters.history.code, 'HISTORY_UNKNOWN');
  assert.match(unknown.filters.history.text, /۷/);
  const fromChange = screen({ historyDays: null, ch30d: 4, ch200d: null, ch1y: null, atlDate: null });
  assert.equal(fromChange.filters.history.pass, true);
  assert.equal(fromChange.quote.ageSource, 'change30');
  const recentAtl = screen({
    historyDays: null, ch30d: null, ch200d: null, ch1y: null,
    atlDate: new Date(NOW - 10 * 86400000).toISOString(), listedAt: null
  });
  assert.equal(recentAtl.filters.history.pass, false, 'a recent all-time low does not prove the listing is new, nor that it is old');
});

test('old all-time-low date proves at least that much history even without a 30d print', () => {
  const row = screen({
    historyDays: null, ch30d: null, ch200d: null, ch1y: null,
    atlDate: new Date(NOW - 120 * 86400000).toISOString()
  });
  assert.equal(row.filters.history.pass, true);
  assert.equal(row.quote.ageSource, 'atl');
  assert.ok(row.quote.ageDays >= 119);
});

test('fake boost: wash turnover, explicit boost, attention without depth; trending alone is not a boost', () => {
  const wash = screen({ vol24: 400e6, mcap: 100e6, sparkCh24: null });
  assert.equal(wash.filters.fakeBoost.pass, false);
  assert.equal(wash.filters.fakeBoost.reasons.some(r => r.code === 'WASH_TURNOVER'), true);
  assert.equal(wash.verdict, 'reject-fomo');
  const boosted = screen({ boosted: true, sparkCh24: null });
  assert.equal(boosted.filters.fakeBoost.reasons.some(r => r.code === 'EXPLICIT_BOOST'), true);
  const attention = screen({ trending: true, vol24: 8e6, mcap: 40e6, sparkCh24: null });
  assert.equal(attention.filters.fakeBoost.reasons.some(r => r.code === 'ATTENTION_WITHOUT_DEPTH'), true);
  const organic = screen({ trending: true, sparkCh24: null });
  assert.equal(organic.filters.fakeBoost.pass, true);
  assert.match(organic.filters.fakeBoost.text, /داغ/);
});

test('incoherent 24h print is not treated as a clean momentum day', () => {
  const row = screen({ ch24: 28, sparkCh24: 4 });
  assert.equal(row.filters.fakeBoost.reasons.some(r => r.code === 'PRINT_MISMATCH'), true);
  assert.equal(row.verdict, 'reject-fomo');
  const close = screen({ ch24: 18, sparkCh24: 14 });
  assert.equal(close.filters.fakeBoost.reasons.some(r => r.code === 'PRINT_MISMATCH'), false);
});

test('rejection wick is exit liquidity even when hard filters pass', () => {
  const prices = pullbackPath();
  const price = 104;
  const row = screen({
    price, ch24: 18, sparkCh24: 18,
    high24: 130, low24: 100,
    prices
  });
  assert.equal(row.filters.liquidity.pass, true);
  assert.equal(row.filters.momentum.pass, true);
  assert.equal(row.structure.rejection, true);
  assert.equal(row.risk, 'exit');
  assert.equal(row.riskLabel, 'خطر نقدینگی خروج');
  assert.equal(row.verdict, 'reject-fomo');
  assert.equal(row.plan.actionable, false);
  assert.ok(row.plan.stop < row.plan.entry && row.plan.entry < row.plan.tp1);
});

test('a vertical close at the high can stay on the watchlist but forbids chasing', () => {
  const prices = [];
  for (let i = 0; i < 140; i++) prices.push(100);
  for (let i = 1; i <= 24; i++) prices.push(100 * Math.exp(Math.log(1.28) * i / 24));
  const price = prices[prices.length - 1];
  const ch24 = (price / prices[prices.length - 25] - 1) * 100;
  const row = screen({
    prices, price, ch24, sparkCh24: ch24,
    high24: price, low24: prices[prices.length - 24]
  });
  assert.ok(ch24 > 20 && ch24 < 50, ch24);
  assert.equal(row.hardPass, true);
  assert.equal(row.structure.extended, true);
  assert.equal(row.plan.chasingHigh, true);
  assert.equal(row.plan.marketAtHighForbidden, true);
  assert.ok(row.plan.entry < price * 0.995);
  assert.notEqual(row.risk, 'low');
  assert.equal(row.verdict, 'approve');
  assert.equal(row.plan.mode, 'wait-pullback');
});

test('hostile bitcoin raises risk but a clean holding breakout is not auto-labeled exit liquidity', () => {
  const calm = screen();
  const hostile = screen({}, { now: NOW, btc: { ch24: -4.2, score: -30 }, dominance: 58, marketCh24: -1, fearGreed: 12 });
  assert.equal(hostile.environment.stance, 'hostile');
  assert.equal(calm.environment.stance, 'supportive');
  const order = { low: 0, medium: 1, high: 2, exit: 3 };
  assert.ok(order[hostile.risk] >= order[calm.risk]);
  if (calm.structure.rejection) assert.equal(hostile.verdict, 'reject-fomo');
  else assert.notEqual(hostile.risk, 'low');
});

test('dominance-up proxy while bitcoin is red is a hostile environment', () => {
  const env = E.environmentOf({ btc: { ch24: -1.2, score: 4 }, marketCh24: -4, dominance: 57 });
  assert.ok(env.domDelta >= 1.5);
  assert.equal(env.stance, 'hostile');
  const risingAlts = E.environmentOf({ btc: { ch24: 0.4, score: 18 }, marketCh24: 2.1, dominance: 52 });
  assert.equal(risingAlts.stance, 'supportive');
  assert.equal(E.environmentOf({}).stance, 'unknown');
});

test('BUY2 label and a flattering RSI field cannot override a failed volume filter', () => {
  const row = screen({ vol24: 1e6, label: 'BUY2', grade: 'A+', rsi: 20, finalScore: 80 });
  assert.equal(row.filters.liquidity.pass, false);
  assert.notEqual(row.verdict, 'approve');
});

test('leveraged instruments are outside the framework', () => {
  const row = screen({ leveraged: true, symbol: 'ETH3L' });
  assert.equal(row.filters.instrument.code, 'LEVERAGED');
  assert.notEqual(row.verdict, 'approve');
});

test('manual input without a path cannot be low risk and does not invent a breakout', () => {
  const row = E.screen({
    symbol: 'sol', price: '210.5', ch24: '18%', vol24: '80,000,000',
    historyDays: '120', mcap: 90000000000, source: 'manual', chartStatus: 'unknown'
  }, supportive);
  assert.equal(row.ok, true);
  assert.equal(row.symbol, 'SOL');
  assert.equal(row.quote.ch24, 18);
  assert.equal(row.quote.vol24, 8e7);
  assert.equal(row.hardPass, true);
  assert.notEqual(row.risk, 'low');
  assert.equal(row.structure.breakoutValid, false);
  assert.equal(row.structure.smartMoney, 'unavailable');
  assert.equal(row.warnings.some(w => w.code === 'AGE_DECLARED'), true);
  const labeled = E.screen({ symbol: 'SOL', price: 20, ch24: 16, vol24: 60e6, historyDays: 200, chartStatus: 'breakout', source: 'manual' }, supportive);
  assert.equal(labeled.structure.breakoutValid, false);
  assert.equal(labeled.warnings.some(w => w.code === 'CHART_LABEL'), true);
  assert.equal(row.warnings.some(w => w.code === 'SMART_UNAVAILABLE'), true);
  assert.equal(row.verdict, 'approve');
  assert.equal(row.plan.actionable, true);
  assert.match(row.plan.text, /سقف/);
});

test('chart status rejection fails closed without candles', () => {
  const row = E.screen({
    symbol: 'AAA', price: 2, ch24: 22, vol24: 50e6, historyDays: 200, chartStatus: 'rejection', source: 'manual'
  }, supportive);
  assert.equal(row.structure.rejection, true);
  assert.equal(row.risk, 'exit');
  assert.equal(row.verdict, 'reject-fomo');
});

test('simulation cannot be presented as a live low-risk approval', () => {
  const row = screen({ source: 'simulation', ageAssumed: true, historyDays: 800 });
  assert.equal(row.source, 'simulation');
  assert.notEqual(row.risk, 'low');
  assert.equal(row.warnings.some(w => w.code === 'SIMULATION'), true);
});

test('invalid manual numbers do not throw and do not approve', () => {
  for (const input of [
    {},
    { symbol: '<script>', price: 1, ch24: 20, vol24: 50e6 },
    { symbol: 'BTC', price: 0, ch24: 20, vol24: 50e6 },
    { symbol: 'BTC', price: 1, ch24: 'nope', vol24: 50e6 },
    { symbol: 'BTC', price: 1, ch24: 20, vol24: -5 }
  ]) {
    const row = E.screen(input, supportive);
    assert.equal(row.ok, false);
    assert.equal(row.verdict, undefined);
  }
});

test('universe summary counts passes and keeps FOMO out of the approval list', () => {
  const prices = pullbackPath();
  const price = prices[prices.length - 1];
  const ch24 = (price / prices[prices.length - 25] - 1) * 100;
  const good = base({ symbol: 'GOOD', ch24, sparkCh24: ch24 });
  const thin = base({ symbol: 'THIN', vol24: 2e6, ch24, sparkCh24: ch24 });
  const fomo = base({ symbol: 'FOMO', ch24: 70, sparkCh24: 70 });
  const board = E.screenAll([good, thin, fomo, { symbol: 'bad' }], supportive);
  assert.equal(board.invalid, 1);
  assert.equal(board.counts.scanned, 3);
  assert.equal(board.counts.approved, 1);
  assert.equal(board.approved[0].symbol, 'GOOD');
  assert.equal(board.counts.fomo, 1);
  assert.equal(board.fomo[0].symbol, 'FOMO');
  assert.equal(board.counts.failLiquidity >= 1, true);
  assert.equal(board.approved.some(r => r.verdict !== 'approve'), false);
});

test('terminal page wires an independent screener and does not feed it the buy score', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /momentum\.js/);
  assert.match(html, /id="secMomentum"/);
  assert.match(html, /function renderMomentum\(/);
  assert.match(html, /price_change_percentage=1h,24h,7d,30d,200d,1y/);
  assert.equal(html.includes('RadarMomentum.screen(c.finalScore'), false);
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(sw, /momentum\.js/);
  assert.match(sw, /radar-shell-v3-momentum/);
});
