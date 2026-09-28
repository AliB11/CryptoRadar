/**
 * Server-monitor tests.
 *
 * These cover the parts that have to be right when nobody is watching:
 * cadence gating, the paper fill model, alert evaluation, and the push
 * encryption itself (verified by decrypting what we just encrypted).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-pulse-'));
process.env.RADAR_STORE_FILE = path.join(tmp, 'kv.json');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RADAR_TOKEN;
delete process.env.CRON_SECRET;
process.env.RADAR_SPACE = 'test';
process.env.PULSE_INTERVAL_SEC = '90';
process.env.PAPER_AUTO_EXEC = 'true';
process.env.PAPER_SLIPPAGE_BPS = '10';

const monitor = require('../lib/monitor.js');
const store = require('../lib/store.js');
const push = require('../lib/push.js');
const Protection = require('../protection.js');

/* ---------- fill model ---------- */

test('a protective stop fills below the observed price', () => {
  const position = { plan: { target1: 120, target2: 140 } };
  const price = monitor.paperFillPrice(
    { reason: 'STOP_LOSS', observedPrice: 100 }, position, 10);
  assert.equal(price, 100 * (1 - 0.001));
});

test('a trailing stop also fills below the observed price', () => {
  const price = monitor.paperFillPrice(
    { reason: 'TRAILING_STOP', observedPrice: 50 }, { plan: {} }, 25);
  assert.equal(price, 50 * (1 - 0.0025));
});

test('a profit target fills at the target, not below it', () => {
  const position = { plan: { target1: 120 } };
  const price = monitor.paperFillPrice(
    { reason: 'TARGET_1', observedPrice: 150 }, position, 10);
  // A resting limit fills at its price even when the quote runs past it.
  assert.equal(price, 120);
});

test('a target above the observed price still applies slippage', () => {
  const position = { plan: { target1: 120 } };
  const price = monitor.paperFillPrice(
    { reason: 'TARGET_1', observedPrice: 110 }, position, 10);
  assert.equal(price, 110 * (1 - 0.001));
});

test('zero slippage makes a stop fill exactly at the observed price', () => {
  assert.equal(monitor.paperFillPrice({ reason: 'STOP_LOSS', observedPrice: 80 }, { plan: {} }, 0), 80);
});

/* ---------- cadence ---------- */

test('the tick refuses to run again before its interval is up', async () => {
  const now = Date.now();
  const first = await monitor.tick({ now, space: 'cadence', force: true, intervalSec: 90 });
  assert.equal(first.skipped, null, 'a forced tick must run');

  const second = await monitor.tick({ now: now + 1000, space: 'cadence', intervalSec: 90 });
  assert.equal(second.skipped, 'not-due');
  assert.equal(second.nextInMs, 89000);

  const third = await monitor.tick({ now: now + 91000, space: 'cadence', intervalSec: 90 });
  assert.equal(third.skipped, null, 'the tick becomes due after the interval');
});

test('the interval is clamped to a sane range', async () => {
  const now = Date.now();
  await monitor.tick({ now, space: 'clamp', force: true, intervalSec: 1 });
  const pulse = await monitor.readPulse('clamp');
  assert.equal(pulse.intervalSec, 30, 'minimum 30s');
  await monitor.tick({ now: now + 1000, space: 'clamp', force: true, intervalSec: 99999 });
  assert.equal((await monitor.readPulse('clamp')).intervalSec, 3600, 'maximum 3600s');
});

/* ---------- quotes, evaluation, paper fills ---------- */

function fakeFetch(market) {
  return async url => {
    const target = new URL(String(url));
    const ids = (target.searchParams.get('ids') || '').split(',').filter(Boolean);
    const rows = ids.filter(id => market[id] != null).map(id => ({
      id,
      current_price: market[id].price,
      last_updated: new Date(market[id].asOf).toISOString()
    }));
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => rows
    };
  };
}

async function seedState(space, state) {
  await store.writeJSON('space:' + space + ':state', state);
}

