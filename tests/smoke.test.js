/**
 * Boot smoke test.
 *
 * Loads the real index.html in jsdom, runs every local script in document
 * order and fails on any uncaught exception or console error. This is the
 * safety net for the monolith extraction: the page is wired together by
 * ids and classes, so a broken selector has to show up here.
 *
 * Network is stubbed to fail, which forces the simulation path — that is
 * deliberately the widest code path (it still renders every section).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* optional dev dependency */
}

// Read the script order straight from the page: a hard-coded list silently
// falls behind whenever a module is extracted or renamed.
function scriptsFromPage() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const found = [];
  for (const match of html.matchAll(/<script\s+src="([^"]+)"/g)) {
    if (/^https?:/.test(match[1])) continue;          // lucide, from the CDN
    found.push(match[1].replace(/^\//, ''));
  }
  return found;
}

const SCRIPTS = scriptsFromPage();

function canvasStub() {
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'canvas') return null;
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
  return ctx;
}

/** Resolves when the boot overlay is gone (or already finished). */
async function waitForBoot(window) {
  for (let i = 0; i < 200; i++) {
    const el = window.document.getElementById('boot');
    if (!el || el.classList.contains('done')) return true;
    await wait(50);
  }
  return false;
}

function boot(options = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  // Pre-set preferences the terminal reads during boot (data mode) and let a
  // test observe the network instead of only forcing it to fail.
  if (options.dataMode) {
    window.localStorage.setItem('radar_datamode', JSON.stringify(options.dataMode));
  }

  window.HTMLCanvasElement.prototype.getContext = canvasStub;
  window.matchMedia = window.matchMedia || (q => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; }
  }));
  window.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  window.fetch = options.fetch || (() => Promise.reject(new Error('offline')));
  // Timer ownership matters: these must be window timers so window.close()
  // can clean them up, otherwise the test process never exits.
  window.requestAnimationFrame = cb => window.setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
  }
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() }, configurable: true
  });

  const errors = [];
  window.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', e => errors.push('unhandled rejection: ' + e.reason));
  const realError = window.console.error;
  window.console.error = (...args) => { errors.push('console.error: ' + args.join(' ')); realError(...args); };
  const realWarn = window.console.warn;
  window.console.warn = (...args) => {
    const text = args.map(String).join(' ');
    // The app intentionally warns about offline upstreams and render guards.
    if (/^(momentum|rerender |تحلیل|پایش)/.test(text)) return;
    errors.push('console.warn: ' + text);
    realWarn(...args);
  };

  // Concatenated into one evaluation: jsdom gives each window.eval() call its
  // own lexical scope, so evaluating the files separately would hide the
  // top-level declarations the later scripts depend on. The browser loads
  // them as separate classic scripts but shares one global object, which is
  // what this reproduces.
  const code = SCRIPTS.map(name => fs.readFileSync(path.join(ROOT, name), 'utf8')).join('\n;\n');
  window.eval(code);
  return { window, errors };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('terminal boots without runtime errors and renders every section', { skip: !JSDOM }, async () => {
  const { window, errors } = boot();
  // Boot is async: CoinGecko is offline, so the simulation fallback runs.
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(300);

  const $ = sel => window.document.querySelector(sel);

  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));

  // Shell
  assert.ok($('#topStatus').innerHTML.length > 0, 'top status must render');

  // Sections that were previously filled by hand-rolled renderers
  assert.ok($('#btcHead').innerHTML.includes('BTC'), 'anchor header must render');
  assert.ok($('#gstats').children.length >= 4, 'global stats must render');
  assert.ok($('#fngGauge').innerHTML.length > 0, 'fear & greed must render');
  assert.ok($('#anchorBadges').innerHTML.length > 0, 'anchor badges must render');

  // Signal table
  assert.ok($('#rows').children.length >= 50, 'signal rows must render, got ' + $('#rows').children.length);
  assert.ok($('#lhead').children.length > 0, 'signal header must render');

  // Momentum + protection mount into their own roots
  assert.ok($('#momentumRoot').innerHTML.length > 0, 'momentum watchlist must mount');
  assert.ok($('#protectionWrap').innerHTML.length > 0, 'protection panel must mount');

  // Portfolio / backtest / QA panels exist and are addressable
  for (const id of ['pfWrap', 'btMetrics', 'cmpStats', 'qaBody']) {
    assert.ok($('#' + id), '#' + id + ' must exist');
  }
  assert.ok($('#qaBadge').innerHTML.trim().length > 0, 'self-test badge must be filled');
  assert.ok($('#qaBadge').innerHTML.indexOf('—') === -1, 'self-test must have run at boot');

  // New shell: the overview strip, the always-reachable section rail and the
  // live-monitoring panel all have to render without a server.
  const ov = $('#ovGrid');
  assert.ok(ov.children.length >= 6, 'overview strip must render, got ' + ov.children.length);
  assert.ok(ov.textContent.includes('امتیاز بازار'), 'overview must include the market score');
  assert.ok(ov.textContent.includes('فاز بازار'), 'overview must include the regime');
  assert.ok($('#ovCycle').textContent.length > 0, 'overview must show the refresh cadence');

  const rail = $('#rail');
  assert.ok(rail, 'section rail must exist');
  assert.ok(rail.querySelectorAll('a').length >= 12, 'rail must list every section');
  // The rail replaced the topbar pills; there must be exactly one nav surface
  // driven by the scroll spy.
  assert.equal(window.document.querySelectorAll('.navpills').length, 0, 'old navpills must be gone');

  assert.ok($('#liveRoot').innerHTML.length > 0, 'live monitoring panel must render');
  assert.ok($('#liveRoot').textContent.includes('دفترچهٔ اجرای کاغذی'), 'ledger panel must render');
  assert.ok($('#pulseBtn'), 'heartbeat chip must exist');
  assert.ok(window.RadarLive, 'RadarLive bridge must be available');

  // The monitoring panel moved into its own section: «نمای کلی» is the market
  // snapshot only, and every live control lives under «پایش زنده».
  assert.ok($('#secLive').contains($('#liveRoot')), 'the live panel must live in its own section');
  assert.ok(!$('#secOverview').contains($('#liveRoot')), 'the overview must not host the live panel');
  for (const id of ['lvControl', 'lvEnabledSwitch', 'lvDataMode', 'lvStatusGrid', 'lvWhyBody', 'lvToken']) {
    assert.ok($('#' + id), '#' + id + ' must render inside the live section');
  }
  assert.equal($('#pulseBtn').getAttribute('aria-checked'), 'false',
    'the topbar chip must report the off state as a switch');
  assert.ok($('#lvWhyBody').textContent.length > 0, 'the diagnostics panel must explain itself');

  // Density is a token-only change: switching must not drop content.
  const before = $('#rows').children.length;
  const doc = window.document;
  window.eval('cycleDensity()');
  assert.equal(doc.documentElement.dataset.density, 'compact', 'density must cycle');
  assert.equal($('#rows').children.length, before, 'density must not change the row count');
  window.eval('cycleDensity();cycleDensity();');
  assert.equal(doc.documentElement.dataset.density, 'normal', 'density must cycle back');
  assert.ok($('#foot').innerHTML.includes('منبع داده'), 'footer must render');

  window.close();
});

