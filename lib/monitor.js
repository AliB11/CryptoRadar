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
 *   4. in paper mode, book the resulting fill — including a signal the page
 *      already flagged while the tab was open (see "adoption" below)
 *   5. evaluate price alerts
 *   6. push a Web Push notification for anything that fired
 *   7. persist state + heartbeat
 *
 * Paper mode never touches an exchange. Every booked fill is marked
 * `paper: true` and lands in a separate ledger.
 *
 * Two clients share one rule engine: the browser evaluates on its own 90-second
 * clock, and so does this tick. The browser can therefore record the signal
 * first — `evaluate()` sets `pending` and refuses to emit a second event with
 * the same or lower priority. That is why step 4 also *adopts* a pending,
 * unexecuted signal instead of only filling events created by this very tick:
 * otherwise a plan that crossed its stop while the tab was open would sit
 * flagged-but-never-filled forever, which looks exactly like "the paper engine
 * does nothing" while the heartbeat stays healthy.
 */

const Protection = require('../protection.js');
const SignalPaper = require('./signal-paper.js');
const { authenticatedFetch } = require('./coingecko.js');
const CoinLore = require('./coinlore.js');
const store = require('./store.js');
const push = require('./push.js');

const DEFAULT_INTERVAL = 90;
const MAX_INTERVAL = 3600;
const MIN_INTERVAL = 30;
const DEFAULT_SLIPPAGE_BPS = 10;   // 0.10% — a deliberately pessimistic exit
const DUE_TOLERANCE_MS = 4000;     // schedulers drift; do not waste a tick on it
const MAX_PLAN_STATES = 16;        // diagnostics payload, kept small for KV
const MAX_REPORTED_PROBLEMS = 6;

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
  const target = signal.reason === 'TARGET_1' ? position.plan.target1
    : signal.reason === 'TARGET_2' ? position.plan.target2 : null;
  const limit = num(target, null);
  if (!limit) return observed * (1 - slip);
  // The quote is normally at or beyond the target; the resting order fills at
  // the target. If the quote is somehow below it, fill at the quote instead —
  // never invent a price the market never printed.
  return observed >= limit ? limit : observed * (1 - slip);
}

/**
 * The cycle length this deployment will actually use, clamped.
 *
 * Read from the environment by three different surfaces (the tick, the status
 * route and the browser), so it lives in one place: `PULSE_INTERVAL_SEC=abc`
 * used to reach the browser as `NaN`, which made every "next tick in …" and
 * "how old is the last tick" reading meaningless.
 */
function intervalSec(value) {
  const raw = value == null ? process.env.PULSE_INTERVAL_SEC : value;
  const parsed = Number(raw);
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL,
    Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL));
}

function emptyState() {
  return { version: 0, updatedAt: 0, portfolio: [], alerts: [], ledger: [], subscriptions: {},
    signalPositions: [], signalLedger: [], signalSeen: {}, signalConfirm: {}, signalQueue: [] };
}

/**
 * Why each plan is — or is not — being executed.
 *
 * The ledger only shows what happened. "The paper engine does nothing" has a
 * handful of very different causes (a simulated plan the server has no feed
 * for, an upstream that will not timestamp a price, a signal waiting for the
 * user's own fill, a plan already closed) and from the outside they all look
 * identical. This is the vocabulary the UI renders, and it is deliberately
 * derived from the saved state rather than from this tick's internals, so it
 * stays honest about plans that were skipped for any reason at all.
 */