test('a crossed stop loss is evaluated and booked as a paper fill', async () => {
  const now = Date.now();
  const enteredAt = now - 6 * 3600 * 1000;
  const position = Protection.create({
    id: 'pos-1', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 2, enteredAt, stop: 90,
    target1: 120, target2: 140, target1Pct: 50, trailPct: 5, breakeven: true
  }, now);

  await seedState('stop', {
    version: 3, updatedAt: now,
    portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [position] }],
    alerts: [], ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now - 1000 } });
  let result;
  try {
    result = await monitor.tick({ now, space: 'stop', force: true, intervalSec: 90 });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evaluated, 1);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].reason, 'STOP_LOSS');
  assert.equal(result.signals[0].action, 'EXIT_LONG');
  assert.equal(result.fills.length, 1, 'paper execution must book the fill');
  assert.ok(result.fills[0].price < 85, 'the fill must be worse than the observed price');

  const state = await monitor.loadState('stop');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].paper, true);
  assert.equal(state.ledger[0].mode, 'paper');
  assert.ok(state.ledger[0].grossPnl < 0, 'a stop loss booked below entry is a loss');

  const saved = state.portfolio[0].protections[0];
  assert.equal(saved.status, 'CLOSED');
  assert.equal(saved.remainingQty, 0);
  assert.ok(state.version > 3, 'the version must advance so browsers re-sync');
});