test('the open page drives the server heartbeat instead of waiting for a cron', { skip: !JSDOM }, async () => {
  const { window, errors } = boot();
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);

  const calls = [];
  window.localStorage.setItem('radar_live', JSON.stringify({
    token: 'test-token', space: 'default', enabled: true
  }));
  const STATE = {
    ok: true, space: 'default', store: 'upstash', version: 4, updatedAt: Date.now(),
    portfolio: [], alerts: [], ledger: [], subscriptionCount: 0,
    intervalSec: 90, pulse: { lastRun: null, ticks: 0 }, push: { configured: false }
  };
  const TICK = {
    ok: true, space: 'default', positions: 0, evaluated: 0, signals: [], fills: [],
    adopted: [], alertsFired: [], problems: [], planStates: [], skipped: null
  };
  window.fetch = url => {
    calls.push(String(url));
    const body = String(url).includes('/api/pulse') ? TICK : STATE;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };

  // live.js reads its config at load time, so pick the token up the way a
  // reload would.
  window.eval(fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8'));
  await window.RadarLive.sync('test');
  await wait(50);

  assert.ok(calls.some(url => url.includes('/api/pulse')),
    'a sync must ask the server for a cycle: ' + JSON.stringify(calls));
  assert.equal(window.RadarLive.lastBeat.ok, true, 'the beat must report success');
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  window.close();
});

