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

test('the push payload decrypts back to the original message', async () => {
  const { pair, subscription } = await subscriptionFixture();
  const message = JSON.stringify({ type: 'protection', title: 'حفاظت سرمایه — BTC' });
  const sealed = await push.encrypt(subscription, message);

  // Header layout of RFC 8188 §2: salt | record size | key id length | key id
  const salt = sealed.slice(0, 16);
  const rs = new DataView(sealed.buffer).getUint32(16);
  const idLen = sealed[20];
  const keyId = sealed.slice(21, 21 + idLen);
  const ciphertext = sealed.slice(21 + idLen);

  assert.equal(rs, 4096);
  assert.equal(idLen, 65, 'an uncompressed P-256 point');

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
  const text = new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)));

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