test('a profit target reduces the position instead of closing it', async () => {
  const now = Date.now();
  const position = Protection.create({
    id: 'pos-2', coinId: 'ethereum', symbol: 'ETH', mode: 'live',
    entryPrice: 100, quantity: 10, enteredAt: now - 3600000, stop: 90,
    target1: 120, target1Pct: 50
  }, now);
  await seedState('target', {
    version: 1, updatedAt: now,
    portfolio: [{ id: 'ethereum', sym: 'ETH', name: 'Ethereum', qty: 10, buy: 100, protections: [position] }],
    alerts: [], ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ ethereum: { price: 125, asOf: now - 500 } });
  let result;
  try {
    result = await monitor.tick({ now, space: 'target', force: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].reason, 'TARGET_1');
  assert.equal(result.signals[0].action, 'REDUCE_LONG');
  const state = await monitor.loadState('target');
  const saved = state.portfolio[0].protections[0];
  assert.ok(saved.remainingQty > 0 && saved.remainingQty < 10, 'half of the position is sold');
  assert.equal(saved.status, 'ACTIVE');
});

test('a stale or missing quote is a problem, never a signal', async () => {
  const now = Date.now();
  const position = Protection.create({
    id: 'pos-3', coinId: 'solana', symbol: 'SOL', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now);
  await seedState('stale', {
    version: 1, updatedAt: now,
    portfolio: [{ id: 'solana', sym: 'SOL', name: 'Solana', qty: 1, buy: 100, protections: [position] }],
    alerts: [], ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  // 20 minutes old: protection.js rejects anything older than 5 minutes.
  globalThis.fetch = fakeFetch({ solana: { price: 10, asOf: now - 20 * 60000 } });
  let result;
  try {
    result = await monitor.tick({ now, space: 'stale', force: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.signals.length, 0, 'a stale quote must never trigger an exit');
  assert.equal(result.fills.length, 0);
  assert.ok(result.problems.some(p => p.detail === 'stale'), JSON.stringify(result.problems));

  const state = await monitor.loadState('stale');
  assert.equal(state.portfolio[0].protections[0].status, 'ACTIVE');
  assert.equal(state.portfolio[0].protections[0].stop, 90, 'the recorded stop survives');
});

test('a simulated plan is never evaluated against live prices', async () => {
  const now = Date.now();
  const position = Protection.create({
    id: 'pos-4', coinId: 'sim-foo', symbol: 'FOO', mode: 'simulation',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now);
  await seedState('sim', {
    version: 1, updatedAt: now,
    portfolio: [{ id: 'sim-foo', sym: 'FOO', name: 'Foo', qty: 1, buy: 100, protections: [position] }],
    alerts: [], ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network must not be touched'); };
  let result;
  try {
    result = await monitor.tick({ now, space: 'sim', force: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.signals.length, 0);
  assert.equal(result.fills.length, 0);
});

/* ---------- alerts ---------- */

test('a crossed price alert fires once and is persisted', async () => {
  const now = Date.now();
  await seedState('alert', {
    version: 1, updatedAt: now, portfolio: [],
    alerts: [{ id: 'bitcoin', sym: 'BTC', price: 90, dir: 'below', triggered: false }],
    ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 88, asOf: now - 1000 } });
  let first, second;
  try {
    first = await monitor.tick({ now, space: 'alert', force: true });
    second = await monitor.tick({ now: now + 95000, space: 'alert', force: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(first.alertsFired.length, 1);
  assert.equal(second.alertsFired.length, 0, 'an alert must not fire twice');
  const state = await monitor.loadState('alert');
  assert.equal(state.alerts[0].triggered, true);
  assert.equal(state.alerts[0].firedPrice, 88);
});

/* ---------- failures ---------- */

test('a failing upstream is reported, not thrown', async () => {
  const now = Date.now();
  const position = Protection.create({
    id: 'pos-5', coinId: 'cardano', symbol: 'ADA', mode: 'live',
    entryPrice: 1, quantity: 100, enteredAt: now - 3600000, stop: 0.8
  }, now);
  await seedState('boom', {
    version: 1, updatedAt: now,
    portfolio: [{ id: 'cardano', sym: 'ADA', name: 'Cardano', qty: 100, buy: 1, protections: [position] }],
    alerts: [{ id: 'cardano', sym: 'ADA', price: 5, dir: 'above', triggered: false }],
    ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('upstream down'); };
  let result;
  try {
    result = await monitor.tick({ now, space: 'boom', force: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.ok, true, 'a dead upstream must not fail the tick');
  assert.equal(result.quotes, 0, 'an unpriced coin is not a usable quote');
  assert.equal(result.quoteAttempts, 1);
  assert.equal(result.signals.length, 0, 'no quote means no exit');
  assert.equal(result.fills.length, 0);
  assert.equal(result.alertsFired.length, 0, 'no quote means no alert');
  assert.ok(result.problems.length > 0, 'the failure has to be visible in the response');

  const state = await monitor.loadState('boom');
  assert.equal(state.portfolio[0].protections[0].status, 'ACTIVE');
  assert.equal(state.alerts[0].triggered, false);
});

/* ---------- web push ---------- */

async function subscriptionFixture() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    pair,
    subscription: {
      endpoint: 'https://push.example.test/abc',
      keys: {
        p256dh: push.bytesToB64url(raw),
        auth: push.bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
      }
    }
  };
}

/**
 * Decrypt an RFC 8188 aes128gcm body the way the receiving browser does. The
 * only way to prove what the server actually put on the wire — and therefore
 * which notification tag it will collapse onto.
 */
async function openPayload(pair, subscription, sealed) {
  const salt = sealed.slice(0, 16);
  const idLen = sealed[20];
  const keyId = sealed.slice(21, 21 + idLen);
  const ciphertext = sealed.slice(21 + idLen);

  const serverPublic = await crypto.subtle.importKey(
    'raw', keyId, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPublic }, pair.privateKey, 256));

  const enc = new TextEncoder();
  const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
  const hkdf = async (saltBytes, ikm, info, len) =>
    (await hmac(await hmac(saltBytes, ikm), concat(enc, info, new Uint8Array([1])))).slice(0, len);

  const auth = push.b64urlToBytes(subscription.keys.auth);
  const prk = await hkdf(auth, shared, enc.encode('Content-Encoding: auth\0'), 32);
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  return new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)));
}

test('the push payload decrypts back to the original message', async () => {
  const { pair, subscription } = await subscriptionFixture();
  const message = JSON.stringify({ type: 'protection', title: 'حفاظت سرمایه — BTC' });
  const sealed = await push.encrypt(subscription, message);

  // Header layout of RFC 8188 §2: salt | record size | key id length | key id
  assert.equal(new DataView(sealed.buffer).getUint32(16), 4096);
  assert.equal(sealed[20], 65, 'an uncompressed P-256 point');

  const text = await openPayload(pair, subscription, sealed);
  assert.equal(text, message, 'round-trip must be byte-identical');
});

async function vapidFixture() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const rawPrivate = Buffer.from(jwk.d, 'base64');
  return { publicKey: push.bytesToB64url(raw), privateKey: push.bytesToB64url(rawPrivate) };
}

test('the VAPID token is a signed three-part ES256 JWT', async () => {
  const { publicKey, privateKey } = await vapidFixture();
  const token = await push.vapidToken(
    'https://push.example.test', 'mailto:radar@example.test', publicKey, privateKey);

  const parts = String(token).split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'JWT');

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(payload.aud, 'https://push.example.test', 'aud must be the push service origin');
  assert.equal(payload.sub, 'mailto:radar@example.test');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'exp must be in the future');

  // Verify the signature with the matching public key: an unsigned or
  // mis-signed token is rejected by every push service.
  const pub = push.b64urlToBytes(publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: push.bytesToB64url(pub.slice(1, 33)),
    y: push.bytesToB64url(pub.slice(33, 65))
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const body = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const signature = push.b64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, body);
  assert.equal(ok, true, 'the JWT signature must verify');
});

test('a missing VAPID configuration fails loudly instead of sending', async () => {
  await assert.rejects(
    () => push.vapidToken('https://push.example.test', 'mailto:x', '', ''),
    /VAPID keys are not configured/);
  await assert.rejects(
    () => push.vapidToken('https://push.example.test', '', 'pub', 'priv'),
    /VAPID subject/);
});

test('a malformed subscription is reported as gone so it can be dropped', async () => {
  const result = await push.send({ endpoint: 'https://push.example.test/x', keys: {} },
    'hi', { subject: 'mailto:x', publicKey: 'a', privateKey: 'b' });
  assert.equal(result.ok, false);
  assert.equal(result.gone, true);
});

/* ---------- adoption: the signal the page recorded first ---------- */

/**
 * The page evaluates on the same 90-second clock while it is open, so it
 * usually flags a crossed stop first and `evaluate()` then refuses to emit the
 * same signal again. If the tick only filled events born inside itself, every
 * plan that crossed while a tab was open would stay flagged-but-unfilled and
 * the ledger would stay empty forever — the exact symptom this covers.
 */
function crossedPlan(overrides = {}) {
  const now = Date.now();
  const enteredAt = now - 6 * 3600 * 1000;
  const position = Protection.create({
    id: 'pos-adopt', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 2, enteredAt, stop: 90,
    target1: 120, target2: 140, target1Pct: 50, breakeven: true,
    ...overrides
  }, enteredAt);
  const evaluated = Protection.evaluate(position,
    { coinId: 'bitcoin', price: 85, asOf: now - 1000, source: 'live' }, now);
  return { now, enteredAt, position: evaluated.position };
}

async function seedPortfolio(space, position, row = {}) {
  await seedState(space, {
    version: 7, updatedAt: Date.now(),
    portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [position], ...row }],
    alerts: [], ledger: [], subscriptions: {}
  });
}

test('a signal the browser recorded first is adopted and booked as a paper fill', async () => {
  const { now, position } = crossedPlan();
  assert.equal(position.pending.reason, 'STOP_LOSS', 'the page flagged the stop');
  await seedPortfolio('adopt', position);

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  let result;
  try {
    result = await monitor.tick({ now: now + 90000, space: 'adopt', force: true });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.signals.length, 0, 'the server must not invent a second signal');
  assert.equal(result.fills.length, 1, 'the standing signal must still be executed');
  assert.equal(result.fills[0].adopted, true);
  assert.equal(result.adopted.length, 1);

  const state = await monitor.loadState('adopt');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].id, 'fill-' + position.pending.id);
  assert.equal(state.ledger[0].paper, true);
  assert.equal(state.ledger[0].adopted, true);
  assert.ok(state.ledger[0].price < 85, 'the pessimistic fill model still applies');

  const saved = state.portfolio[0].protections[0];
  assert.equal(saved.status, 'CLOSED', 'the paper exit closes the plan');
  assert.equal(saved.remainingQty, 0);
  assert.equal(saved.pending, null);
  const execution = saved.events.filter(e => e.type === 'EXECUTION_RECORDED').pop();
  assert.equal(execution.auto, true, 'the UI must be able to tell it was not the user');
});

test('adoption is idempotent: repeated ticks never book the same signal twice', async () => {
  const { now, position } = crossedPlan();
  await seedPortfolio('adopt-once', position);

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  let second;
  try {
    await monitor.tick({ now: now + 90000, space: 'adopt-once', force: true });
    second = await monitor.tick({ now: now + 180000, space: 'adopt-once', force: true });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(second.fills.length, 0, 'a closed plan has nothing left to execute');
  const state = await monitor.loadState('adopt-once');
  assert.equal(state.ledger.length, 1);
});

test('an adopted fill is pushed to every device under the same tag as the tab', async () => {
  const { now, position } = crossedPlan();
  const { pair, subscription } = await subscriptionFixture();
  await seedState('adopt-push', {
    version: 4, updatedAt: now,
    portfolio: [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 2, buy: 100, protections: [position] }],
    alerts: [], ledger: [],
    subscriptions: { [subscription.endpoint]: { ...subscription, addedAt: now } }
  });

  const { publicKey, privateKey } = await vapidFixture();
  const env = {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT
  };
  process.env.VAPID_PUBLIC_KEY = publicKey;
  process.env.VAPID_PRIVATE_KEY = privateKey;
  process.env.VAPID_SUBJECT = 'mailto:radar@example.test';

  const market = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://push.example.test')) {
      sent.push({ url: String(url), body: new Uint8Array(options.body) });
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({}) };
    }
    return market(url, options);
  };

  let result;
  try {
    result = await monitor.tick({ now: now + 90000, space: 'adopt-push', force: true });
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }

  assert.equal(result.adopted.length, 1, JSON.stringify(result.adopted));
  assert.equal(result.push.sent, 1, JSON.stringify(result.push));
  assert.equal(sent.length, 1, 'the device with the subscription must be woken');

  const message = JSON.parse(await openPayload(pair, subscription, sent[0].body));
  assert.equal(message.type, 'protection');
  assert.equal(message.paper, true);
  assert.equal(message.tag, 'protection-' + position.pending.id,
    'the push has to collapse onto the tab\'s own notification, not stack on it');
  assert.ok(/اجرای کاغذی/.test(message.body), message.body);
});

