'use strict';
/**
 * /api/state — the bridge between the browser's localStorage and the server's
 * monitoring state.
 *
 * The browser owns the UI; the server owns the clock. Only the server can
 * evaluate a plan at 03:00 while the laptop is shut, so the plans and alerts
 * have to live next to the heartbeat. This endpoint keeps the two copies in
 * step:
 *
 *   GET /api/state            read { version, portfolio, alerts, ledger, pulse }
 *   PUT /api/state            write { base, portfolio, alerts }
 *   POST /api/state/subscribe register a Web Push subscription   (action=subscribe)
 *                             remove it                          (action=unsubscribe)
 *
 * Writes are optimistic-concurrency: the client sends the `version` it read
 * (as `base`). If the server has moved on — because a tick recorded a paper
 * fill — the write is rejected with 409 and the current state attached, so the
 * client reloads instead of clobbering overnight fills.
 *
 * Auth: RADAR_TOKEN in the `x-radar-token` header. Until it is set the route
 * refuses to serve, because otherwise a public deployment would hand its key
 * value store to anyone who asks.
 */

const http = require('../lib/http.js');
const monitor = require('../lib/monitor.js');
const store = require('../lib/store.js');
const SignalPaper = require('../lib/signal-paper.js');

const MAX_ROWS = 400;
const MAX_ALERTS = 500;
const MAX_LEDGER = 2000;
const MAX_SUBS = 20;

function configured(res) {
  if (process.env.RADAR_TOKEN) return true;
  http.send(res, 503, {
    error: 'not-configured',
    detail: 'RADAR_TOKEN تنظیم نشده است. بدون آن، این مسیر وضعیتِ پایش را در اختیار هر کسی می‌گذارد.'
  });
  return false;
}

function authenticated(req, res) {
  if (http.safeEqual(http.tokenFrom(req), process.env.RADAR_TOKEN)) return true;
  http.send(res, 401, { error: 'unauthorized' });
  return false;
}