test('every /api/state call carries the configured namespace', { skip: !JSDOM }, async () => {
  // Regression: /api/pulse used to send ?space=… while /api/state sent none, so
  // a non-default «فضای نام» uploaded the portfolio into `default` and asked for
  // ticks against the configured space. The server therefore never saw a single
  // plan, and paper execution stayed empty next to a healthy heartbeat — the
  // exact symptom of "the paper engine does nothing".
  const { window, errors } = boot();
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);

  const urls = [];
  const STATE = {
    ok: true, space: 'alpha', store: 'upstash', version: 3, updatedAt: Date.now(),
    portfolio: [], alerts: [], ledger: [], subscriptionCount: 0,
    intervalSec: 90, pulse: { lastRun: null, ticks: 0 }, push: { configured: false }
  };
  const TICK = {
    ok: true, space: 'alpha', positions: 0, evaluated: 0, signals: [], fills: [],
    adopted: [], alertsFired: [], problems: [], planStates: [], skipped: null
  };
  window.localStorage.setItem('radar_live', JSON.stringify({
    token: 'test-token', space: 'alpha', enabled: true
  }));
  window.fetch = url => {
    const target = String(url);
    urls.push(target);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => (target.includes('/api/pulse') ? TICK : STATE)
    });
  };
  window.eval(fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8'));
  await window.RadarLive.sync('test', { beat: 'force' });
  await wait(50);

  const stateCalls = urls.filter(url => url.includes('/api/state'));
  assert.ok(stateCalls.length > 0, 'the state endpoint must be called: ' + JSON.stringify(urls));
  for (const url of stateCalls) {
    assert.ok(url.includes('space=alpha'),
      'a state call without the namespace lands in the wrong space: ' + url);
  }
  assert.ok(urls.some(url => url.includes('/api/pulse') && url.includes('space=alpha')),
    'the beat must keep asking in the same space: ' + JSON.stringify(urls));
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  window.close();
});

test('the readiness panel names the blocker and its remedy', { skip: !JSDOM }, async () => {
  // The panel exists because "the paper engine does nothing" has a dozen
  // unrelated causes that all look identical from the outside. It must name the
  // critical ones as blockers, not as cosmetic nits, and it must never call a
  // switched-off monitor "execution is active".
  const { window, errors } = boot();
  const ready = () => window.document.getElementById('lvReadyBody').textContent.replace(/\s+/g, ' ');
  try {
    assert.ok(await waitForBoot(window), 'boot overlay must finish');
    await wait(300);
    assert.ok(window.document.getElementById('lvReady'), 'the readiness panel must render');

    // No token, monitoring off: two blockers, and the verdict must say so.
    assert.match(ready(), /مانعِ اجرای کاغذی/, 'a blocked setup must not read as ready');
    assert.match(ready(), /توکنِ پایش وارد نشده/);
    assert.match(ready(), /پایشِ سرور خاموش است/);

    // Token stored, still off: the switch is the only blocker left.
    window.localStorage.setItem('radar_live', JSON.stringify({
      token: 'test-token', space: 'default', enabled: false
    }));
    window.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        ok: true, version: 0, portfolio: [], alerts: [], ledger: [],
        subscriptionCount: 0, intervalSec: 90,
        pulse: { lastRun: Date.now(), ticks: 1, lastSummary: { positions: 0, planStates: [] } },
        push: { configured: false }
      })
    });
    window.eval(fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8'));
    await wait(900);
    assert.match(ready(), /مانعِ اجرای کاغذی/, 'a switched-off monitor is a blocker');
    assert.doesNotMatch(ready(), /اجرا فعال است/,
      'execution must never be reported as active while the switch is off');

    assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  } finally {
    window.close();
  }
});