test('with auto-execution off the standing signal stays open and is never booked', async () => {
  const { now, position } = crossedPlan();
  await seedPortfolio('adopt-off', position);

  const previous = process.env.PAPER_AUTO_EXEC;
  process.env.PAPER_AUTO_EXEC = 'false';
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  let result;
  try {
    result = await monitor.tick({ now: now + 90000, space: 'adopt-off', force: true });
  } finally {
    globalThis.fetch = realFetch;
    process.env.PAPER_AUTO_EXEC = previous;
  }

  assert.equal(result.fills.length, 0);
  assert.equal((await monitor.readPulse('adopt-off')).autoExec, false, 'the heartbeat must say so');
  const state = await monitor.loadState('adopt-off');
  assert.equal(state.ledger.length, 0);
  assert.equal(state.portfolio[0].protections[0].status, 'ACTIVE');
  assert.equal(state.portfolio[0].protections[0].pending.reason, 'STOP_LOSS');
});

test('a simulated plan has no server feed and is never paper-executed', async () => {
  const now = Date.now();
  const enteredAt = now - 3600000;
  const position = Protection.create({
    id: 'pos-sim', coinId: 'sim-btc', symbol: 'BTC', mode: 'simulation',
    entryPrice: 100, quantity: 1, enteredAt, stop: 90, target1: 120
  }, enteredAt);
  const evaluated = Protection.evaluate(position,
    { coinId: 'sim-btc', price: 85, asOf: now - 1000, source: 'simulation' }, now);
  await seedState('adopt-sim', {
    version: 1, updatedAt: now,
    portfolio: [{ id: 'sim-btc', sym: 'BTC', name: 'Bitcoin (sim)', qty: 1, buy: 100, protections: [evaluated.position] }],
    alerts: [], ledger: [], subscriptions: {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ 'sim-btc': { price: 85, asOf: now } });
  let result;
  try {
    result = await monitor.tick({ now: now + 1000, space: 'adopt-sim', force: true });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(result.fills.length, 0, 'the server must not fill a simulation plan');
  assert.equal((await monitor.loadState('adopt-sim')).ledger.length, 0);
  assert.equal(result.planStates[0].state, 'simulation', 'and it must say why');
});

/* ---------- diagnostics ---------- */

test('describePlans names every reason a plan is or is not being executed', () => {
  const now = Date.now();
  const fresh = Protection.create({
    id: 'p-watch', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now - 3600000);
  const closed = Protection.cancel(fresh, now - 1000);
  const states = monitor.describePlans({
    portfolio: [{ id: 'bitcoin', sym: 'BTC', protections: [
      fresh,
      closed,
      { ...fresh, id: 'p-broken', version: 0 },
      Protection.create({
        id: 'p-sim', coinId: 'sim-eth', symbol: 'ETH', mode: 'simulation',
        entryPrice: 10, quantity: 1, enteredAt: now - 1000, stop: 9
      }, now - 1000)
    ] }]
  }, { bitcoin: { coinId: 'bitcoin', price: 100, asOf: now, source: 'live' } }, now);

  assert.deepEqual(states.map(s => s.state),
    ['watching', 'cancelled', 'invalid', 'simulation']);
  assert.equal(states[0].symbol, 'BTC');
  // The diagnostics table shows the numbers behind the verdict, so they have
  // to survive the trip through the heartbeat record.
  assert.equal(states[0].stop, fresh.stop);
  assert.equal(states[0].entry, fresh.entryPrice);
  assert.equal(states[0].remainingQty, fresh.remainingQty);
});

test('describePlans reports a pending signal and a missing quote instead of silence', () => {
  const now = Date.now();
  const { position } = crossedPlan();
  const states = monitor.describePlans(
    { portfolio: [{ id: 'bitcoin', sym: 'BTC', protections: [position] }] }, {}, now);
  assert.equal(states[0].state, 'pending');
  assert.equal(states[0].reason, 'STOP_LOSS');

  const fresh = Protection.create({
    id: 'p-quote', coinId: 'ethereum', symbol: 'ETH', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now - 3600000);
  const missing = monitor.describePlans(
    { portfolio: [{ id: 'ethereum', sym: 'ETH', protections: [fresh] }] }, {}, now);
  assert.equal(missing[0].state, 'no-quote');
  assert.equal(missing[0].problem, 'missing');
});

test('the heartbeat carries the diagnostics the page renders', async () => {
  const { now, position } = crossedPlan();
  await seedPortfolio('diag', position);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ bitcoin: { price: 85, asOf: now + 89000 } });
  try {
    await monitor.tick({ now: now + 90000, space: 'diag', force: true });
  } finally { globalThis.fetch = realFetch; }

  const pulse = await monitor.readPulse('diag');
  assert.equal(pulse.lastSummary.fills, 1);
  assert.equal(pulse.lastSummary.adopted, 1);
  assert.equal(pulse.lastSummary.planTotal, 1);
  // A plan the paper engine closed is reported as such, with the fill it was
  // closed at: the page has to be able to say "your holdings were not touched"
  // instead of the generic "an exit was recorded", which reads as a sale.
  assert.deepEqual(pulse.lastSummary.planStates.map(p => p.state), ['paper-closed']);
  assert.equal(pulse.lastSummary.planStates[0].reason, 'STOP_LOSS');
  assert.ok(pulse.lastSummary.planStates[0].price > 0);
  assert.equal(pulse.autoExec, true);
});

test('describePlans separates a plan the user sold from one the paper engine closed', () => {
  const now = Date.now();
  const sold = Protection.create({
    id: 'p-sold', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now - 3600000);
  const flagged = Protection.evaluate(sold, { coinId: 'bitcoin', price: 80, asOf: now - 1000, source: 'live' }, now - 500);
  const byUser = Protection.recordExecution(flagged.position, { signalId: flagged.position.pending.id, quantity: 1, price: 80 }, now);

  const paper = Protection.create({
    id: 'p-paper', coinId: 'ethereum', symbol: 'ETH', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  }, now - 3600000);
  const paperFlagged = Protection.evaluate(paper, { coinId: 'ethereum', price: 80, asOf: now - 1000, source: 'live' }, now - 500);
  const byEngine = Protection.recordExecution(paperFlagged.position,
    { signalId: paperFlagged.position.pending.id, quantity: 1, price: 79.9, auto: true }, now);

  const rows = monitor.describePlans({
    portfolio: [
      { id: 'bitcoin', sym: 'BTC', protections: [byUser] },
      { id: 'ethereum', sym: 'ETH', protections: [byEngine] }
    ]
  }, {}, now);
  assert.deepEqual(rows.map(r => r.state), ['closed', 'paper-closed']);
  assert.equal(rows[1].price, 79.9);
  // Both must still be recognised as valid, closed plans.
  assert.equal(Protection.validPosition(byUser), true);
  assert.equal(Protection.validPosition(byEngine), true);
  // And the history must attribute the closure correctly.
  assert.equal(byUser.events.at(-1).reason, 'USER_RECORDED_EXIT');
  assert.equal(byEngine.events.at(-1).reason, 'PAPER_AUTO_EXIT');
  assert.equal(byEngine.events.at(-1).auto, true);
});

function concat(enc, ...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
