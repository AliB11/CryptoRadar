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
 *   - adopts the server's copy when a tick has moved ahead (a paper fill that
 *     happened overnight must not be overwritten from a stale tab)
 *   - renders the "پایش شبانه‌روزی" panel and the topbar heartbeat chip
 *
 * Nothing here places an order. Everything the server books is paper.
 */
(function (root) {
  const CFG_KEY = 'radar_live';
  const PUSH_FLAG = 'radar_live_push';

  const el = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 10 });
  const price = v => (v == null || !isFinite(Number(v)) ? '—' : '$' + nf.format(Number(v)));
  const when = v => (v ? new Date(v).toLocaleString('fa-IR') : '—');

  const cfg = Object.assign({ token: '', space: 'default', enabled: false }, read());

  function read() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function save() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
    if (typeof root.RadarTerminal !== 'undefined') { /* keep the handle authoritative */ }
  }

  const api = {
    bootstrapped: false,
    serverVersion: null,
    state: { version: 0, portfolio: [], alerts: [], ledger: [], pulse: null, subscriptionCount: 0 },
    pushKey: null,
    intervalSec: 90,
    lastError: null,
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

  function applyServer(data) {
    const t = term();
    if (!t || !t.sync) return;
    if (Array.isArray(data.portfolio) && data.portfolio.length !== undefined) {
      t.sync.applyPortfolio(data.portfolio);
    }
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
      if (hasContent) applyServer(data);
    } else if (serverVersion > Number(api.serverVersion || 0)) {
      // Afterwards the server wins whenever it moved on: a tick may have
      // booked a paper fill while this tab was closed.
      api.serverVersion = serverVersion;
      applyServer(data);
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
        if (error.body.portfolio || error.body.alerts) applyServer(error.body);
        api.serverVersion = Number(error.body.version);
        throw error;
      }
      throw error;
    }
  }

  async function sync(reason) {
    if (!ready() || api.busy) return null;
    api.busy = true;
    try {
      await pull();
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
    const res = await fetch('/api/pulse?force=1&space=' + encodeURIComponent(cfg.space), {
      headers: { 'x-radar-token': cfg.token }, cache: 'no-store'
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && (body.detail || body.error)) || 'HTTP ' + res.status);
    await pull();
    render();
    return body;
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
    if (!ready()) return { cls: 'off', label: 'پایش سرور: غیرفعال', age: '—' };
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

  function renderChip() {
    const chip = el('pulseBtn');
    if (!chip) return;
    const s = statusOf();
    chip.className = 'pulse-chip ' + s.cls;
    const label = el('pulseLabel'), age = el('pulseAge');
    if (label) label.textContent = s.label;
    if (age) age.textContent = s.age;
    chip.title = 'پایش شبانه‌روزی — هر ' + fa(api.intervalSec) + ' ثانیه، مستقل از این صفحه';
  }

  function ledgerRows(ledger) {
    if (!ledger || !ledger.length) {
      return '<div class="empty" style="padding:18px">هنوز اجرای کاغذی ثبت نشده است.</div>';
    }
    return `<table class="table"><thead><tr>
      <th>زمان</th><th>دارایی</th><th>دلیل</th><th>تعداد</th><th>قیمتِ مشاهده‌شده</th>
      <th>قیمتِ اجرا</th><th>سود/زیان ناخالص</th></tr></thead><tbody>` +
      ledger.slice().reverse().slice(0, 60).map(f => `<tr>
        <td class="num">${esc(when(f.at))}</td>
        <td>${esc(f.symbol || f.coinId)}</td>
        <td>${esc(f.reason)}</td>
        <td class="num">${esc(nf.format(Number(f.quantity)))}</td>
        <td class="num">${esc(price(f.observedPrice))}</td>
        <td class="num">${esc(price(f.price))}</td>
        <td class="num ${Number(f.grossPnl) >= 0 ? 'up' : 'down'}">${esc(price(f.grossPnl))}</td>
      </tr>`).join('') + '</tbody></table>';
  }

  function render() {
    const host = el('liveRoot');
    renderChip();
    const cycle = el('liveCycle');
    if (cycle) cycle.textContent = ready() ? fa(api.intervalSec) + ' ثانیه' : '—';
    if (!host) return;

    const s = statusOf();
    const pulse = api.state && api.state.pulse;
    const subs = api.state ? api.state.subscriptionCount : 0;
    const fills = (api.state && api.state.ledger) || [];

    host.innerHTML = `
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head">
          <h3>وضعیتِ موتورِ پایش</h3>
          <span class="hint">هر تیک، طرح‌های حفاظتی و هشدارها را روی دادهٔ مستقل ارزیابی می‌کند</span>
        </div>
        <div class="ov" style="margin:0;border-radius:0;border-inline:0">
          <div class="ov-cell"><span>وضعیت</span><b>${esc(s.label)}</b><em>${esc(s.age)}</em></div>
          <div class="ov-cell"><span>آخرین تیک</span><b>${esc(pulse && pulse.lastRun ? when(pulse.lastRun) : '—')}</b><em>${esc(pulse && pulse.lastRun ? ageText(Date.now() - pulse.lastRun) + ' پیش' : '—')}</em></div>
          <div class="ov-cell"><span>تعداد تیک‌ها</span><b>${esc(fa(pulse && pulse.ticks || 0))}</b><em>چرخهٔ ${esc(fa(api.intervalSec))} ثانیه</em></div>
          <div class="ov-cell"><span>دستگاه‌های اعلان</span><b>${esc(fa(subs))}</b><em>${api.pushKey ? 'کلید سرور آماده است' : 'کلید VAPID تنظیم نشده'}</em></div>
          <div class="ov-cell"><span>انبارِ وضعیت</span><b>${esc(api.state && api.state.store || '—')}</b><em>${esc(ready() ? 'متصل' : 'بدون توکن')}</em></div>
          <div class="ov-cell"><span>اجرای کاغذی</span><b>${esc(pulse && pulse.autoExec === false ? 'خاموش' : 'فعال')}</b><em>سفارش واقعی ارسال نمی‌شود</em></div>
        </div>
        ${api.lastError ? `<div class="protect-error" style="margin:12px 16px">${esc(api.lastError)}</div>` : ''}
        ${(pulse && pulse.lastError) ? `<div class="protect-error" style="margin:12px 16px">خطای آخرین تیک سرور: ${esc(String(pulse.lastError.detail || '').slice(0, 160))}</div>` : ''}
        <div class="cluster" style="padding:0 16px 16px">
          <button class="tool" id="lvSync">همگام‌سازی الآن</button>
          <button class="tool" id="lvTick">اجرای یک تیک (تست)</button>
          <button class="tool" id="lvPush">${subs ? 'بررسی/تمدید اعلان فشاری' : 'فعال‌سازی اعلان فشاری'}</button>
          <button class="tool" id="lvPushOff">قطع اعلان</button>
          <button class="tool" id="lvLocal">اعلان آزمایشی محلی</button>
        </div>
      </div>

      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h3>تنظیمات اتصال</h3>
          <span class="hint">توکن در مرورگر شما و فقط برای همین دستگاه ذخیره می‌شود</span></div>
        <div style="padding:16px">
          <div class="protect-fields">
            <label>توکنِ پایش (RADAR_TOKEN)
              <input id="lvToken" type="password" value="${esc(cfg.token)}" placeholder="••••" autocomplete="off">
            </label>
            <label>فضای نام
              <input id="lvSpace" type="text" value="${esc(cfg.space)}" placeholder="default">
            </label>
            <label>وضعیت
              <select id="lvEnabled">
                <option value="1" ${cfg.enabled ? 'selected' : ''}>فعال</option>
                <option value="0" ${!cfg.enabled ? 'selected' : ''}>غیرفعال</option>
              </select>
            </label>
          </div>
          <div class="cluster"><button class="tool on" id="lvSave">ذخیرهٔ تنظیمات</button>
            <span class="hint" id="lvSaved"></span></div>
          <p class="protect-notice" style="margin-top:12px">
            این توکن همان <code>RADAR_TOKEN</code> است که در متغیرهای محیطیِ ورسل تنظیم می‌کنید.
            بدون آن، سرور برای جلوگیری از افشایِ وضعیتِ پایش پاسخ نمی‌دهد.
          </p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>دفترچهٔ اجرای کاغذی</h3>
          <span class="hint">${esc(fa(fills.length))} ثبت — شبیه‌سازی، بدون سفارش واقعی</span></div>
        <div style="overflow-x:auto">${ledgerRows(fills)}</div>
        <div class="panel-foot">قیمتِ اجرا برای حد ضررها پایین‌تر از قیمتِ مشاهده‌شده (لغزشِ بدبینانه) و برای اهداف، برابرِ خودِ هدف در نظر گرفته شده است.</div>
      </div>`;

    bind();
  }

  function bind() {
    const on = (id, fn) => { const b = el(id); if (b) b.onclick = fn; };
    on('lvSync', () => { sync('manual'); });
    on('lvTick', async () => {
      try { await forceTick(); flash('یک تیک با موفقیت اجرا شد'); }
      catch (e) { flash(String(e.message || e), true); }
    });
    on('lvPush', async () => {
      try { await enablePush(true); await sync('push'); flash('اعلان فشاری فعال شد'); }
      catch (e) { flash(String(e.message || e), true); }
    });
    on('lvPushOff', async () => {
      try { await disablePush(); await sync('push-off'); flash('اعلان فشاری قطع شد'); }
      catch (e) { flash(String(e.message || e), true); }
    });
    on('lvLocal', () => showLocal('رادارِ بازار',
      'این یک اعلان آزمایشیِ محلی است — مسیرِ اعلانِ سیستم سالم است.'));
    on('lvSave', async () => {
      cfg.token = (el('lvToken').value || '').trim();
      cfg.space = (el('lvSpace').value || '').trim() || 'default';
      cfg.enabled = el('lvEnabled').value === '1';
      save();
      await sync('settings');
      flash('تنظیمات ذخیره شد' + (api.lastError ? ' — اما همگام‌سازی ناموفق بود' : ''), !!api.lastError);
    });
  }

  function flash(message, bad) {
    const node = el('lvSaved');
    if (node) { node.textContent = message; node.style.color = bad ? 'var(--down)' : 'var(--up)'; }
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
    start, render, sync, forceTick, enablePush, disablePush,
    get config() { return { ...cfg }; },
    get status() { return statusOf(); },
    get server() { return api.state; },
    /** Called by the terminal after every data refresh. */
    onTick() { if (ready()) { pushUp().catch(() => {}); renderChip(); } },
    /** Called after a local portfolio/alert edit. */
    onLocalChange() { if (ready()) pushUp().catch(() => {}); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
