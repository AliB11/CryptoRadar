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

function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = canvasStub;
  window.matchMedia = window.matchMedia || (q => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; }
  }));
  window.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  window.fetch = () => Promise.reject(new Error('offline'));
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
