'use strict';
/**
 * /api/pulse — the always-on heartbeat.
 *
 * One invocation = one monitoring cycle. It is deliberately trigger-agnostic:
 * anything may call it (Vercel Cron, an external scheduler, the pinger script,
 * or an open browser) because the 90-second cadence is enforced *inside* the
 * tick against the stored heartbeat, not by the caller's frequency.
 *
 *   GET /api/pulse            run a tick (skipped when not due)
 *   GET /api/pulse?force=1    run a tick now, ignoring the cadence
 *   GET /api/pulse?status=1   read the heartbeat without running anything
 *
 * Auth: when CRON_SECRET is set it must be presented as
 * `Authorization: Bearer <secret>` — that is exactly what Vercel Cron sends.
 * Otherwise RADAR_TOKEN is required if set. With neither configured the route
 * stays open so a fresh clone can be tried immediately.
 */

const http = require('../lib/http.js');
const monitor = require('../lib/monitor.js');
const store = require('../lib/store.js');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { http.send(res, 204, {}); return; }
  if (req.method && req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    http.send(res, 405, { error: 'method' }); return;
  }

  const cronSecret = process.env.CRON_SECRET || '';
  const radarToken = process.env.RADAR_TOKEN || '';
  if (cronSecret) {
    if (!http.safeEqual(http.tokenFrom(req), cronSecret)) {
      http.send(res, 401, { error: 'unauthorized' }); return;
    }
  } else if (radarToken) {
    if (!http.safeEqual(http.tokenFrom(req), radarToken)) {
      http.send(res, 401, { error: 'unauthorized' }); return;
    }
  }

  const params = (() => {
    try { return new URL(req.url, 'http://radar.local').searchParams; } catch (_) { return new URLSearchParams(); }
  })();

  try {
    // Cheap read used by the status chip and by uptime monitors.
    if (params.get('status') === '1') {
      const pulse = await monitor.readPulse(http.spaceOf(req, null));
      const staleAfter = Number(process.env.PULSE_INTERVAL_SEC || 90) * 1000 * 4;
      const age = pulse && pulse.lastRun ? Date.now() - pulse.lastRun : null;
      http.send(res, 200, {
        ok: true, mode: 'status', store: store.backend, pulse,
        ageMs: age, late: age != null && age > staleAfter,
        nextInMs: pulse && pulse.lastRun
          ? Math.max(0, pulse.lastRun + Number(pulse.intervalSec || 90) * 1000 - Date.now())
          : 0
      });
      return;
    }

    const result = await monitor.tick({
      now: Date.now(),
      force: params.get('force') === '1' || params.get('force') === 'true',
      space: http.spaceOf(req, null)
    });
    http.send(res, result.ok ? 200 : 500, result);
  } catch (error) {
    http.send(res, 500, {
      ok: false, error: String(error && error.message || error),
      store: store.backend
    });
  }
};

// Long enough for a cold start plus two CoinGecko round-trips; short enough
// to stay inside the Hobby ceiling (60s without fluid compute).
module.exports.config = { maxDuration: 60 };
