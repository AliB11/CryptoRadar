'use strict';
/**
 * Server-side monitoring tick.
 *
 * This is the part of CryptoRadar that has to keep running when no browser is
 * open. It reuses the *same* rule engine the page uses (`protection.js`), so a
 * stop loss means exactly the same thing on the server as it does in the
 * terminal — there is no second, divergent implementation to keep in sync.
 *
 * What it does on every tick:
 *   1. take a short-lived lock so overlapping scheduler hits cannot double-run
 *   2. fetch independent quotes (current_price + last_updated per coin id)
 *   3. evaluate every active protection plan
 *   4. in paper mode, book the resulting fills automatically
 *   5. evaluate price alerts
 *   6. push a Web Push notification for anything that fired
 *   7. persist state + heartbeat
 *
 * Paper mode never touches an exchange. Every booked fill is marked
 * `paper: true` and lands in a separate ledger.
 */

const Protection = require('../protection.js');
const store = require('./store.js');
const push = require('./push.js');

const DEFAULT_INTERVAL = 90;
const MAX_INTERVAL = 3600;
const MIN_INTERVAL = 30;
const DEFAULT_SLIPPAGE_BPS = 10;   // 0.10% — a deliberately pessimistic exit
const DUE_TOLERANCE_MS = 4000;     // schedulers drift; do not waste a tick on it

const STOP_LIKE = new Set(['STOP_LOSS', 'TRAILING_STOP', 'BREAKEVEN_STOP', 'INVALIDATION']);

const key = (space, name) => 'space:' + space + ':' + name;

const num = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function reasonLabel(reason) {
  return ({
    STOP_LOSS: 'حد ضرر اولیه',
    TRAILING_STOP: 'حد ضرر متحرک',
    BREAKEVEN_STOP: 'حد ضرر در نقطهٔ ورود',
    INVALIDATION: 'ابطال قیمتی',
    TIME_EXIT: 'پایان مهلت نگهداری',
    TARGET_1: 'هدف اول',
    TARGET_2: 'هدف دوم'
  })[reason] || reason || 'خروج';
}

/**
 * Fill model for the paper engine.
 *
 * A protective stop is a market order into a falling price, so it fills below
 * the observed trigger. A profit target behaves like a resting limit, so it
 * fills at the target itself even if the quote has run past it. Both are
 * models of a real venue's behaviour, not quotes: the point is that the
 * paper ledger is slightly pessimistic rather than flattering.
 */
function paperFillPrice(signal, position, slippageBps) {
  const observed = num(signal.observedPrice, 0);
  if (!(observed > 0)) return null;
  const slip = Math.max(0, slippageBps) / 10000;
  if (STOP_LIKE.has(signal.reason)) return observed * (1 - slip);
  const target = signal.reason === 'TARGET_1' ? position.plan.target1 : position.plan.target2;
  const limit = num(target, null);
  if (!limit) return observed * (1 - slip);
  // The quote is normally at or beyond the target; the resting order fills at
  // the target. If the quote is somehow below it, fill at the quote instead —
  // never invent a price the market never printed.
  return Math.min(limit, observed * (1 - slip));
}

function emptyState() {
  return { version: 0, updatedAt: 0, portfolio: [], alerts: [], ledger: [], subscriptions: {} };
}

async function loadState(space) {
  const state = await store.readJSON(key(space, 'state'), null);
  if (!state || typeof state !== 'object') return emptyState();
  return {
    version: num(state.version, 0) || 0,
    updatedAt: num(state.updatedAt, 0) || 0,
    portfolio: Array.isArray(state.portfolio) ? state.portfolio : [],
    alerts: Array.isArray(state.alerts) ? state.alerts : [],
    ledger: Array.isArray(state.ledger) ? state.ledger : [],
    subscriptions: (state.subscriptions && typeof state.subscriptions === 'object')
      ? state.subscriptions : {}
  };
}

/** Publish the heartbeat a browser (or an uptime check) can read. */
async function writePulse(space, pulse) {
  await store.writeJSON(key(space, 'pulse'), pulse);
}

async function readPulse(space) {
  return await store.readJSON(key(space, 'pulse'), null);
}

function vapidConfig() {
  return {
    subject: process.env.VAPID_SUBJECT || '',
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    ttl: num(process.env.PUSH_TTL_SECONDS, 6 * 3600)
  };
}

/**
 * Deliver one message to every registered device. Dead subscriptions
 * (404/410 from the push service) are dropped from the store.
 */
async function broadcast(space, state, payload, log) {
  const endpoints = Object.keys(state.subscriptions || {});
  if (!endpoints.length) return { sent: 0, dropped: 0, disabled: 0 };
  const vapid = vapidConfig();
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    return { sent: 0, dropped: 0, disabled: endpoints.length };
  }
  let sent = 0, dropped = 0;
  const text = JSON.stringify(payload);
  for (const endpoint of endpoints) {
    let result;
    try {
      result = await push.send(state.subscriptions[endpoint], text, vapid);
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    if (result.ok) { sent++; continue; }
    if (result.gone) { delete state.subscriptions[endpoint]; dropped++; continue; }
    log.push({ at: Date.now(), kind: 'push-failed', endpoint: endpoint.slice(-24), status: result.status || null, error: result.error || null });
  }
  return { sent, dropped, disabled: 0 };
}

