'use strict';
/**
 * CryptoQuant on-chain context (https://cryptoquant.com/).
 *
 * Everything here is OPTIONAL: the integration activates only when
 * `CRYPTOQUANT_API_KEY` is set (a paid CryptoQuant plan issues the key) and
 * degrades to a `not-configured` status otherwise — the terminal, the paper
 * engine and the monitors keep working exactly as before.
 *
 * Two well-documented BTC metrics feed a single, deliberately narrow gate:
 *   - exchange netflow  (`/v1/btc/exchange-flows/netflow`): a spike of coins
 *     moving onto exchanges historically precedes distribution. Latest value
 *     z-scored against its own trailing week.
 *   - adjusted SOPR     (`/v1/btc/market-indicator/sopr`): >~1.05 means the
 *     market realizes profit en masse; <~0.93 means capitulation selling.
 *
 * The gate can only ever suppress NEW paper signal entries (buys) — stops,
 * targets, opposite-signal closes and every protection plan run regardless.
 * That narrowness is the point: an on-chain regime check should veto entry
 * timing, never trap a position. Thresholds are env-tunable and the whole
 * gate can be switched off with ONCHAIN_GATE=off (context still displays).
 *
 * Server-side only: the key never reaches query strings, HTML or the browser.
 */
const BASE = 'https://api.cryptoquant.com/v1/';
const TTL_MS = 10 * 60000;
const METRICS = Object.freeze([
  {
    key: 'netflow',
    path: 'btc/exchange-flows/netflow',
    // Field names across API revisions; first numeric hit wins.
    fields: ['netflow_value', 'exchange_netflow_value', 'netflow', 'value']
  },
  {
    key: 'sopr',
    path: 'btc/market-indicator/sopr',
    fields: ['a_sopr', 'adjusted_sopr', 'sopr', 'value']
  }
]);

const cache = new Map(); // metric key → {t, row}
const inflight = new Map();

function apiKey() {
  const key = process.env.CRYPTOQUANT_API_KEY || '';
  return key.trim();
}

function resetCache() {
  cache.clear();
  inflight.clear();
}

/** Tolerant envelope parse: v1 wraps rows in result.data, some paths use data. */
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && body.result && Array.isArray(body.result.data)) return body.result.data;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && body.result && Array.isArray(body.result)) return body.result;
  return null;
}

function pick(row, fields) {
  if (!row || typeof row !== 'object') return null;
  for (const f of fields) {
    const v = Number(row[f]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Latest value + z-score against the trailing samples (population std). */
function summarize(rows, fields) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const values = rows.map(r => pick(r, fields)).filter(v => v != null);
  if (!values.length) return null;
  const latest = values[values.length - 1];
  const prior = values.slice(Math.max(0, values.length - 14), -1);
  if (prior.length >= 6) {
    const m = prior.reduce((s, x) => s + x, 0) / prior.length;
    const sd = Math.sqrt(prior.reduce((s, x) => s + (x - m) ** 2, 0) / prior.length);
    return { latest, samples: values.length, z: sd > 0 ? (latest - m) / sd : 0, mean: m };
  }
  return { latest, samples: values.length, z: null, mean: null };
}

async function fetchMetric(metric, fetcher) {
  const key = apiKey();
  if (!key) return { status: 'not-configured' };
  const hit = cache.get(metric.key);
  if (hit && Date.now() - hit.t < TTL_MS) return { ...hit.row, cached: true };
  const pending = inflight.get(metric.key);
  if (pending) return pending;
  const task = (async () => {
    const response = await (fetcher || globalThis.fetch)(
      BASE + metric.path + '?window=day&limit=30',
      {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
      }
    );
    if (!response.ok) {
      const error = new Error('cryptoquant upstream ' + response.status);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const rows = rowsOf(body);
    if (!rows) return { status: 'unparsed' };
    const summary = summarize(rows, metric.fields);
    if (!summary) return { status: 'unparsed' };
    const row = { status: 'ok', ...summary };
    cache.set(metric.key, { t: Date.now(), row });
    return { ...row, cached: false };
  })().finally(() => inflight.delete(metric.key));
  inflight.set(metric.key, task);
  return task;
}

/**
 * Full on-chain context. Never throws — an unreachable CryptoQuant is a
 * degraded context, not a failed heartbeat.
 */
async function getContext(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!apiKey()) return { status: 'not-configured', asOf: null, veto: false, reasons: [], cached: false };
  const out = { status: 'ok', asOf: null, netflow: null, sopr: null, veto: false, reasons: [], cached: false };
  let failures = 0;
  for (const metric of METRICS) {
    try {
      const reply = await fetchMetric(metric, options.fetch);
      if (reply.cached) out.cached = true;
      if (reply.status !== 'ok') { failures++; out.status = reply.status; continue; }
      out[metric.key] = { latest: reply.latest, z: reply.z, samples: reply.samples };
      out.asOf = out.asOf == null ? now : out.asOf;
    } catch (error) {
      failures++;
      out.status = 'error';
      out.error = String(error && error.message || error).slice(0, 160);
    }
  }
  if (failures === METRICS.length) return out; // nothing usable
  if (failures > 0 && out.status !== 'ok') out.status = 'ok'; // partial data still displays

  // --- gate decision (pure function, shared with tests via decide()) ---
  const verdict = decide(out);
  out.reasons = verdict.reasons;
  out.veto = verdict.veto;
  out.asOf = now;
  return out;
}

/**
 * The narrow entry gate used by the monitor tick. `ONCHAIN_GATE=off` shows
 * context but never vetoes; no key never vetoes.
 */
async function getGate(options = {}) {
  const context = await getContext(options);
  const off = process.env.ONCHAIN_GATE === 'off';
  return {
    status: context.status,
    asOf: context.asOf || null,
    veto: !off && context.veto === true,
    reasons: Array.isArray(context.reasons) ? context.reasons : [],
    cached: !!context.cached
  };
}

/** Pure decision helper for tests: context → veto verdict. */
function decide(context, env = process.env) {
  if (!context || context.status !== 'ok') return { veto: false, reasons: [] };
  if (env.ONCHAIN_GATE === 'off') return { veto: false, reasons: [] };
  const reasons = [];
  const netflow = context.netflow;
  const sopr = context.sopr;
  const netflowZ = Number.isFinite(Number(env.CQ_NETFLOW_Z)) ? Number(env.CQ_NETFLOW_Z) : 2;
  const soprHigh = Number.isFinite(Number(env.CQ_SOPR_HIGH)) ? Number(env.CQ_SOPR_HIGH) : 1.05;
  const soprLow = Number.isFinite(Number(env.CQ_SOPR_LOW)) ? Number(env.CQ_SOPR_LOW) : 0.93;
  if (netflow && netflow.z != null && netflow.samples >= 7 && netflow.z >= netflowZ) reasons.push('netflow-spike');
  if (sopr && sopr.latest > soprHigh) reasons.push('sopr-profit-taking');
  if (sopr && sopr.latest < soprLow) reasons.push('sopr-capitulation');
  return { veto: reasons.length > 0, reasons };
}

module.exports = { getContext, getGate, decide, rowsOf, summarize, resetCache, enabled: () => !!apiKey() };
