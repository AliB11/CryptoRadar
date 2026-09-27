#!/usr/bin/env node
/**
 * The 90-second heartbeat pinger.
 *
 * Vercel's own scheduler is capped at one run per day on the Hobby plan, so
 * the cadence has to come from outside. That is fine: Vercel restricts *its*
 * cron configuration, not inbound requests to a function. Anything that
 * issues a GET on a schedule will do — this script is the one we ship because
 * it needs nothing but Node 18+ and it holds the cadence exactly.
 *
 *   node tools/pinger.mjs --url https://<host>/api/pulse --token <RADAR_TOKEN>
 *   node tools/pinger.mjs --once                 # single tick, then exit
 *   node tools/pinger.mjs --interval 90 --space default
 *   node tools/pinger.mjs --local                # run ticks in-process (dev)
 *
 * Run it anywhere that stays up: a Raspberry Pi, a home server, a free
 * container, or the smallest VPS you can find. It is stateless — if it dies,
 * restart it; the server's stored heartbeat decides when work is actually due,
 * so a missed beat never causes a burst of catch-up ticks.
 */

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.PULSE_URL || '';
const token = args.token || process.env.RADAR_TOKEN || '';
const space = args.space || process.env.RADAR_SPACE || 'default';
const intervalSec = clamp(Number(args.interval || process.env.PULSE_INTERVAL_SEC || 90), 30, 3600);
const local = flag(args, 'local');
const once = flag(args, 'once');
const quiet = flag(args, 'quiet');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = 'true';
  }
  return out;
}
function flag(o, name) { return o[name] === 'true' || o[name] === true || o[name] === ''; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)); }

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...m) => { if (!quiet) console.log('[' + stamp() + ']', ...m); };

/** Align to the wall clock so a restart does not shift the whole schedule. */
function nextDelay() {
  const ms = intervalSec * 1000;
  const now = Date.now();
  return ms - (now % ms);
}

async function runLocalTick() {
  const monitor = await import('../lib/monitor.js');
  const started = Date.now();
  const result = await monitor.tick({ now: started, space });
  return { result, ms: Date.now() - started };
}

async function runRemoteTick() {
  const target = new URL(url);
  target.searchParams.set('space', space);
  const started = Date.now();
  const res = await fetch(target, {
    headers: token ? { 'x-radar-token': token } : {},
    cache: 'no-store',
    signal: AbortSignal.timeout(55000)
  });
  const body = await res.json().catch(() => null);
  return { result: body, ms: Date.now() - started, status: res.status };
}

function describe(result) {
  if (!result) return 'no response body';
  if (result.skipped) {
    return 'skipped (' + result.skipped + ')' +
      (result.nextInMs != null ? ' · next in ' + Math.round(result.nextInMs / 1000) + 's' : '');
  }
  const bits = [
    result.evaluated + '/' + result.positions + ' evaluated',
    (result.signals || []).length + ' signal',
    (result.fills || []).length + ' paper fill',
    (result.alertsFired || []).length + ' alert'
  ];
  if (result.problems && result.problems.length) bits.push(result.problems.length + ' problem');
  return bits.join(' · ');
}

let failures = 0;
let ticks = 0;
let stopping = false;

async function beat(isFirst) {
  try {
    const outcome = local ? await runLocalTick() : await runRemoteTick();
    const result = outcome.result;
    if (result && result.ok === false) {
      failures++;
      log('ERROR after ' + outcome.ms + 'ms —', result.error || ('HTTP ' + outcome.status));
    } else if (outcome.status && outcome.status >= 400) {
      failures++;
      log('HTTP ' + outcome.status + ' —', JSON.stringify(result).slice(0, 200));
    } else {
      failures = 0;
      ticks++;
      log(outcome.ms + 'ms ·', describe(result));
      for (const fill of (result && result.fills) || []) {
        log('  ↳ paper fill', fill.symbol, fill.reason, fill.quantity, '@', fill.price);
      }
      for (const signal of (result && result.signals) || []) {
        log('  ↳ signal', signal.symbol, signal.reason, signal.action);
      }
    }
  } catch (error) {
    failures++;
    log('FAILED —', String(error && error.message || error));
  }
  if (failures >= 10) {
    log('10 consecutive failures — backing off to 5 minutes.');
    return Math.min(300000, intervalSec * 1000 * 4);
  }
  // Exponential-ish backoff keeps a brief outage from hammering the function.
  return failures ? Math.min(300000, intervalSec * 1000 * Math.pow(2, failures)) : nextDelay();
}

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const onStop = () => { clearTimeout(timer); resolve(); };
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
    if (stopping) onStop();
  });
}

(async function main() {
  if (!local && !url) {
    console.error('Missing --url (or PULSE_URL). Example:\n' +
      '  node tools/pinger.mjs --url https://crypto-radar-five.vercel.app/api/pulse --token <RADAR_TOKEN>');
    process.exit(2);
  }
  log('radar pinger · every ' + intervalSec + 's · ' +
      (local ? 'in-process ticks' : url) + ' · space=' + space);

  if (once) {
    await beat(true);
    return;
  }
  for (;;) {
    const delay = await beat(ticks === 0);
    if (stopping) break;
    await sleep(delay);
    if (stopping) break;
  }
  log('stopped after ' + ticks + ' ticks');
})();

process.on('SIGINT', () => { stopping = true; log('shutting down…'); });
process.on('SIGTERM', () => { stopping = true; log('shutting down…'); });
