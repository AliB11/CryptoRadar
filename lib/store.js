'use strict';
/**
 * Server-side state store.
 *
 * Serverless functions are stateless, so the monitor needs an external
 * key/value store to survive between ticks. Two backends are supported:
 *
 *   - Upstash Redis (REST)  — set UPSTASH_REDIS_REST_URL + _TOKEN
 *   - in-memory             — local development only; every deploy/instance
 *                             starts empty and nothing is shared
 *
 * The interface is deliberately tiny: get / set / del / setnx / mget.
 * Everything on top is plain JSON, because the whole state of a personal
 * monitoring space is a few kilobytes.
 */

const fs = require('node:fs');
const path = require('node:path');

const URL = process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = process.env.RADAR_KV_PREFIX || 'radar';
const FILE = process.env.RADAR_STORE_FILE ||
  (process.env.VERCEL ? '' : path.join(process.cwd(), '.radar-state', 'kv.json'));

const remote = !!(URL && TOKEN);
/** @type {Map<string,{value:string,expiry:number|null}>} */
const memory = new Map();
let warned = false;
let loaded = false;

// --- file backend -----------------------------------------------------------
// Local development parity: the same HTTP contract, backed by one JSON file
// that `python3 server.py` also reads, so the monitor can be exercised
// end-to-end without an Upstash account.
function fileLoad() {
  if (loaded || !FILE) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data)) memory.set(k, { value: String(v), expiry: null });
  } catch (_) { /* first run: nothing persisted yet */ }
}

function fileSave() {
  if (!FILE) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const out = {};
    for (const [k, v] of memory) {
      if (v.expiry != null && Date.now() > v.expiry) continue;
      out[k] = v.value;
    }
    fs.writeFileSync(FILE, JSON.stringify(out));
  } catch (_) { /* dev convenience only: never fail a tick over this */ }
}

const persist = () => { if (FILE) fileSave(); };

function key(k) {
  return PREFIX + ':' + k;
}

function memoryGet(k) {
  const hit = memory.get(k);
  if (!hit) return null;
  if (hit.expiry != null && Date.now() > hit.expiry) {
    memory.delete(k);
    return null;
  }
  return hit.value;
}

async function request(path, body) {
  const res = await fetch(URL.replace(/\/+$/, '') + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('upstash ' + res.status + ' ' + text.slice(0, 200));
  }
  const json = await res.json();
  if (json && json.error) throw new Error('upstash: ' + json.error);
  return json;
}

async function remoteCmd(args) {
  const json = await request('', args);
  return json && 'result' in json ? json.result : null;
}

async function remotePipeline(batches) {
  if (!batches.length) return [];
  const json = await request('/pipeline', batches);
  return Array.isArray(json) ? json.map(r => (r && 'result' in r ? r.result : null)) : [];
}

function warnOnce() {
  if (warned || process.env.NODE_ENV === 'test') return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn('[radar] no Upstash credentials — using in-memory store (dev only)');
}

module.exports = {
  /** Which backend is live. Surfaced in /api/pulse so misconfiguration is visible. */
  get backend() { return remote ? 'upstash' : (FILE ? 'file' : 'memory'); },
  get configured() { return remote; },

  async get(k) {
    if (!remote) { fileLoad(); warnOnce(); return memoryGet(key(k)); }
    return await remoteCmd(['GET', key(k)]);
  },

  async set(k, value) {
    if (!remote) { fileLoad(); warnOnce(); memory.set(key(k), { value: String(value) }); persist(); return 'OK'; }
    return await remoteCmd(['SET', key(k), String(value)]);
  },

  async del(k) {
    if (!remote) { fileLoad(); warnOnce(); memory.delete(key(k)); persist(); return 1; }
    return await remoteCmd(['DEL', key(k)]);
  },

  async mget(keys) {
    if (!keys.length) return [];
    if (!remote) { fileLoad(); warnOnce(); return keys.map(k => memoryGet(key(k))); }
    return await remotePipeline(keys.map(k => ['GET', key(k)]));
  },

  /**
   * Lock with expiry. Returns true when the caller owns the lock.
   * This is what stops two overlapping scheduler hits from evaluating the
   * same position twice and double-recording a paper fill.
   */
  async setnx(k, ttlMs) {
    if (!remote) {
      fileLoad(); warnOnce();
      const kk = key(k);
      const hit = memory.get(kk);
      if (hit && (hit.expiry == null || Date.now() <= hit.expiry)) return false;
      memory.set(kk, { value: '1', expiry: Date.now() + ttlMs });
      persist();
      return true;
    }
    const res = await remoteCmd(['SET', key(k), '1', 'NX', 'PX', String(Math.max(1, Math.round(ttlMs)))]);
    return res === 'OK' || res === true;
  },

  async readJSON(k, fallback) {
    const raw = await module.exports.get(k);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  },

  async writeJSON(k, value) {
    await module.exports.set(k, JSON.stringify(value));
    return value;
  }
};
