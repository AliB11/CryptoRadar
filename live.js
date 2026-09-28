'use strict';
/**
 * RadarLive — the browser half of 24/7 monitoring.
 *
 * The terminal's own 90-second loop only runs while the tab is open, which is
 * exactly when a stop loss is least likely to need attention. This module
 * pairs the page with the server-side heartbeat:
 *
 *   - registers a Web Push subscription so the server can wake the device
 *   - mirrors portfolio + alerts into the server's store
 *   - *drives the heartbeat while it is open*: `beat()` asks /api/pulse for a
 *     cycle, and the server decides from its own stored clock whether work is
 *     due. Vercel's Hobby cron only fires once a day, so without this the
 *     monitor silently never runs unless an external pinger was set up.
 *   - adopts the server's copy when a tick has moved ahead (a paper fill that
 *     happened overnight must not be overwritten from a stale tab)
 *   - renders the whole «پایش زنده» section: the on/off control, the engine
 *     status, the diagnostics that answer "why is nothing being executed?"
 *     and the paper-execution ledger
 *
 * Nothing here places an order. Everything the server books is paper.
 */
(function (root) {
  const CFG_KEY = 'radar_live';
  const PUSH_FLAG = 'radar_live_push';
  const DATA_KEY = 'radar_datamode';           // shared with the terminal's store
  const BEAT_EARLY_MS = 2000;                  // ask slightly before the cycle is due

  const el = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 10 });
  const price = v => {
    const n = Number(v);
    if (v == null || !isFinite(n)) return '—';
    return (n < 0 ? '-$' : '$') + nf.format(Math.abs(n));
  };
  const when = v => (v ? new Date(v).toLocaleString('fa-IR') : '—');

  const cfg = Object.assign({ token: '', space: 'default', enabled: false }, read());

  function read() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function save() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
  }

  /** «شبیه‌سازی اجباری» off means the page may use live CoinGecko data. */
  function dataMode() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return 'auto';
      const value = JSON.parse(raw);
      return value === 'simulation' ? 'simulation' : 'auto';
    } catch (_) { return 'auto'; }
  }

  const api = {
    bootstrapped: false,
    serverVersion: null,
    state: { version: 0, portfolio: [], alerts: [], ledger: [], pulse: null, subscriptionCount: 0 },
    pushKey: null,
    intervalSec: 90,
    lastError: null,
    lastBeat: null,        // { at, ok, skipped, fills, signals, error }
    lastSyncAt: 0,
    busy: false,
    fingerprint: ''
  };

  const headers = () => ({
    'Content-Type': 'application/json',
    'x-radar-token': cfg.token
  });

  const ready = () => !!(cfg.enabled && cfg.token);

  async function call(path, options) {
    const res = await fetch('/api/state' + path, {
      method: (options && options.method) || 'GET',
      headers: headers(),
      body: options && options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      const error = new Error((body && (body.detail || body.error)) || ('HTTP ' + res.status));
      error.status = res.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function fingerprintOf(portfolio, alerts) {
    return JSON.stringify(portfolio || []).length + ':' + JSON.stringify(portfolio || []) +
           '|' + JSON.stringify(alerts || []);
  }

  /* ---------- Web Push ---------- */

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function pushSupported() {
    return !!(root.PushManager && 'serviceWorker' in navigator && 'Notification' in window);
  }

  async function currentSubscription() {
    if (!await pushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (_) { return null; }
  }

  async function enablePush(notify) {
    if (!ready()) throw new Error('ابتدا توکنِ پایش را ذخیره کنید.');
    if (!await pushSupported()) throw new Error('این مرورگر اعلان فشاری (Web Push) ندارد.');
    if (!api.pushKey) throw new Error('کلید عمومی اعلان از سرور دریافت نشده است.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('اجازهٔ اعلان داده نشد.');
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(api.pushKey)
      });
    }
    const json = subscription.toJSON();
    await call('', {
      method: 'POST',
      body: { action: 'subscribe', subscription: json, label: (navigator.userAgent || '').slice(0, 80) }
    });
    try { localStorage.setItem(PUSH_FLAG, '1'); } catch (_) {}
    if (notify) await showLocal('رادارِ بازار', 'اعلانِ شبانه‌روزی وصل شد — حتی با بسته‌بودنِ این صفحه خبر می‌دهیم.');
    return true;
  }

  async function disablePush() {
    const subscription = await currentSubscription();
    if (subscription) {
      const json = subscription.toJSON();
      try {
        await call('', { method: 'POST', body: { action: 'unsubscribe', endpoint: json.endpoint } });
      } catch (_) { /* the server may never have seen it */ }
      try { await subscription.unsubscribe(); } catch (_) {}
    }
    try { localStorage.removeItem(PUSH_FLAG); } catch (_) {}
  }

  async function showLocal(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) { await reg.showNotification(title, { body }); return; }
    } catch (_) {}
    try { new Notification(title, { body }); } catch (_) {}
  }

  /* ---------- sync ---------- */

  const term = () => root.RadarTerminal;

  function localSnapshot() {
    const t = term();
    if (!t || !t.state) return { portfolio: [], alerts: [] };
    return { portfolio: t.state.pf || [], alerts: t.state.alerts || [] };
  }

  /**
   * The server is authoritative once it is ahead, so its copy is written
   * through the terminal's sanctioned entry point (Web Locks + validation).
   * Awaiting it matters: the fingerprint below must describe what is actually
   * stored, otherwise the next cycle re-uploads a stale copy for nothing.
   */
  async function applyServer(data) {
    const t = term();
    if (!t || !t.sync) return;
    if (Array.isArray(data.portfolio)) await t.sync.applyPortfolio(data.portfolio);
    if (Array.isArray(data.alerts)) t.sync.applyAlerts(data.alerts);
    const snap = localSnapshot();
    api.fingerprint = fingerprintOf(snap.portfolio, snap.alerts);
  }

  async function pull() {
    const data = await call('');
    api.state = data;
    api.intervalSec = Number(data.intervalSec) || 90;
    api.pushKey = data.push && data.push.configured ? data.push.publicKey : null;

    const serverVersion = Number(data.version) || 0;
    const hasContent = (data.portfolio && data.portfolio.length) ||
                       (data.alerts && data.alerts.length) ||
                       (data.ledger && data.ledger.length);

    if (!api.bootstrapped) {
      // First contact is the dangerous one. An empty server must never be
      // treated as "server is ahead": that would wipe a portfolio the user has
      // been building for months the moment they switch monitoring on.
      api.bootstrapped = true;
      api.serverVersion = serverVersion;
      if (hasContent) await applyServer(data);
    } else if (serverVersion > Number(api.serverVersion || 0)) {
      // Afterwards the server wins whenever it moved on: a tick may have
      // booked a paper fill while this tab was closed.
      api.serverVersion = serverVersion;
      await applyServer(data);
    }

    api.lastError = null;
    api.lastSyncAt = Date.now();
    return data;
  }

  async function pushUp() {
    const snap = localSnapshot();
    const next = fingerprintOf(snap.portfolio, snap.alerts);
    if (next === api.fingerprint) return { skipped: 'unchanged' };
    try {
      const data = await call('', {
        method: 'PUT',
        body: { base: api.serverVersion, portfolio: snap.portfolio, alerts: snap.alerts }
      });
      api.serverVersion = Number(data.version);
      api.fingerprint = next;
      api.lastError = null;
      return data;
    } catch (error) {
      if (error.status === 409 && error.body) {
        // The server moved on (a tick booked a fill). Take its copy, then let
        // the next cycle retry our local edit on top of it.
        await applyServer(error.body);
        api.serverVersion = Number(error.body.version);
        throw error;
      }
      throw error;
    }
  }

  /* ---------- heartbeat ---------- */

  /** When the server would consider a new cycle due, from its own record. */
  function nextDueAt() {
    const pulse = api.state && api.state.pulse;
    if (!pulse || !pulse.lastRun) return 0;
    return pulse.lastRun + (Number(pulse.intervalSec) || api.intervalSec) * 1000;
  }

  /**
   * Ask /api/pulse for one cycle. Unforced on purpose: the endpoint enforces
   * the 90-second cadence against the stored heartbeat, so extra callers (this
   * tab, an external pinger, Vercel's daily cron) can never double-run a tick.
   */
  async function beat(options) {
    if (!ready()) return null;
    const force = !!(options && options.force);
    const query = '?space=' + encodeURIComponent(cfg.space) + (force ? '&force=1' : '');
    const res = await fetch('/api/pulse' + query, {
      headers: { 'x-radar-token': cfg.token },
      cache: 'no-store'
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      api.lastBeat = {
        at: Date.now(), ok: false, force,
        error: (body && (body.detail || body.error)) || ('HTTP ' + res.status)
      };
      return api.lastBeat;
    }
    api.lastBeat = {
      at: Date.now(), ok: true, force,
      skipped: (body && body.skipped) || null,
      positions: body ? body.positions : null,
      signals: body && body.signals ? body.signals.length : 0,
      fills: body && body.fills ? body.fills.length : 0,
      adopted: body && body.adopted ? body.adopted.length : 0,
      problems: body && body.problems ? body.problems.length : 0,
      error: body && body.ok === false ? (body.error || 'tick failed') : null
    };
    if (api.lastBeat.error) api.lastBeat.ok = false;
    return api.lastBeat;
  }

  /** Beat only when the server's own clock says a cycle is due. */
  async function beatIfDue() {
    if (!ready()) return null;
    const dueAt = nextDueAt();
    if (dueAt && Date.now() < dueAt - BEAT_EARLY_MS) return null;
    try {
      return await beat();
    } catch (error) {
      api.lastBeat = { at: Date.now(), ok: false, error: String(error && error.message || error) };
      return api.lastBeat;
    }
  }

  /**
   * @param {string} reason   what asked for the sync (timer, visible, manual…)
   * @param {{beat?: 'force'|'due'|'never'}} [options] heartbeat policy
   */
  async function sync(reason, options = {}) {
    if (!ready() || api.busy) return null;
    api.busy = true;
    try {
      await pull();
      // The page is the most reliable trigger an installation has: Vercel's
      // Hobby cron fires once a day, and an external pinger is optional. The
      // cadence itself still belongs to the server.
      const policy = options.beat || 'due';
      const beatResult = policy === 'never' ? null
        : policy === 'force' ? await beat().catch(error => ({ ok: false, error: String(error && error.message || error) }))
        : await beatIfDue();
      if (beatResult && beatResult.ok && !beatResult.skipped) {
        // A cycle just ran and may have booked fills: read them back now so
        // the ledger and the plan states move the moment the user looks.
        await pull();
      }
      await pushUp();
      render();
    } catch (error) {
      api.lastError = error && error.message ? error.message : String(error);
      render();
    } finally {
      api.busy = false;
    }
    return api.state;
  }

  async function forceTick() {
    if (!ready()) throw new Error('ابتدا توکنِ پایش را ذخیره کنید.');
    const result = await beat({ force: true });
    if (!result || !result.ok) throw new Error((result && result.error) || 'اجرای تیک ناموفق بود.');
    await pull();
    render();
    return result;
  }

  /**
   * Flip monitoring from the topbar. Turning it off asks first: a stray click
   * must never quietly stop the paper engine. Turning it on without a stored
   * token cannot work, so that path opens the section and focuses the field
   * instead of pretending to succeed.
   */
  async function toggleMonitoring() {
    if (cfg.enabled && cfg.token) {
      const plans = ((localSnapshot().portfolio) || [])
        .filter(row => Array.isArray(row.protections) && row.protections.length).length;
      const question = plans
        ? 'پایش شبانه‌روزی خاموش شود؟ ' + fa(plans) + ' دارایی طرح حفاظتی دارد و تا روشن‌کردن دوباره، هیچ تیک و اجرای کاغذی ثبت نمی‌شود.'
        : 'پایش شبانه‌روزی خاموش شود؟';
      if (!root.confirm(question)) return false;
      await setEnabled(false);
      flash('پایش سرور خاموش شد — پرتفوی و هشدارها دست‌نخورده ماندند.', false);
      return false;
    }
    if (!cfg.token) {
      openSection();
      const token = el('lvToken');
      if (token) token.focus();
      flash('برای روشن‌کردن پایش، توکنِ RADAR_TOKEN را در همین بخش ذخیره کنید.', true);
      return false;
    }
    await setEnabled(true);
    flash('پایش سرور روشن شد — هر ' + fa(api.intervalSec) + ' ثانیه یک تیک.', false);
    return true;
  }

  /** One-click monitoring switch, used by the topbar and by the section. */
  async function setEnabled(on) {
    cfg.enabled = !!on;
    save();
    if (!cfg.enabled) {
      api.lastBeat = null;
      render();
      return false;
    }
    if (!cfg.token) {
      render();
      return false;
    }
    await sync('switch');
    render();
    return true;
  }

  /**
   * Live data or forced simulation. This is the terminal's data source, not the
   * monitoring engine: with «شبیه‌سازی اجباری» the page never calls CoinGecko
   * and the plans keep their simulated prices. Applied by reloading, because
   * the boot pipeline is what decides the source.
   */
  function setDataMode(mode) {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(mode === 'simulation' ? 'simulation' : 'auto')); } catch (_) {}
    root.location.reload();
  }

  /* ---------- rendering ---------- */

  function ageText(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return fa(s) + ' ثانیه';
    if (s < 3600) return fa(Math.round(s / 60)) + ' دقیقه';
    return fa(Math.round(s / 3600)) + ' ساعت';
  }

  function fa(v) {
    return String(v).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  }

  function statusOf() {
    const pulse = api.state && api.state.pulse;
    if (!cfg.enabled) return { cls: 'off', label: 'پایش سرور: خاموش', age: '—' };
    if (!cfg.token) return { cls: 'off', label: 'پایش سرور: بدون توکن', age: '—' };
    if (api.lastError) return { cls: 'down', label: 'خطا در همگام‌سازی', age: api.lastError.slice(0, 40) };
    if (!pulse || !pulse.lastRun) return { cls: 'late', label: 'در انتظارِ نخستین تیک', age: '—' };
    const age = Date.now() - pulse.lastRun;
    const late = age > api.intervalSec * 1000 * 4;
    return {
      cls: late ? 'late' : 'live',
      label: late ? 'تیک عقب افتاده' : 'پایش شبانه‌روزی فعال',
      age: ageText(age)
    };
  }

  /**
   * The topbar chip is the site's live switch: it reports the heartbeat and
   * toggles monitoring with the same click, so the control that lives "at the
   * top of the site" is the real one and the section below owns the details.
   */
  function renderChip() {
    const chip = el('pulseBtn');
    const s = statusOf();
    if (chip) {
      chip.className = 'pulse-chip ' + s.cls;
      chip.setAttribute('aria-checked', cfg.enabled && cfg.token ? 'true' : 'false');
      chip.title = (cfg.enabled && cfg.token ? 'پایش شبانه‌روزی روشن است' : 'پایش شبانه‌روزی خاموش است') +
        ' — هر ' + fa(api.intervalSec) + ' ثانیه و مستقل از این صفحه. برای روشن/خاموش‌کردن کلیک کنید.';
    }
    const label = el('pulseLabel'), age = el('pulseAge');
    if (label) label.textContent = s.label;
    if (age) age.textContent = s.age;

    const cycle = el('liveCycle');
    if (cycle) cycle.textContent = ready() ? fa(api.intervalSec) + ' ثانیه' : '—';
  }

  const PLAN_STATE = {
    watching: { cls: 'up', label: 'در حال پایش', note: 'قیمت معتبر رسید و هیچ شرط خروجی محقق نشده است.' },
    pending: { cls: 'late', label: 'هشدار باز — اجرای کاغذی در انتظارِ تیک', note: 'شرط خروج محقق شده و ثبتِ کاغذیِ آن به تیکِ بعدی سپرده شده است.' },
    'no-quote': { cls: 'down', label: 'بدون قیمت معتبر', note: 'تا رسیدن قیمت مستقل و تازه، هیچ ارزیابی و اجرایی انجام نمی‌شود.' },
    simulation: { cls: 'off', label: 'آزمایشی', note: 'فقط در مرورگر ارزیابی می‌شود؛ سرور برای دادهٔ شبیه‌سازی منبع قیمت ندارد.' },
    invalid: { cls: 'down', label: 'نامعتبر', note: 'ساختار ذخیره‌شده با قواعد سازگار نیست؛ پایش نمی‌شود.' },
    closed: { cls: 'off', label: 'بسته‌شده', note: 'خروج ثبت شده است.' },
    cancelled: { cls: 'off', label: 'متوقف‌شده', note: 'پایش به‌دستِ کاربر متوقف شده و فروشی ثبت نشده است.' }
  };
  const QUOTE_PROBLEM = {
    missing: 'قیمت در دسترس نیست', stale: 'داده کهنه است', error: 'دریافت قیمت ناموفق بود',
    invalid: 'قیمت یا زمان داده نامعتبر است', source: 'منبع داده با طرح سازگار نیست',
    future: 'زمان داده در آینده است', 'before-entry': 'منتظر قیمت جدیدتر از زمان ورود',
    'out-of-order': 'داده قدیمی‌تر از مشاهدهٔ قبلی', 'invalid-plan': 'طرح ذخیره‌شده نامعتبر است',
    'invalid-time': 'ساعت پایش نامعتبر است'
  };

  const SHELL = `
    <div class="live-panels">
      <section class="panel live-panel" id="lvControl">
        <div class="panel-head"><h3>کنترلِ پایش</h3>
          <span class="hint">روشن/خاموش‌کردنِ پایشِ سرور و انتخاب منبع دادهٔ ترمینال</span></div>
        <div class="live-body">
          <div class="live-row">
            <div><b>پایش شبانه‌روزی سرور</b>
              <span class="live-note">سرور مستقل از این صفحه طرح‌ها و هشدارها را می‌سنجد و اجرای کاغذی را ثبت می‌کند.</span></div>
            <button class="live-switch" id="lvEnabledSwitch" role="switch" aria-checked="false">
              <i class="knob"></i><span id="lvEnabledLabel">خاموش</span>
            </button>
          </div>
          <div class="live-row">
            <div><b>منبع دادهٔ ترمینال</b>
              <span class="live-note">«شبیه‌سازی اجباری» هیچ درخواستی به CoinGecko نمی‌فرستد؛ برای کارِ آفلاین یا نمایشی.</span></div>
            <div class="live-seg" id="lvDataMode">
              <button class="tool" data-data-mode="auto">خودکار (زنده)</button>
              <button class="tool" data-data-mode="simulation">شبیه‌سازی اجباری</button>
            </div>
          </div>
          <div class="cluster" id="lvActions">
            <button class="tool" id="lvSync">همگام‌سازی و ضربان</button>
            <button class="tool" id="lvTick">اجرای یک تیک (تست)</button>
            <button class="tool" id="lvPush">اعلان فشاری</button>
            <button class="tool" id="lvPushOff">قطع اعلان</button>
            <button class="tool" id="lvLocal">اعلان آزمایشی محلی</button>
          </div>
          <p class="live-hint" id="lvSaved"></p>
        </div>
      </section>

      <section class="panel live-panel" id="lvStatus">
        <div class="panel-head"><h3>وضعیتِ موتورِ پایش</h3>
          <span class="hint">هر تیک، طرح‌های حفاظتی و هشدارها را روی دادهٔ مستقل ارزیابی می‌کند</span></div>
        <div class="ov" id="lvStatusGrid"></div>
        <div id="lvStatusNotes"></div>
      </section>

      <section class="panel live-panel wide" id="lvWhy">
        <div class="panel-head"><h3>چرا اجرای کاغذی رخ می‌دهد یا نمی‌دهد</h3>
          <span class="hint">وضعیتِ هر طرح از دیدِ سرور، بعد از آخرین تیک</span></div>
        <div id="lvWhyBody"></div>
      </section>

      <section class="panel live-panel wide" id="lvSettings">
        <div class="panel-head"><h3>تنظیمات اتصال</h3>
          <span class="hint">توکن در مرورگر شما و فقط برای همین دستگاه ذخیره می‌شود</span></div>
        <div class="live-body">
          <div class="protect-fields">
            <label>توکنِ پایش (RADAR_TOKEN)
              <input id="lvToken" type="password" value="${esc(cfg.token)}" placeholder="••••" autocomplete="off">
            </label>
            <label>فضای نام
              <input id="lvSpace" type="text" value="${esc(cfg.space)}" placeholder="default">
            </label>
          </div>
          <div class="cluster"><button class="tool on" id="lvSave">ذخیرهٔ تنظیمات</button>
            <span class="hint" id="lvSaveNote"></span></div>
          <p class="protect-notice">
            این توکن همان <code>RADAR_TOKEN</code> است که در متغیرهای محیطیِ ورسل تنظیم می‌کنید.
            بدون آن، سرور برای جلوگیری از افشایِ وضعیتِ پایش پاسخ نمی‌دهد.
          </p>
        </div>
      </section>

      <section class="panel live-panel wide" id="lvLedgerPanel">
        <div class="panel-head"><h3>دفترچهٔ اجرای کاغذی</h3>
          <span class="hint" id="lvLedgerCount"></span></div>
        <div class="live-tablewrap" id="lvLedgerBody"></div>
        <div class="panel-foot">قیمتِ اجرا برای حد ضررها پایین‌تر از قیمتِ مشاهده‌شده (لغزشِ بدبینانه) و برای اهداف، برابرِ خودِ هدف در نظر گرفته شده است. هیچ سفارشی به صرافی ارسال نمی‌شود.</div>
      </section>
    </div>`;

  function ensureShell() {
    const host = el('liveRoot');
    if (!host) return null;
    if (el('lvControl')) return host;
    host.innerHTML = SHELL;
    bind();
    return host;
  }

  function row(label, value, sub, cls) {
    return `<div class="ov-cell ${cls || ''}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
  }

  function renderControl() {
    const box = el('lvEnabledSwitch');
    if (box) {
      const on = !!cfg.enabled && !!cfg.token;
      box.classList.toggle('on', on);
      box.setAttribute('aria-checked', on ? 'true' : 'false');
      const label = el('lvEnabledLabel');
      if (label) label.textContent = on ? 'روشن' : (cfg.enabled ? 'بدون توکن' : 'خاموش');
    }
    const mode = el('lvDataMode');
    if (mode) {
      const current = dataMode();
      for (const button of mode.querySelectorAll('[data-data-mode]')) {
        button.classList.toggle('on', button.dataset.dataMode === current);
      }
    }
    const push = el('lvPush');
    if (push) {
      const subs = (api.state && api.state.subscriptionCount) || 0;
      push.textContent = subs ? 'بررسی/تمدید اعلان فشاری (' + fa(subs) + ')' : 'فعال‌سازی اعلان فشاری';
    }
  }

  function renderStatus() {
    const grid = el('lvStatusGrid');
    if (!grid) return;
    const pulse = api.state && api.state.pulse;
    const summary = (pulse && pulse.lastSummary) || {};
    const s = statusOf();
    const subs = (api.state && api.state.subscriptionCount) || 0;
    const dueAt = nextDueAt();
    const next = dueAt ? (dueAt > Date.now() ? ageText(dueAt - Date.now()) + ' دیگر' : 'همین حالا') : '—';
    const beat = api.lastBeat;

    grid.innerHTML = [
      row('وضعیت', esc(s.label), s.age, s.cls === 'live' ? 'accent' : ''),
      row('آخرین تیک', esc(pulse && pulse.lastRun ? when(pulse.lastRun) : '—'),
        pulse && pulse.lastRun ? ageText(Date.now() - pulse.lastRun) + ' پیش' : 'بدون تیک'),
      row('تیکِ بعدی', esc(next), 'چرخهٔ ' + fa(api.intervalSec) + ' ثانیه'),
      row('تعداد تیک‌ها', esc(fa((pulse && pulse.ticks) || 0)),
        beat ? 'آخرین پاسخِ ضربان: ' + (beat.ok ? (beat.skipped ? 'نوبت نبود' : 'اجرا شد') : 'خطا') : '—'),
      row('طرح‌های روی سرور', esc(fa(summary.positions == null ? '—' : summary.positions)),
        'ارزیابی‌شده: ' + esc(fa(summary.evaluated || 0))),
      row('قیمت‌های تازه', esc(fa(summary.quotes == null ? '—' : summary.quotes)),
        'از ' + esc(fa(summary.quoteAttempts || 0)) + ' درخواست'),
      row('اجرای کاغذی', esc(pulse && pulse.autoExec === false ? 'خاموش' : 'فعال'),
        'آخرین تیک: ' + esc(fa(summary.fills || 0)) + ' ثبت'),
      row('دستگاه‌های اعلان', esc(fa(subs)), api.pushKey ? 'کلید سرور آماده است' : 'کلید VAPID تنظیم نشده'),
      row('انبارِ وضعیت', esc((api.state && api.state.store) || '—'),
        ready() ? 'متصل' : (!cfg.token ? 'بدون توکن' : 'پایش خاموش')),
      row('همگام‌سازی', esc(api.lastSyncAt ? ageText(Date.now() - api.lastSyncAt) + ' پیش' : '—'),
        api.lastError ? 'خطا' : 'بدون خطا')
    ].join('');

    const notes = el('lvStatusNotes');
    if (notes) {
      const items = [];
      if (!cfg.token) {
        items.push('<div class="protect-error">توکنِ پایش ذخیره نشده است؛ سرور هیچ چیزی از پرتفوی شما نمی‌داند و هیچ طرحی را نمی‌سنجد. توکن را در «تنظیمات اتصال» وارد کنید.</div>');
      } else if (!cfg.enabled) {
        items.push('<div class="protect-error">پایشِ سرور خاموش است. با کلید «پایش شبانه‌روزی سرور» در همین بخش روشنش کنید.</div>');
      }
      if (api.lastError) items.push(`<div class="protect-error">خطای همگام‌سازی: ${esc(api.lastError)}</div>`);
      if (beat && beat.error) items.push(`<div class="protect-error">خطای ضربان: ${esc(beat.error)}</div>`);
      if (pulse && pulse.lastError) {
        items.push(`<div class="protect-error">خطای آخرین تیک سرور: ${esc(String(pulse.lastError.detail || '').slice(0, 200))}</div>`);
      }
      notes.innerHTML = items.join('');
    }
  }

  function renderWhy() {
    const host = el('lvWhyBody');
    if (!host) return;
    const pulse = api.state && api.state.pulse;
    const summary = (pulse && pulse.lastSummary) || {};
    if (!ready() || !pulse || !pulse.lastRun) {
      const why = !cfg.token
        ? 'توکنِ پایش ذخیره نشده است، پس سرور هیچ چیزی از پرتفوی شما نمی‌داند. توکن را در «تنظیمات اتصال» وارد کنید.'
        : !cfg.enabled
          ? 'پایشِ سرور خاموش است. با کلید «پایش شبانه‌روزی سرور» روشنش کنید تا هر ۹۰ ثانیه یک تیک بخورد.'
          : 'هنوز تیکی از سرور ثبت نشده است. کلید «همگام‌سازی و ضربان» یک چرخه را همین حالا درخواست می‌کند.';
      host.innerHTML = `<div class="empty">${esc(why)}</div>`;
      return;
    }
    const states = Array.isArray(summary.planStates) ? summary.planStates : [];
    const problems = Array.isArray(summary.problemList) ? summary.problemList : [];
    const counts = { fills: fa(summary.fills || 0), adopted: fa(summary.adopted || 0), signals: fa(summary.signals || 0) };

    const table = states.length ? `<div class="live-tablewrap"><table class="table"><thead><tr>
        <th>دارایی</th><th>حالت</th><th>حد ضرر فعال</th><th>توضیح</th></tr></thead><tbody>` +
      states.map(p => {
        const info = PLAN_STATE[p.state] || { cls: 'off', label: p.state, note: '' };
        const autoOff = pulse.autoExec === false;
        const detail = p.state === 'no-quote' ? (QUOTE_PROBLEM[p.problem] || p.problem || '')
          : (autoOff && p.state === 'pending'
            ? 'اجرای خودکارِ کاغذی خاموش است (PAPER_AUTO_EXEC=false)؛ این هشدار تا روشن‌کردنِ آن در دفترچه ثبت نمی‌شود.'
            : info.note);
        return `<tr>
          <td>${esc(p.symbol)} <span class="live-mode">${esc(p.mode === 'simulation' ? 'آزمایشی' : 'واقعی')}</span></td>
          <td><i class="live-dot ${esc(info.cls)}"></i>${esc(info.label)}</td>
          <td class="num">${esc(price(p.stop))}</td>
          <td>${esc(detail)}${p.state === 'pending' && p.since ? ' — از ' + esc(when(p.since)) : ''}</td>
        </tr>`;
      }).join('') + '</tbody></table></div>' : '<div class="empty">هیچ طرح حفاظتی روی سرور نیست؛ تا وقتی طرحی ثبت و همگام نشود، چیزی برای اجرای کاغذی وجود ندارد.</div>';

    const problemList = problems.length ? `<div class="live-problems"><b>مشکلاتِ آخرین تیک</b><ul>` +
      problems.map(p => `<li><span class="num">${esc(p.coinId || '—')}</span> — ${esc(p.kind || '')} — ${esc(QUOTE_PROBLEM[p.detail] || p.detail || '')}</li>`).join('') +
      '</ul></div>' : '';

    host.innerHTML = `
      <div class="live-tally">
        <span>آخرین تیک: <b class="num">${esc(fa(summary.fills || 0))}</b> اجرای کاغذی</span>
        <span>هشدارِ نو: <b class="num">${esc(counts.signals)}</b></span>
        <span>اجرای به‌جامانده که ثبت شد: <b class="num">${esc(counts.adopted)}</b></span>
        <span>کل دفترچه: <b class="num">${esc(fa(((api.state && api.state.ledger) || []).length))}</b></span>
      </div>
      ${table}
      ${problemList}
      <p class="live-hint">اجرای کاغذیِ خودکار در تیکِ سرور ثبت می‌شود. اگر صفحه باز باشد و همان شرط را زودتر ببیند، آن را «هشدارِ باز» علامت می‌زند؛ تیکِ بعدی همان هشدار را برمی‌دارد و اجرا را در دفترچه ثبت می‌کند — پس هیچ هشداری بی‌اجرا نمی‌ماند.</p>`;
  }

  function ledgerRows(ledger) {
    if (!ledger || !ledger.length) {
      return '<div class="empty">هنوز اجرای کاغذی ثبت نشده است.</div>';
    }
    return `<table class="table"><thead><tr>
      <th>زمان</th><th>دارایی</th><th>دلیل</th><th>تعداد</th><th>قیمتِ مشاهده‌شده</th>
      <th>قیمتِ اجرا</th><th>سود/زیان ناخالص</th><th>مبنا</th></tr></thead><tbody>` +
      ledger.slice().reverse().slice(0, 60).map(f => `<tr>
        <td class="num">${esc(when(f.at))}</td>
        <td>${esc(f.symbol || f.coinId)}</td>
        <td>${esc(f.reason)}</td>
        <td class="num">${esc(nf.format(Number(f.quantity)))}</td>
        <td class="num">${esc(price(f.observedPrice))}</td>
        <td class="num">${esc(price(f.price))}</td>
        <td class="num ${Number(f.grossPnl) >= 0 ? 'up' : 'down'}">${esc(price(f.grossPnl))}</td>
        <td>${f.adopted
          ? 'هشدارِ ثبت‌شده' + (f.signalAt ? ' · ' + esc(when(f.signalAt)) : '')
          : 'تیکِ سرور'}</td>
      </tr>`).join('') + '</tbody></table>';
  }

  function renderLedger() {
    const body = el('lvLedgerBody');
    if (body) body.innerHTML = ledgerRows((api.state && api.state.ledger) || []);
    const count = el('lvLedgerCount');
    if (count) {
      const fills = ((api.state && api.state.ledger) || []).length;
      count.textContent = fa(fills) + ' ثبت — شبیه‌سازی، بدون سفارش واقعی';
    }
  }

  function renderSettings() {
    // Never rebuild the inputs while they are being typed into: render() runs
    // on every sync, and losing the caret mid-token is maddening.
    const active = document.activeElement;
    if (active && (active.id === 'lvToken' || active.id === 'lvSpace')) return;
    const token = el('lvToken'), space = el('lvSpace');
    if (token && token.value !== cfg.token) token.value = cfg.token;
    if (space && space.value !== cfg.space) space.value = cfg.space;
  }

  function render() {
    const host = ensureShell();
    if (!host) return;
    bind();
    renderChip();
    renderControl();
    renderStatus();
    renderWhy();
    renderLedger();
    renderSettings();
  }

  function flash(message, bad) {
    const node = el('lvSaved');
    if (node) {
      node.textContent = message;
      node.style.color = bad ? 'var(--down)' : 'var(--up)';
    }
  }

  /* ---------- events ---------- */

  /**
   * Handlers are (re)assigned on every render: property assignment is
   * idempotent, and it also survives this module being re-evaluated (which is
   * exactly what a page reload does to the stored config).
   */
  function bind() {
    const on = (id, fn) => { const node = el(id); if (node) node.onclick = fn; };
    const guard = fn => async () => {
      try { await fn(); } catch (error) { flash(String(error && error.message || error), true); }
    };

    // One switch, one implementation: the section's knob and the topbar chip
    // both go through toggleMonitoring (confirm on the way down, the token
    // field on the way up).
    on('lvEnabledSwitch', guard(toggleMonitoring));

    on('lvSync', guard(async () => {
      await sync('manual', { beat: 'force' });
      const beat = api.lastBeat;
      flash(beat && beat.ok
        ? (beat.skipped ? 'تیک لازم نبود؛ سرور همین حالا به‌روز است.' : 'ضربان اجرا شد — ' + fa(beat.fills) + ' اجرای کاغذی در این چرخه.')
        : 'همگام‌سازی انجام شد' + (beat && beat.error ? ' — ضربان ناموفق: ' + beat.error : ''));
    }));

    on('lvTick', guard(async () => {
      const result = await forceTick();
      flash('تیک اجرا شد — ' + fa(result.fills) + ' اجرای کاغذی، ' + fa(result.signals) + ' هشدار.');
    }));

    on('lvPush', guard(async () => {
      await enablePush(true);
      await sync('push');
      flash('اعلان فشاری فعال شد');
    }));

    on('lvPushOff', guard(async () => {
      await disablePush();
      await sync('push-off');
      flash('اعلان فشاری قطع شد');
    }));

    on('lvLocal', () => showLocal('رادارِ بازار',
      'این یک اعلان آزمایشیِ محلی است — مسیرِ اعلانِ سیستم سالم است.'));

    on('lvSave', guard(async () => {
      cfg.token = (el('lvToken').value || '').trim();
      cfg.space = (el('lvSpace').value || '').trim() || 'default';
      save();
      if (!cfg.enabled) {
        // A stored token is not the same thing as a running monitor: say which
        // switch is still off instead of leaving the panel looking enabled.
        render();
        flash('توکن ذخیره شد — برای شروعِ پایش، کلیدِ «پایش شبانه‌روزی سرور» را روشن کنید.', false);
        return;
      }
      await sync('settings');
      render();
      flash('تنظیمات ذخیره شد' + (api.lastError ? ' — اما همگام‌سازی ناموفق بود' : ''), !!api.lastError);
    }));

    const modes = el('lvDataMode');
    if (modes && modes.dataset.bound !== '1') {
      modes.dataset.bound = '1';
      modes.addEventListener('click', event => {
        const button = event.target.closest('[data-data-mode]');
        if (button) setDataMode(button.dataset.dataMode);
      });
    }

    on('pulseBtn', guard(async () => {
      await toggleMonitoring();
    }));
  }

  /** Scroll to the monitoring section and draw attention to the control panel. */
  function openSection() {
    const host = el('liveRoot');
    if (!host) return;
    const section = el('secLive') || host;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const control = el('lvControl');
    if (control) {
      control.classList.add('live-flash');
      setTimeout(() => control.classList.remove('live-flash'), 1600);
    }
  }

  /* ---------- lifecycle ---------- */

  let timer = null;

  function start() {
    if (timer) clearInterval(timer);
    // Sync twice per server cycle: often enough to feel live, rare enough to
    // stay well inside the function-invocation budget.
    timer = setInterval(() => { if (!document.hidden) sync('timer'); }, 45000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sync('visible');
    });
    if (ready()) sync('start');
    else render();
  }

  root.RadarLive = {
    start, render, sync, forceTick, beat, enablePush, disablePush,
    setEnabled, toggleMonitoring, setDataMode, openSection,
    get dataMode() { return dataMode(); },
    get config() { return { ...cfg }; },
    get status() { return statusOf(); },
    get lastBeat() { return api.lastBeat; },
    get server() { return api.state; },
    /** Called by the terminal after every data refresh. */
    onTick() { if (ready()) pushUp().catch(() => {}).then(render); else renderChip(); },
    /** Called after a local portfolio/alert edit. */
    onLocalChange() { if (ready()) pushUp().catch(() => {}).then(render); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