test('a rejected write keeps the server fills and the local edits', { skip: !JSDOM }, async () => {
  // Regression: on a 409 the page used to adopt the server copy wholesale,
  // discarding an edit that had never been uploaded. The merge must keep the
  // server's `protections` (it owns the paper fills) while preserving rows and
  // plans that exist only in the browser.
  const { window, errors } = boot();
  const now = Date.now();
  const localPlan = window.eval(`RadarProtection.create(${JSON.stringify({
    id: 'p-local', coinId: 'bitcoin', symbol: 'BTC', mode: 'live',
    entryPrice: 100, quantity: 1, enteredAt: now - 3600000, stop: 90
  })}, ${now - 3600000})`);
  const serverPlan = window.eval(`RadarProtection.create(${JSON.stringify({
    id: 'p-server', coinId: 'ethereum', symbol: 'ETH', mode: 'live',
    entryPrice: 200, quantity: 2, enteredAt: now - 3600000, stop: 180
  })}, ${now - 3600000})`);
  const STATE = {
    ok: true, space: 'merge', store: 'upstash', version: 9, updatedAt: Date.now(),
    portfolio: [{ id: 'ethereum', sym: 'ETH', name: 'Ethereum', qty: 2, buy: 200, protections: [serverPlan] }],
    alerts: [], ledger: [], subscriptionCount: 0, intervalSec: 90,
    pulse: { lastRun: null, ticks: 0 }, push: { configured: false }
  };
  const writes = [];
  window.localStorage.setItem('radar_live', JSON.stringify({
    token: 'test-token', space: 'merge', enabled: true
  }));
  // Reads succeed; every write is rejected the way a server that just booked a
  // paper fill rejects a client that is one version behind.
  window.fetch = (url, options) => {
    const target = String(url);
    if ((options && options.method) === 'PUT') {
      writes.push(target);
      return Promise.resolve({
        ok: false, status: 409,
        json: async () => ({ ok: false, error: 'version-conflict', ...STATE })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => STATE });
  };
  try {
    window.eval(fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8'));
    await wait(1200);                       // let the module's own sync settle

    // A browser-only edit: a new row plus a plan the server has never seen.
    await window.eval(`(async () => RadarTerminal.sync.applyPortfolio([
      { id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 1, buy: 100, protections: [${JSON.stringify(localPlan)}] },
      { id: 'solana', sym: 'SOL', name: 'Solana', qty: 5, buy: 20, protections: [] }
    ]))()`);
    await wait(400);

    assert.ok(writes.length > 0, 'the local edit must have been uploaded');
    const byId = new Map(window.RadarTerminal.state.pf.map(r => [r.id, r]));
    assert.ok(byId.has('ethereum'), 'the server row must survive the conflict');
    assert.ok(byId.has('solana'), 'a row that exists only locally must not be dropped');
    assert.ok(byId.has('bitcoin'), 'a plan that exists only locally must not be dropped');
    assert.equal(byId.get('ethereum').protections[0].id, 'p-server',
      'the server copy of a shared plan wins: it owns the paper fill');
    assert.equal(byId.get('bitcoin').protections[0].id, 'p-local',
      'a locally created plan must not be replaced by the server copy');
    assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  } finally {
    window.close();
  }
});

test('a disabled monitor stays quiet and never talks to the server', { skip: !JSDOM }, async () => {
  const { window, errors } = boot();
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);

  let calls = 0;
  window.localStorage.setItem('radar_live', JSON.stringify({
    token: 'test-token', space: 'default', enabled: false
  }));
  window.fetch = () => { calls++; return Promise.reject(new Error('offline')); };
  window.eval(fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8'));

  const before = window.RadarTerminal.state.pf.length;
  await window.RadarLive.sync('test');
  assert.equal(window.RadarLive.config.enabled, false);
  assert.equal(calls, 0, 'a disabled monitor must not talk to the server');
  assert.equal(window.RadarTerminal.state.pf.length, before, 'portfolio untouched');
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  window.close();
});

test('forced simulation boots without a single upstream request', { skip: !JSDOM }, async () => {
  const requests = [];
  const { window, errors } = boot({
    dataMode: 'simulation',
    fetch: url => { requests.push(String(url)); return Promise.reject(new Error('offline')); }
  });
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);

  assert.equal(window.RadarTerminal.state.forcedSim, true, 'the mode flag must be visible');
  assert.equal(window.RadarTerminal.state.live, false);
  assert.ok(window.RadarTerminal.state.coins.length >= 90, 'simulated universe must be built');
  assert.deepEqual(requests.filter(url => /coingecko|alternative\.me/.test(url)), [],
    'forced simulation must not call the upstream: ' + JSON.stringify(requests));
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  window.close();
});

test('simulation fallback keeps the terminal usable when CoinGecko is unreachable', { skip: !JSDOM }, async () => {
  const { window, errors } = boot();
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  const state = window.RadarTerminal.state;
  assert.equal(state.live, false, 'must fall back to simulation');
  assert.ok(state.coins.length >= 90, 'simulated universe must be built');
  assert.ok(state.byId.size === state.coins.length, 'byId index must match coins');
  assert.ok(state.market && Number.isFinite(state.market.score), 'market score must be finite');
  window.close();
});

test('enabling monitoring against an empty server never wipes the local portfolio', { skip: !JSDOM }, async () => {
  const { window, errors } = boot();
  assert.ok(await waitForBoot(window), 'boot overlay must finish');
  await wait(200);

  const doc = window.document;
  const PORTFOLIO = [{ id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', qty: 3, buy: 61000 }];
  await window.RadarTerminal.sync.applyPortfolio(PORTFOLIO);
  assert.equal(window.RadarTerminal.state.pf.length, 1, 'portfolio seeded locally');

  // Pretend the user just pasted a token: the server exists but is empty.
  window.localStorage.setItem('radar_live', JSON.stringify({
    token: 'test-token', space: 'default', enabled: true
  }));
  window.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true, space: 'default', store: 'upstash', version: 0, updatedAt: 0,
      portfolio: [], alerts: [], ledger: [], subscriptionCount: 0,
      intervalSec: 90, pulse: null, push: { configured: false }
    })
  });

  // Config is read when the module loads, so re-evaluate live.js to pick up
  // the token — exactly what a page reload would do.
  const liveSource = fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8');
  window.eval(liveSource);
  assert.equal(window.RadarLive.config.token, 'test-token', 'module must pick up the token');
  await window.RadarLive.sync('test');

  assert.equal(window.RadarTerminal.state.pf.length, 1,
    'the local portfolio must survive first contact with an empty server');
  assert.equal(window.RadarTerminal.state.pf[0].qty, 3);
  assert.deepEqual(errors, [], 'runtime errors:\n' + errors.join('\n'));
  window.close();
});
