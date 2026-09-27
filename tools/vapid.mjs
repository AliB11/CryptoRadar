#!/usr/bin/env node
/**
 * Generate a VAPID key pair for Web Push.
 *
 *   node tools/vapid.mjs
 *
 * Prints the three environment variables the server monitor needs. The
 * private key never leaves your machine; only the public key is sent to
 * browsers (it is what `pushManager.subscribe` uses as applicationServerKey).
 */

const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

const b64url = bytes => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const publicKey = b64url(rawPublic);
const privateKey = b64url(Buffer.from(jwk.d, 'base64'));

process.stdout.write('\n' +
  '# ——— paste these into your Vercel project environment variables ———\n' +
  'VAPID_PUBLIC_KEY=' + publicKey + '\n' +
  'VAPID_PRIVATE_KEY=' + privateKey + '\n' +
  'VAPID_SUBJECT=mailto:you@example.com\n\n' +
  '# The private key is a credential: set it once and do not commit it.\n' +
  '# Changing VAPID keys later invalidates every existing push subscription,\n' +
  '# so devices will have to re-enable notifications in the terminal.\n\n');