function describePlans(state, quotes = {}, now = Date.now()) {
  const rows = [];
  for (const row of (state && state.portfolio) || []) {
    if (!row || !Array.isArray(row.protections)) continue;
    for (const position of row.protections) {
      if (!position || typeof position !== 'object') continue;
      const base = {
        id: position.id || null,
        symbol: row.sym || position.symbol || position.coinId || '—',
        coinId: position.coinId || null,
        mode: position.mode || null,
        // The numbers the diagnostics table shows next to the verdict: without
        // them "in حال پایش" is a claim the user cannot check.
        entry: num(position.entryPrice, null),
        stop: num(position.stop, null),
        remainingQty: num(position.remainingQty, null)
      };
      if (!Protection.validPosition(position)) { rows.push({ ...base, state: 'invalid' }); continue; }
      if (position.status === 'CLOSED') {
        // A plan the paper engine closed and a plan the user sold are both
        // "closed", but only one of them moved real holdings. Collapsing them
        // into one label is what made the ledger look like it had done nothing.
        const paper = Protection.autoExecuted(position);
        rows.push(paper
          ? { ...base, state: 'paper-closed', reason: paper.reason, price: paper.price, at: paper.at }
          : { ...base, state: 'closed' });
        continue;
      }
      if (position.status === 'CANCELLED') { rows.push({ ...base, state: 'cancelled' }); continue; }
      if (position.mode === 'simulation') { rows.push({ ...base, state: 'simulation' }); continue; }
      if (position.pending) {
        rows.push({ ...base, state: 'pending', reason: position.pending.reason, since: position.pending.at || null });
        continue;
      }
      const problem = Protection.quoteProblem(position, quotes[position.coinId], now);
      if (problem) { rows.push({ ...base, state: 'no-quote', problem }); continue; }
      rows.push({ ...base, state: 'watching' });
    }
  }
  return rows;
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
      ? state.subscriptions : {},
    signalPositions: Array.isArray(state.signalPositions) ? state.signalPositions : [],
    signalLedger: Array.isArray(state.signalLedger) ? state.signalLedger : [],
    signalQueue: Array.isArray(state.signalQueue) ? state.signalQueue : [],
    signalEvaluationAt: num(state.signalEvaluationAt, 0),
    signalConfirm: state.signalConfirm && typeof state.signalConfirm === 'object' ? state.signalConfirm : {},
    signalResults: Array.isArray(state.signalResults) ? state.signalResults : [],
    signalSeen: state.signalSeen && typeof state.signalSeen === 'object' ? state.signalSeen : {}
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
    skipped: null, quotes: 0, quoteAttempts: 0, positions: 0, evaluated: 0,
    signals: [], fills: [], adopted: [], alertsFired: [], push: null,
    problems: [], planStates: [], store: store.backend, log
  };

  // Problems are reported once per coin+kind: a plan that cannot be priced
  // must not bury the heartbeat under an identical line every 90 seconds.
  const reported = new Set();
  const report = problem => {
    const tag = (problem.coinId || '-') + '|' + problem.kind + '|' + (problem.detail || '');
    if (reported.has(tag) || summary.problems.length >= MAX_REPORTED_PROBLEMS) return;
    reported.add(tag);
    summary.problems.push(problem);
  };

  // 1 — lock, so two schedulers cannot evaluate the same position twice.
  const lockTtl = Math.min(60000, Math.max(15000, intervalSec * 1000));
  const locked = await store.acquireLock(key(space, 'lock'), lockTtl);
  if (!locked) {
    const previous = await readPulse(space);
    return {
      ...summary, ok: true, skipped: 'locked',
      lastRun: previous ? previous.lastRun : null,
      nextInMs: previous ? Math.max(0, previous.lastRun + intervalSec * 1000 - now) : intervalSec * 1000
    };
  }

  try {
    const state = await loadState(space);
    const baseVersion = state.version;
    const baseSnapshot = JSON.stringify(state);
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
    const ids = [...new Set([...live.map(p => p.position.coinId), ...alerts.map(a => a.id),
      ...state.signalPositions.filter(p => p.status === 'OPEN').map(p => p.coinId),
      ...state.signalQueue.map(s => s.coinId)])];

    let quotes = {};
    if (ids.length) {
      try {
        quotes = await Protection.fetchQuotes(ids, {
          now, fetch: authenticatedFetch(),
          // Optional: reuse this deployment's own proxy (its cache and its
          // 429 fallback) instead of hitting CoinGecko straight from the
          // function. Unset means "go direct", which is what a fresh install
          // does.
          //
          // `directOnly` is set in exactly that case on purpose. A relative
          // `/api/proxy` URL is meaningful in a page and meaningless here:
          // Node's fetch rejects it before opening a socket, so an
          // unconfigured deployment used to burn a failed request per batch
          // (and could surface `error` where the direct call would have
          // produced a verdict) before falling through anyway.
          proxyOrigin: process.env.RADAR_PROXY_ORIGIN || '',
          directOnly: !process.env.RADAR_PROXY_ORIGIN,
          fallbackQuotes: CoinLore.fetchQuotes
        });
      } catch (error) {
        report({ kind: 'quotes', detail: String(error && error.message || error) });
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
    // Queued, high-confluence terminal signals are executed against independent
    // server quotes. Never trust the browser's price for a fill.
    summary.signalFills = [];
    if (autoExec) {
      const stopped = SignalPaper.checkStops(state, quotes, now);
      if (stopped.length) { summary.signalFills.push(...stopped); mutated = true; }
      if (state.signalQueue.length) state.signalResults = [];
      for (const signal of state.signalQueue) {
        const before = state.signalSeen[signal.coinId];
        const result = SignalPaper.execute(state, signal, quotes[signal.coinId], now);
        if (result.ok) summary.signalFills.push(result.fill);
        state.signalResults.push({ coinId: signal.coinId, at: now, observedPrice: signal.observedPrice,
          quotePrice: quotes[signal.coinId] && quotes[signal.coinId].price,
          result: result.ok ? 'filled' : result.reason });
        if (state.signalSeen[signal.coinId] !== before) mutated = true;
      }
    }
    if (!autoExec && Object.keys(state.signalConfirm).length) state.signalConfirm = {};
    // Expired signals cannot be replayed after a delayed heartbeat.
    const queue = state.signalQueue.filter(s => now - s.observedAt <= 5 * 60000 &&
      s.observedAt > (state.signalSeen[s.coinId] || 0));
    if (queue.length !== state.signalQueue.length) { state.signalQueue = queue; mutated = true; }

    for (const plan of plans) {
      const position = plan.position;
      const simulated = position.mode === 'simulation';
      const quote = simulated
        ? { coinId: position.coinId, status: 'missing' }
        : quotes[position.coinId];
      let result;
      try {
        result = Protection.evaluate(position, quote, now);
      } catch (error) {
        report({ coinId: position.coinId, kind: 'evaluate', detail: String(error && error.message || error) });
        continue;
      }
      if (result.problem && !simulated) {
        // A missing or stale quote is not a signal and must not clear the
        // previously recorded stop or pending alert. Simulated plans have no
        // server-side feed at all, so they are reported once in planStates
        // instead of as a per-tick problem.
        report({ coinId: position.coinId, kind: 'quote', detail: result.problem });
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
                signalId: event.id, quantity: event.quantity, price: fill, auto: true
              }, now);
              updated = after;
              const grossPnl = (fill - position.entryPrice) * Math.min(event.quantity, position.remainingQty);
              state.ledger.push({
                id: 'fill-' + event.id, at: now, space,
                coinId: position.coinId, symbol: position.symbol,
                action: event.action, reason: event.reason,
                quantity: event.quantity, price: fill,
                observedPrice: event.observedPrice, slippageBps,
                grossPnl, paper: true, mode: 'paper', adopted: false,
                note: 'اجرای کاغذیِ خودکار — سفارش واقعی ارسال نشده است.'
              });
              summary.fills.push({ symbol: position.symbol, reason: event.reason, quantity: event.quantity, price: fill, adopted: false });
            } catch (error) {
              report({ coinId: position.coinId, kind: 'record', detail: String(error && error.message || error) });
            }
          }
        }
      }

      // evaluate() always returns a copy, so only persist when the copy
      // actually differs in meaning — otherwise every tick would bump the
      // version and force every open browser to re-sync for nothing.
      if (JSON.stringify(updated) !== JSON.stringify(position) && Array.isArray(plan.row.protections)) {
        const index = plan.row.protections.findIndex(p => p.id === updated.id);
        if (index >= 0) { plan.row.protections[index] = updated; mutated = true; }
      }
    }

    // 4b — adopt a signal that was already recorded but never executed.
    //
    // The page runs the same rule engine on its own clock, so while a tab is
    // open it usually flags the condition first: the plan already carries
    // `pending`, and evaluate() above deliberately refuses to emit a duplicate
    // event. Filling only events created by *this* tick would therefore leave
    // every plan that crossed between two browser polls flagged but never
    // executed — an empty ledger next to a perfectly healthy heartbeat. The
    // pending signal is a met condition with a valid observed price, so the
    // paper engine books it here, idempotently (`fill-<signalId>`), and the
    // plan moves on exactly as if the tick had seen the crossing itself.
    const adopted = [];
    if (autoExec) {
      for (const plan of plans) {
        const row = plan.row;
        if (!row || !Array.isArray(row.protections)) continue;
        const index = row.protections.findIndex(p => p && p.id === plan.position.id);
        if (index < 0) continue;
        const current = row.protections[index];
        if (!current || current.mode !== 'live' || current.status !== 'ACTIVE' || !current.pending) continue;
        const pending = current.pending;
        if (state.ledger.some(entry => entry && entry.id === 'fill-' + pending.id)) continue;
        const fill = paperFillPrice(pending, current, slippageBps);
        if (!(fill > 0)) continue;
        try {
          const after = Protection.recordExecution(current, {
            signalId: pending.id, quantity: pending.quantity, price: fill, auto: true
          }, now);
          row.protections[index] = after;
          const quantity = Math.min(pending.quantity, current.remainingQty);
          state.ledger.push({
            id: 'fill-' + pending.id, at: now, space,
            coinId: current.coinId, symbol: current.symbol,
            action: pending.action, reason: pending.reason,
            quantity, price: fill,
            observedPrice: pending.observedPrice, slippageBps,
            grossPnl: (fill - current.entryPrice) * quantity,
            paper: true, mode: 'paper', adopted: true, signalAt: pending.at,
            note: 'اجرای کاغذیِ خودکار بر پایهٔ هشدارِ ثبت‌شده — سفارش واقعی ارسال نشده است.'
          });
          summary.fills.push({
            symbol: current.symbol, reason: pending.reason, action: pending.action,
            quantity, price: fill, adopted: true
          });
          adopted.push({
            symbol: current.symbol, coinId: current.coinId,
            action: pending.action, reason: pending.reason, quantity,
            signalId: pending.id, signalAt: pending.at || null, status: after.status
          });
          mutated = true;
        } catch (error) {
          report({ coinId: current.coinId, kind: 'adopt', detail: String(error && error.message || error) });
        }
      }
    }
    summary.adopted = adopted;

    // 5 — price alerts.
    for (const alert of alerts) {
      const quote = quotes[alert.id];
      const price = quote && quote.status === 'fresh' ? num(quote.price, null) : null;
      if (price == null) {
        if (quote && quote.status && quote.status !== 'fresh') {
          report({ coinId: alert.id, kind: 'alert-quote', detail: quote.status });
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

    mutated = JSON.stringify(state) !== baseSnapshot;
    if (mutated || summary.problems.length || previous == null) {
      state.version = baseVersion + 1;
      state.updatedAt = now;
    }

    // Persist before any notification: side effects must never be sent for a
    // tick whose state lost the race against another writer.
    if (mutated || summary.problems.length || previous == null) {
      if (!await store.compareAndSetJSON(key(space, 'state'), baseVersion, state))
        return { ...summary, ok: true, skipped: 'state-conflict', fills: [], signalFills: [], nextInMs: 0 };
    }

    // 6 — notify. One message per event keeps the notification tray readable.
    // Adopted fills are included: the signal itself may have been recorded by
    // the tab that is open, but the fill is news for every other device. They
    // share the tab's notification tag, so the two collapse into one message
    // instead of stacking.
    const notices = summary.signals.concat(summary.adopted.map(fill => ({ ...fill, at: now })));
    if (notices.length || summary.alertsFired.length) {
      for (const signal of notices) {
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

    // Remove dead push endpoints from a freshly loaded state, never from the
    // pre-notification snapshot (other clients may have written in between).
    const dropped = Object.keys(JSON.parse(baseSnapshot).subscriptions || {})
      .filter(endpoint => !state.subscriptions[endpoint]);
    if (dropped.length) {
      const latest = await loadState(space);
      const version = latest.version;
      for (const endpoint of dropped) delete latest.subscriptions[endpoint];
      latest.version++; latest.updatedAt = now;
      await store.compareAndSetJSON(key(space, 'state'), version, latest);
    }

    // 7 — persist.

    summary.planStates = describePlans(state, quotes, now);
    const pulseMeta = {
      lastRun: now, intervalSec, space,
      ticks: (previous && previous.ticks ? previous.ticks : 0) + 1,
      lastOk: now, lastError: null,
      lastSummary: {
        positions: summary.positions, evaluated: summary.evaluated,
        signals: summary.signals.length, fills: summary.fills.length,
        signalFills: summary.signalFills.length,
        adopted: summary.adopted.length,
        alertsFired: summary.alertsFired.length, problems: summary.problems.length,
        quotes: summary.quotes, quoteAttempts: summary.quoteAttempts,
        // Kept small on purpose: this rides along in the heartbeat record the
        // page polls, so it stays a bounded snapshot, not a log.
        problemList: summary.problems.slice(0, MAX_REPORTED_PROBLEMS),
        planStates: summary.planStates.slice(0, MAX_PLAN_STATES),
        planTotal: summary.planStates.length
      },
      store: store.backend,
      push: vapidConfig().publicKey ? 'configured' : 'missing',
      autoExec
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
    try { await store.releaseLock(key(space, 'lock'), locked); } catch (_) {}
  }
}

module.exports = {
  tick, loadState, readPulse, writePulse, paperFillPrice, describePlans, emptyState,
  intervalSec, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL
};