function publicState(state) {
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    portfolio: state.portfolio,
    alerts: state.alerts,
    ledger: state.ledger,
    signalLedger: state.signalLedger, signalPositions: state.signalPositions,
    signalResults: state.signalResults || [], signalEvaluationAt: state.signalEvaluationAt || 0,
    autoExec: process.env.PAPER_AUTO_EXEC !== 'false',
    subscriptionCount: Object.keys(state.subscriptions || {}).length
  };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') { http.send(res, 204, {}); return; }
  if (!configured(res)) return;

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    if (!authenticated(req, res)) return;
    const space = http.spaceOf(req, null);
    const state = await monitor.loadState(space);
    const pulse = await monitor.readPulse(space);
    http.send(res, 200, {
      ok: true, space, store: store.backend,
      ...publicState(state),
      pulse: pulse || null,
      intervalSec: monitor.intervalSec(),
      push: process.env.VAPID_PUBLIC_KEY
        ? { configured: true, publicKey: process.env.VAPID_PUBLIC_KEY }
        : { configured: false }
    });
    return;
  }

  if (!authenticated(req, res)) return;
  const body = (await http.readBody(req)) || {};
  const space = http.spaceOf(req, body);

  if (method === 'PUT') {
    const state = await monitor.loadState(space);
    const base = Number(body.base);
    // A client that never read the state cannot know whether it is clobbering
    // an overnight fill, so it must send the version it is based on.
    if (!Number.isInteger(body.base) || base !== state.version) {
      http.send(res, 409, {
        ok: false, error: 'version-conflict',
        detail: 'وضعیتِ سرور جلوتر است (یک تیک یا اجرای کاغذی رخ داده). ابتدا بخوانید.',
        ...publicState(state)
      });
      return;
    }

    if (Array.isArray(body.portfolio)) state.portfolio = body.portfolio.slice(0, MAX_ROWS);
    if (Array.isArray(body.alerts)) state.alerts = body.alerts.slice(0, MAX_ALERTS);
    if (Array.isArray(state.ledger) && state.ledger.length > MAX_LEDGER) {
      state.ledger = state.ledger.slice(-MAX_LEDGER);
    }
    state.version = Number(state.version || 0) + 1;
    state.updatedAt = Date.now();
    if (!await store.compareAndSetJSON('space:' + space + ':state', state.version - 1, state)) {
      http.send(res, 409, { error: 'version-conflict', ...publicState(await monitor.loadState(space)) }); return;
    }
    http.send(res, 200, { ok: true, ...publicState(state) });
    return;
  }

  if (method === 'DELETE') {
    // Drops monitoring state but keeps the ledger — an audit trail should
    // survive a reset of the watchlist.
    const state = await monitor.loadState(space);
    const ledger = state.ledger;
    const cleared = {
      ...monitor.emptyState(), ledger,
      signalLedger: state.signalLedger, signalPositions: state.signalPositions,
      signalResults: state.signalResults || [], signalEvaluationAt: state.signalEvaluationAt || 0,
      autoExec: process.env.PAPER_AUTO_EXEC !== 'false', signalSeen: state.signalSeen, signalConfirm: state.signalConfirm,
      subscriptions: body.keepSubscriptions === false ? {} : (state.subscriptions || {}),
      version: Number(state.version || 0) + 1, updatedAt: Date.now()
    };
    if (!await store.compareAndSetJSON('space:' + space + ':state', state.version, cleared)) {
      http.send(res, 409, { error: 'version-conflict', ...publicState(await monitor.loadState(space)) }); return;
    }
    http.send(res, 200, { ok: true, cleared: true });
    return;
  }

  if (method === 'POST') {
    const state = await monitor.loadState(space);
    if (body.action === 'signal' || body.action === 'signals') {
      if (process.env.PAPER_AUTO_EXEC === 'false') {
        http.send(res, 200, { ok: true, queued: false, reason: 'disabled' }); return;
      }
      const signals = body.action === 'signal' ? [body.signal] : body.signals;
      const now = Date.now();
      if (!Array.isArray(signals) || signals.length > 150 || !signals.every(s => SignalPaper.validObservation(s, now))) {
        http.send(res, 400, { ok: false, error: 'invalid-signal' }); return;
      }
      const before = JSON.stringify(state);
      const results = signals.map(signal => SignalPaper.observe(state, signal, now));
      if (before !== JSON.stringify(state)) {
        state.version++; state.updatedAt = now;
        if (!await store.compareAndSetJSON('space:' + space + ':state', state.version - 1, state)) {
          http.send(res, 409, { error: 'version-conflict', ...publicState(await monitor.loadState(space)) }); return;
        }
      }
      http.send(res, 200, { ok: true, queued: results.some(r => r.queued) }); return;
    }
    const subscription = body.subscription;
    if (body.action === 'unsubscribe') {
      const endpoint = body.endpoint || (subscription && subscription.endpoint);
      if (endpoint && state.subscriptions[endpoint]) delete state.subscriptions[endpoint];
    } else if (subscription && subscription.endpoint && subscription.keys &&
               subscription.keys.p256dh && subscription.keys.auth) {
      const subs = state.subscriptions || {};
      const keys = Object.keys(subs);
      if (!subs[subscription.endpoint] && keys.length >= MAX_SUBS) {
        // Evict the oldest device rather than refuse the newest one.
        delete subs[keys.sort((a, b) => (subs[a].addedAt || 0) - (subs[b].addedAt || 0))[0]];
      }
      subs[subscription.endpoint] = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        label: String(body.label || '').slice(0, 80),
        addedAt: Date.now()
      };
      state.subscriptions = subs;
    } else {
      http.send(res, 400, { ok: false, error: 'subscription' });
      return;
    }
    state.version = Number(state.version || 0) + 1;
    state.updatedAt = Date.now();
    if (!await store.compareAndSetJSON('space:' + space + ':state', state.version - 1, state)) {
      http.send(res, 409, { error: 'version-conflict', ...publicState(await monitor.loadState(space)) }); return;
    }
    http.send(res, 200, { ok: true, subscriptionCount: Object.keys(state.subscriptions || {}).length });
    return;
  }

  http.send(res, 405, { error: 'method' });
}

module.exports = async (req, res) => {
  try { await handler(req, res); }
  catch (_) { http.send(res, 500, { ok: false, error: 'state-write-failed' }); }
};

module.exports.config = { maxDuration: 30 };