/**
 * Run one monitoring cycle.
 *
 * Always returns a serialisable summary — an unhandled throw inside a cron
 * invocation is invisible, so failures have to come back in the response.
 */
async function tick(options = {}) {
  const now = num(options.now, Date.now());
  const space = String(options.space || process.env.RADAR_SPACE || 'default').slice(0, 64);
  const intervalSec = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL,
    num(options.intervalSec, num(process.env.PULSE_INTERVAL_SEC, DEFAULT_INTERVAL)) || DEFAULT_INTERVAL));
  const force = options.force === true;
  const log = [];

  const summary = {
    ok: true, space, at: now, intervalSec, force,
    skipped: null, quotes: 0, positions: 0, evaluated: 0,
    signals: [], fills: [], alertsFired: [], push: null,
    problems: [], store: store.backend, log
  };

  // 1 — lock, so two schedulers cannot evaluate the same position twice.
  const lockTtl = Math.min(60000, Math.max(15000, intervalSec * 1000));
  const locked = await store.setnx(key(space, 'lock'), lockTtl);
  if (!locked && !force) {
    const previous = await readPulse(space);
    return {
      ...summary, ok: true, skipped: 'locked',
      lastRun: previous ? previous.lastRun : null,
      nextInMs: previous ? Math.max(0, previous.lastRun + intervalSec * 1000 - now) : intervalSec * 1000
    };
  }

  try {
    const state = await loadState(space);
    const previous = await readPulse(space);

    // 2 — 90-second cadence. The scheduler's frequency and our cadence are
    // deliberately separate: any trigger source (per-minute cron, external
    // pinger, or an open browser) is welcome, but work happens on our clock.
    const dueAt = previous && previous.lastRun ? previous.lastRun + intervalSec * 1000 : 0;
    if (!force && dueAt && now + DUE_TOLERANCE_MS < dueAt) {
      return { ...summary, skipped: 'not-due', lastRun: previous.lastRun, nextInMs: dueAt - now };
    }

    const plans = [];
    for (const row of state.portfolio) {
      if (!Array.isArray(row.protections)) continue;
      for (const position of row.protections) {
        if (Protection.validPosition(position) && Protection.active(position)) plans.push({ row, position });
      }
    }
    summary.positions = plans.length;

    const live = plans.filter(({ position }) => position.mode === 'live');
    const alerts = state.alerts.filter(a => a && !a.triggered && typeof a.id === 'string' && !a.id.startsWith('sim-'));
    const ids = [...new Set([...live.map(p => p.position.coinId), ...alerts.map(a => a.id)])];

    let quotes = {};
    if (ids.length) {
      try {
        quotes = await Protection.fetchQuotes(ids, { now, fetch: globalThis.fetch });
      } catch (error) {
        summary.problems.push({ kind: 'quotes', detail: String(error && error.message || error) });
      }
    }
    // Report usable quotes, not attempted ones: fetchQuotes returns an entry
    // for every requested id, including ones it could not price. Counting
    // those would make a dead upstream look like a healthy tick.
    summary.quotes = Object.values(quotes).filter(q => q && q.status === 'fresh').length;
    summary.quoteAttempts = Object.keys(quotes).length;

    // 3 + 4 — evaluate, and in paper mode book the fill ourselves.
    const autoExec = process.env.PAPER_AUTO_EXEC !== 'false';
    const slippageBps = num(process.env.PAPER_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS);
    let mutated = false;

    for (const plan of plans) {
      const position = plan.position;
      const quote = position.mode === 'simulation'
        ? { coinId: position.coinId, status: 'missing' }
        : quotes[position.coinId];
      let result;
      try {
        result = Protection.evaluate(position, quote, now);
      } catch (error) {
        summary.problems.push({ coinId: position.coinId, kind: 'evaluate', detail: String(error && error.message || error) });
        continue;
      }
      if (result.problem) {
        // A missing or stale quote is not a signal and must not clear the
        // previously recorded stop or pending alert.
        summary.problems.push({ coinId: position.coinId, kind: 'quote', detail: result.problem });
      }
      summary.evaluated++;

      let updated = result.position;
      for (const event of result.events) {
        if (event.type !== 'SIGNAL') continue;
        const signal = {
          symbol: position.symbol, coinId: position.coinId, action: event.action,
          reason: event.reason, quantity: event.quantity, observedPrice: event.observedPrice,
          quoteAt: event.quoteAt, signalId: event.id, at: now
        };
        summary.signals.push(signal);

        if (autoExec && position.mode === 'live') {
          const fill = paperFillPrice(event, updated, slippageBps);
          if (fill && fill > 0) {
            try {
              const after = Protection.recordExecution(updated, {
                signalId: event.id, quantity: event.quantity, price: fill
              }, now);
              updated = after;
              const grossPnl = (fill - position.entryPrice) * Math.min(event.quantity, position.remainingQty);
              state.ledger.push({
                id: 'fill-' + event.id, at: now, space,
                coinId: position.coinId, symbol: position.symbol,
                action: event.action, reason: event.reason,
                quantity: event.quantity, price: fill,
                observedPrice: event.observedPrice, slippageBps,
                grossPnl, paper: true, mode: 'paper',
                note: 'اجرای کاغذیِ خودکار — سفارش واقعی ارسال نشده است.'
              });
              summary.fills.push({ symbol: position.symbol, reason: event.reason, quantity: event.quantity, price: fill });
            } catch (error) {
              summary.problems.push({ coinId: position.coinId, kind: 'record', detail: String(error && error.message || error) });
            }
          }
        }
      }

      // evaluate() always returns a copy, so only persist when the copy
      // actually differs in meaning — otherwise every tick would bump the
      // version and force every open browser to re-sync for nothing.
      if (result.events.length && Array.isArray(plan.row.protections)) {
        const index = plan.row.protections.findIndex(p => p.id === updated.id);
        if (index >= 0) { plan.row.protections[index] = updated; mutated = true; }
      }
    }

    // 5 — price alerts.
    for (const alert of alerts) {
      const quote = quotes[alert.id];
      const price = quote && quote.status === 'fresh' ? num(quote.price, null) : null;
      if (price == null) {
        if (quote && quote.status && quote.status !== 'fresh') {
          summary.problems.push({ coinId: alert.id, kind: 'alert-quote', detail: quote.status });
        }
        continue;
      }
      const hit = alert.dir === 'below' ? price <= num(alert.price, Infinity) : price >= num(alert.price, -Infinity);
      if (!hit) continue;
      alert.triggered = true;
      alert.firedAt = now;
      alert.firedPrice = price;
      mutated = true;
      summary.alertsFired.push({ symbol: alert.symbol || alert.id, dir: alert.dir, target: alert.price, price });
    }

    if (mutated) state.version = num(state.version, 0) + 1;
    state.updatedAt = now;

    // 6 — notify. One message per event keeps the notification tray readable.
    if (summary.signals.length || summary.alertsFired.length) {
      for (const signal of summary.signals) {
        const fill = summary.fills.find(f => f.symbol === signal.symbol && f.reason === signal.reason);
        summary.push = await broadcast(space, state, {
          type: 'protection', tag: 'protection-' + signal.signalId,
          title: 'حفاظت سرمایه — ' + signal.symbol,
          body: (signal.action === 'EXIT_LONG' ? 'خروج از خرید' : 'کاهش دارایی') + '؛ ' +
                reasonLabel(signal.reason) + '؛ تعداد ' + signal.quantity +
                (fill ? ' — اجرای کاغذی در $' + Number(fill.price).toPrecision(8) : ''),
          url: '#secPortfolio', symbol: signal.symbol, at: now, paper: true
        }, log);
      }
      for (const alert of summary.alertsFired) {
        summary.push = await broadcast(space, state, {
          type: 'alert', tag: 'alert-' + alert.symbol + '-' + alert.target,
          title: 'رادارِ بازار — ' + alert.symbol,
          body: (alert.dir === 'above' ? 'عبور به بالای ' : 'عبور به زیرِ ') + '$' + alert.target +
                ' — قیمت فعلی $' + alert.price,
          url: '#' + encodeURIComponent(alert.symbol), at: now
        }, log);
      }
    }

    // 7 — persist.
    if (mutated || Object.keys(summary.problems).length || previous == null) {
      await store.writeJSON(key(space, 'state'), state);
    }
    const pulseMeta = {
      lastRun: now, intervalSec, space,
      ticks: (previous && previous.ticks ? previous.ticks : 0) + 1,
      lastOk: now, lastError: null,
      lastSummary: {
        positions: summary.positions, evaluated: summary.evaluated,
        signals: summary.signals.length, fills: summary.fills.length,
        alertsFired: summary.alertsFired.length, problems: summary.problems.length
      },
      store: store.backend,
      push: vapidConfig().publicKey ? 'configured' : 'missing',
      autoExec: process.env.PAPER_AUTO_EXEC !== 'false'
    };
    await writePulse(space, pulseMeta);

    return { ...summary, version: state.version, nextInMs: intervalSec * 1000 };
  } catch (error) {
    const detail = String(error && error.stack || error);
    const previous = await readPulse(space);
    try {
      await writePulse(space, {
        lastRun: previous ? previous.lastRun : null, intervalSec, space,
        ticks: previous ? previous.ticks : 0,
        lastOk: previous ? previous.lastOk : null,
        lastError: { at: now, detail: detail.slice(0, 500) },
        store: store.backend
      });
    } catch (_) { /* never mask the original error */ }
    return { ...summary, ok: false, error: detail.slice(0, 500) };
  } finally {
    // Always release. Holding the lock across a forced run would let one
    // manual tick silence the monitor for a whole interval — and with a file
    // or KV backend, potentially forever.
    try { await store.del(key(space, 'lock')); } catch (_) {}
  }
}

module.exports = { tick, loadState, readPulse, writePulse, paperFillPrice, emptyState, DEFAULT_INTERVAL };
