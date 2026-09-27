'use strict';
/**
 * Web Push sender — VAPID + aes128gcm, no third-party dependency.
 *
 * The browser cannot be the thing that evaluates a stop loss, because the
 * browser is not always running. So the server has to be able to wake the
 * user's device, and the only way to do that from a stateless function is
 * the Web Push protocol. Everything here is standard:
 *
 *   VAPID    RFC 8292  (ES256 JWT identifying the sender)
 *   aes128gcm RFC 8188 + RFC 8291 (ECDH + HKDF + AES-GCM record encryption)
 *
 * Implemented on WebCrypto so it runs unchanged on Node 18+, Vercel and
 * Cloudflare Workers.
 */

const subtle = globalThis.crypto && globalThis.crypto.subtle;

function b64urlToBytes(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = Buffer.from(b64 + pad, 'base64');
  return new Uint8Array(bin);
}

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const enc = new TextEncoder();
const concat = arrays => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
};

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', k, data);
  return new Uint8Array(sig);
}

/** HKDF-SHA256, single-block output (all our lengths are <= 32). */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat([info, new Uint8Array([1])]));
  return okm.slice(0, length);
}

/**
 * Rebuild a P-256 private key from the base64url pair that
 * `npx web-push generate-vapid-keys` (or tools/vapid.mjs) prints.
 */
async function importVapidPrivate(publicKeyB64, privateKeyB64) {
  const pub = b64urlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(b64urlToBytes(privateKeyB64))
  };
  return await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidToken(origin, subject, publicKey, privateKey) {
  if (!publicKey || !privateKey) throw new Error('VAPID keys are not configured');
  if (!subject) throw new Error('VAPID subject (mailto: or https:) is not configured');
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  };
  const body = bytesToB64url(enc.encode(JSON.stringify(header))) + '.' +
               bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await importVapidPrivate(publicKey, privateKey);
  const signature = new Uint8Array(await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(body)));
  return body + '.' + bytesToB64url(signature);
}

/** Encrypt a payload for one subscription using aes128gcm (RFC 8188/8291). */
async function encrypt(subscription, payloadText) {
  const raw = enc.encode(payloadText);
  const rs = 4096;                       // record size
  const padding = 0;                     // keep the record small; content is short
  // Maximum body per record is rs - 16 (tag) - 1 (delimiter).
  if (raw.length + padding > rs - 17) throw new Error('push payload too large');
  const plaintext = concat([raw, new Uint8Array([2]), new Uint8Array(padding)]);

  const userPublic = await subtle.importKey(
    'raw', b64urlToBytes(subscription.keys.p256dh),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: userPublic }, local.privateKey, 256));
  const localPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const auth = b64urlToBytes(subscription.keys.auth);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));

  const prk = await hkdf(auth, shared, enc.encode('Content-Encoding: auth\0'), 32);
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: undefined }, aesKey, plaintext));

  const header = concat([
    salt,
    new Uint8Array([(rs >> 24) & 255, (rs >> 16) & 255, (rs >> 8) & 255, rs & 255]),
    new Uint8Array([localPublic.length]),
    localPublic
  ]);
  return concat([header, sealed]);
}

/**
 * Send one message. Resolves with { ok, status, gone } — `gone` means the
 * subscription expired (404/410) and must be dropped from the store.
 */
async function send(subscription, payload, vapid) {
  if (!subtle) return { ok: false, error: 'WebCrypto unavailable' };
  const endpoint = subscription && subscription.endpoint;
  if (!endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return { ok: false, gone: true, error: 'malformed subscription' };
  }
  const origin = new URL(endpoint).origin;
  const body = await encrypt(subscription, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const token = await vapidToken(origin, vapid.subject, vapid.publicKey, vapid.privateKey);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'vapid t=' + token + ',k=' + vapid.publicKey,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(Math.max(60, Math.min(60 * 60 * 24, vapid.ttl || 60 * 60 * 6))),
      Urgency: vapid.urgency || 'high'
    },
    body,
    signal: AbortSignal.timeout(10000)
  });
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    return { ok: false, status: 429, retryAfter: retry ? Number(retry) : null };
  }
  if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
  return { ok: true, status: res.status };
}

module.exports = { send, encrypt, vapidToken, b64urlToBytes, bytesToB64url };
