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
const crypto = require('node:crypto');

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
  if (!FILE) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    memory.clear();
    for (const [k, v] of Object.entries(data)) memory.set(k,
      v && typeof v === 'object' && 'value' in v ? v : { value: String(v), expiry: null });
  } catch (_) { /* first run: nothing persisted yet */ }
}

function fileSave() {
  if (!FILE) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const out = {};
  for (const [k, v] of memory) {
    if (v.expiry != null && Date.now() > v.expiry) continue;
    out[k] = v.expiry == null ? v.value : v;
  }
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, FILE);
}

// The lock covers only local synchronous file operations, never network I/O.
// All subprocesses reload the latest file inside the lock before changing it.
async function fileMutation(fn) {
  if (!FILE) return fn();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const lock = FILE + '.lock';
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        }
      } catch (_) {}
      if (attempt >= 100) throw new Error('local store busy');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { fileLoad(); return fn(); }
  finally { fs.unlinkSync(lock); }
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
  // Say which fallback is actually live: "in-memory" would be wrong (and
  // alarming) when the file backend is persisting to .radar-state/kv.json.
  console.warn('[radar] no Upstash credentials — using ' +
    (FILE ? 'local file store (' + FILE + ')' : 'in-memory store') + ' (dev only)');
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
    if (!remote) return fileMutation(() => { warnOnce(); memory.set(key(k), { value: String(value) }); persist(); return 'OK'; });
    return await remoteCmd(['SET', key(k), String(value)]);
  },

  async del(k) {
    if (!remote) return fileMutation(() => { warnOnce(); memory.delete(key(k)); persist(); return 1; });
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
  async setnx(k, ttlMs, owner = '1') {
    if (!remote) return fileMutation(() => {
      warnOnce();
      const kk = key(k);
      const hit = memory.get(kk);
      if (hit && (hit.expiry == null || Date.now() <= hit.expiry)) return false;
      memory.set(kk, { value: owner, expiry: Date.now() + ttlMs });
      persist();
      return true;
    });
    const res = await remoteCmd(['SET', key(k), owner, 'NX', 'PX', String(Math.max(1, Math.round(ttlMs)))]);
    return res === 'OK' || res === true;
  },

  // Every state writer uses an atomic version check, including ticks. A lease
  // expiring during a slow quote fetch can no longer overwrite a newer fill.
  async compareAndSetJSON(k, version, value) {
    const next = JSON.stringify(value);
    if (!remote) return fileMutation(() => {
      const raw = memoryGet(key(k));
      const previous = raw ? JSON.parse(raw) : null;
      if ((previous ? Number(previous.version) || 0 : 0) !== version) return false;
      memory.set(key(k), { value: next }); persist(); return true;
    });
    const lua = "local old=redis.call('GET',KEYS[1]); local v=0; if old then v=tonumber(cjson.decode(old).version) or 0 end; if v~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
    return Number(await remoteCmd(['EVAL', lua, '1', key(k), String(version), next])) === 1;
  },

  async acquireLock(k, ttlMs) {
    const owner = crypto.randomUUID();
    return await module.exports.setnx(k, ttlMs, owner) ? owner : null;
  },

  async releaseLock(k, owner) {
    if (!owner) return false;
    if (!remote) return fileMutation(() => {
      if (memoryGet(key(k)) !== owner) return false;
      memory.delete(key(k)); persist(); return true;
    });
    const lua = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    return !!await remoteCmd(['EVAL', lua, '1', key(k), owner]);
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
