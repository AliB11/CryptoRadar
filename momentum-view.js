/* Momentum watchlist UI. Rendering never writes an order or a market-buy instruction. */
(function (root) {
  'use strict';
  const Engine = root.RadarMomentum;
  const KEY = 'radar_mom_pins';
  const STALE_MS = 15 * 60 * 1000;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const num = value => `<span class="num">${esc(value)}</span>`;
  const usd = value => {
    if (!Number.isFinite(value)) return '—';
    const a = Math.abs(value);
    const body = a >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (value / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : value.toFixed(0);
    return '$' + body;
  };
  const px = value => {
    if (!(value > 0) || !Number.isFinite(value)) return '—';
    if (value >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (value >= 1) return '$' + value.toFixed(4);
    if (value >= 0.0001) return '$' + value.toFixed(6);
    return '$' + value.toExponential(2);
  };
  const pct = value => (value > 0 ? '+' : '') + Number(value).toFixed(2) + '%';
  const smartFa = {
    accumulation: 'پروکسی ساختاری انباشت — نه inflow کیف‌پول',
    distribution: 'ساختار توزیع در سقف — نه فروش قطعی نهنگ',
    unavailable: 'پول هوشمند تأیید نشد'
  };
  let host, options, lastCtx, showFomo = false, known = new Set();

  function readPins() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(p => p && typeof p.symbol === 'string' && /^[A-Za-z0-9.\-]{1,20}$/.test(p.symbol) &&
        ['approve', 'reject-fomo', 'reject-filter'].includes(p.verdict) &&
        ['low', 'medium', 'high', 'exit'].includes(p.risk) &&
        Number.isFinite(p.at) && Number.isFinite(p.price) && p.price > 0).slice(0, 30);
    } catch (e) { return []; }
  }
  function writePins(rows) {
    try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 30))); } catch (e) {}
  }
  function paintIcons() { if (options && options.icons) options.icons(); }

  function shell() {
    const t = Engine.THRESHOLDS;
    host.innerHTML = `
      <div class="mom">
        <div class="mom-notice">خروجی این غربال <b>توصیهٔ خرید یا سفارش نیست</b>. تأیید واچ‌لیست یعنی نامزد دیده‌بانی برای پولبک، نه ورود مارکت در سقف. حد ضرر و اهداف فقط برنامهٔ ریسک‌اند؛ اجرای قیمت تضمین نمی‌شود.</div>
        <details class="mom-why">
          <summary>چرا این غربال از جدول سیگنال جداست؟</summary>
          <p>امتیاز خرید ترمینال برای بازگشت به میانگین ساخته شده و RSI بالای ۷۰ را جریمه می‌کند؛ همان قاعده، روزهای ${num(t.minChangePct + '–' + t.maxChangePct + '%')} را که این چارچوب می‌خواهد حذف می‌کرد. رشد ۲۴ساعتهٔ جدول از اسپارک‌لاین ساعتی است، نه چاپ رسمی بازار. اینجا چاپ ۲۴ساعته معیار است و اختلاف بیش از ${num(t.printMismatchPct)} واحد با مسیر ساعتی، چاپ را نامعتبر می‌کند. پروکسی داده جریان کیف‌پول نهنگ ندارد؛ انباشت فقط پروکسی ساختاری است. شاخص ترس و طمع در حکم استفاده نمی‌شود.</p>
        </details>
        <div data-mom-env></div>
        <form data-mom-form class="mom-form">
          <h3>سنجش دستی — همان قالب ورودی</h3>
          <p>نماد، قیمت، رشد ۲۴ساعته، حجم، سن پروژه و وضعیت چارت. اگر دارایی در جهان زنده باشد، محیط بیت‌کوین همان محیط ترمینال است.</p>
          <div class="mom-fields">
            <label>نماد<input name="symbol" required maxlength="20" autocomplete="off" placeholder="SOL"></label>
            <label>قیمت فعلی ($)<input name="price" required inputmode="decimal" placeholder="210"></label>
            <label>رشد ۲۴ساعته (%)<input name="ch24" required inputmode="decimal" placeholder="18"></label>
            <label>حجم ۲۴ساعته<input name="vol" required inputmode="decimal" placeholder="80"></label>
            <label>واحد حجم<select name="volUnit"><option value="1e6" selected>میلیون دلار</option><option value="1">دلار</option></select></label>
            <label>سن پروژه (روز)<input name="age" required inputmode="decimal" placeholder="120"></label>
            <label>ارزش بازار (اختیاری)<input name="mcap" inputmode="decimal" placeholder="900"></label>
            <label>واحد ارزش<select name="mcapUnit"><option value="1e6" selected>میلیون دلار</option><option value="1e9">میلیارد دلار</option></select></label>
            <label>سقف ۲۴ساعته (اختیاری)<input name="high24" inputmode="decimal" placeholder=""></label>
            <label>کف ۲۴ساعته (اختیاری)<input name="low24" inputmode="decimal" placeholder=""></label>
            <label>وضعیت چارت<select name="chartStatus">
              <option value="unknown">نامشخص</option>
              <option value="breakout">شکست</option>
              <option value="pullback">پولبک</option>
              <option value="extended">کشیده در سقف</option>
              <option value="rejection">پس‌زدن / فتیلهٔ بالایی</option>
            </select></label>
          </div>
          <label class="mom-check"><input type="checkbox" name="boosted"> در بوست یا ترند تبلیغاتی دیده شده، نه فقط جست‌وجوی ارگانیک</label>
          <div class="mom-error" data-mom-error hidden></div>
          <div class="mom-actions">
            <button class="tool on" type="submit">سنجش و ثبت حکم</button>
          </div>
        </form>
        <div data-mom-manual></div>
        <div data-mom-board></div>
        <div data-mom-pins></div>
      </div>`;
    host.querySelector('[data-mom-form]').addEventListener('submit', onSubmit);
    host.addEventListener('click', onClick);
  }

  function parseNum(value) {
    const s = String(value == null ? '' : value)
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/,/g, '').replace(/%/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    const volBase = parseNum(data.vol);
    const vol = volBase == null ? data.vol : volBase * Number(data.volUnit);
    const mcapBase = parseNum(data.mcap);
    const mcap = data.mcap === '' || mcapBase == null ? null : mcapBase * Number(data.mcapUnit);
    const row = Engine.screen({
      symbol: data.symbol, price: data.price, ch24: data.ch24, vol24: vol,
      historyDays: data.age, mcap, high24: data.high24 || null, low24: data.low24 || null,
      chartStatus: data.chartStatus, boosted: form.elements.boosted.checked,
      source: 'manual'
    }, lastCtx || { now: Date.now() });
    const err = host.querySelector('[data-mom-error]');
    if (!row.ok) { err.hidden = false; err.textContent = row.error; return; }
    err.hidden = true;
    host.querySelector('[data-mom-manual]').innerHTML = `<div class="mom-head"><h3>حکم ورودی شما</h3></div>` + card(row);
    paintIcons();
    host.querySelector('[data-mom-manual]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function onClick(event) {
    const open = event.target.closest('[data-mom-open]');
    if (open && options.openCoin) { options.openCoin(open.dataset.momOpen); return; }
    const pin = event.target.closest('[data-mom-pin]');
    if (pin) {
      const row = lastRows.get(pin.dataset.momPin);
      if (row) savePin(row);
      return;
    }
    const drop = event.target.closest('[data-mom-unpin]');
    if (drop) {
      writePins(readPins().filter(p => p.id !== drop.dataset.momUnpin));
      paintPins();
      return;
    }
    if (event.target.closest('[data-mom-more]')) {
      showFomo = !showFomo;
      paintBoard();
    }
  }

  const lastRows = new Map();
  function remember(row) {
    const id = row.symbol + ':' + row.verdict + ':' + Math.round(row.quote.price * 1e8);
    lastRows.set(id, row);
    return id;
  }
  function savePin(row) {
    const pins = readPins().filter(p => p.symbol !== row.symbol || p.verdict !== row.verdict);
    pins.unshift({
      id: row.symbol + '-' + Date.now(),
      at: Date.now(), symbol: row.symbol, name: row.name, verdict: row.verdict,
      verdictLabel: row.verdictLabel, risk: row.risk, riskLabel: row.riskLabel,
      price: row.quote.price, ch24: row.quote.ch24, vol24: row.quote.vol24,
      entry: row.plan.entry, stop: row.plan.stop, tp1: row.plan.tp1, tp2: row.plan.tp2,
      source: row.source
    });
    writePins(pins);
    paintPins();
    if (options.toast) options.toast('در واچ‌لیست محلی ثبت شد — این سفارش نیست و به‌سرعت کهنه می‌شود', 'ok');
  }

  function levels(plan) {
    return `<div class="mom-levels">
      <div><span>ورود پولبک</span><b>${num(px(plan.entry))}</b></div>
      <div><span>حد ضرر</span><b>${num(px(plan.stop))}</b></div>
      <div><span>هدف ۱ · ۱R</span><b>${num(px(plan.tp1))}</b></div>
      <div><span>هدف ۲ · ۲٫۲R</span><b>${num(px(plan.tp2))}</b></div>
    </div>`;
  }
  function filterCell(f) {
    return `<div class="mom-filter ${f.pass ? 'pass' : 'fail'}"><i>${f.pass ? 'قبول' : 'رد'}</i>${esc(f.text)}</div>`;
  }
  function card(row) {
    const id = remember(row);
    const q = row.quote;
    const cls = row.verdict === 'approve' ? 'approve' : 'fomo';
    const open = row.id && known.has(row.id) ? `<button type="button" class="tool" data-mom-open="${esc(row.id)}">تحلیل تکنیکال</button>` : '';
    return `<article class="mom-card ${cls}">
      <header><div><b>${esc(row.symbol)}</b><small>${esc(row.name)}${row.source === 'simulation' ? ' · شبیه‌سازی' : row.source === 'manual' ? ' · ورودی شما' : ''}</small></div>
        <div class="mom-pills"><span class="mom-pill ${cls}">${esc(row.verdictLabel)}</span><span class="mom-pill ${esc(row.risk)}">${esc(row.riskLabel)}</span></div></header>
      <div class="mom-quote"><span>قیمت ${num(px(q.price))}</span><span>۲۴س ${num(pct(q.ch24))}</span><span>حجم ${num(usd(q.vol24))}</span><span>سن ${q.ageDays == null ? 'نامعلوم' : num(q.ageDays.toFixed(0) + ' روز')}</span></div>
      <div class="mom-filters">
        ${filterCell(row.filters.history)}
        ${filterCell(row.filters.liquidity)}
        ${filterCell(row.filters.momentum)}
        ${filterCell(row.filters.fakeBoost)}
        ${row.filters.instrument.pass ? '' : filterCell(row.filters.instrument)}
      </div>
      ${row.reasons.filter(r => r.code === 'REJECTION' || r.code === 'BREAKOUT' || r.code === 'NO_BREAKOUT').map(r => `<p class="mom-note">${esc(r.text)}</p>`).join('')}
      <p class="mom-note">${esc(row.plan.text)}</p>
      ${levels(row.plan)}
      <p class="mom-note">${esc(row.environment.text)} ${esc(smartFa[row.structure.smartMoney] || '')}${row.structure.rsi == null ? '' : ' · RSI ساعتی ' + row.structure.rsi.toFixed(1)}</p>
      ${row.warnings.filter(w => w.code !== 'FNG_IGNORED').map(w => `<p class="mom-note warn">${esc(w.text)}</p>`).join('')}
      <div class="mom-actions">${open}<button type="button" class="tool on" data-mom-pin="${esc(id)}">ثبت در واچ‌لیست محلی</button></div>
    </article>`;
  }

  function envHtml(env, note) {
    if (!env) return '';
    const stance = { supportive: 'حمایتی', hostile: 'خصمانه', neutral: 'خنثی', unknown: 'نامشخص' }[env.stance] || env.stance;
    return `<div class="mom-env">
      <div class="mom-stat"><span>جهت بیت‌کوین</span><b>${env.btcCh24 == null ? '—' : num(pct(env.btcCh24))}</b></div>
      <div class="mom-stat"><span>امتیاز لنگر</span><b>${env.btcScore == null ? '—' : num((env.btcScore > 0 ? '+' : '') + Math.round(env.btcScore))}</b></div>
      <div class="mom-stat"><span>دامیننس</span><b>${env.dominance == null ? '—' : num(env.dominance.toFixed(1) + '%')}</b></div>
      <div class="mom-stat"><span>محیط آلت</span><b>${esc(stance)}</b></div>
      <p>${esc(env.text)} ${esc(note || '')}</p>
    </div>`;
  }

  function paintBoard() {
    const slot = host.querySelector('[data-mom-board]');
    if (!slot || !lastBoard) return;
    const b = lastBoard;
    const c = b.counts;
    const approved = b.approved.slice(0, 24).map(row => card(row)).join('');
    const fomoRows = b.fomo.slice(0, showFomo ? 24 : 6);
    const fomo = fomoRows.map(row => card(row)).join('');
    const misses = b.nearMisses.length ? `<div class="mom-head"><h3>نزدیک‌ترین ردهای فیلتر سخت</h3><span>فومو نیستند؛ فقط معیار را رد کرده‌اند</span></div>
      <div class="mom-card"><table class="mom-table"><thead><tr><th>نماد</th><th>۲۴س</th><th>حجم</th><th>علت اصلی</th></tr></thead><tbody>
      ${b.nearMisses.map(r => `<tr><td>${esc(r.symbol)}</td><td class="num">${esc(pct(r.quote.ch24))}</td><td class="num">${esc(usd(r.quote.vol24))}</td><td>${esc(firstFail(r))}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    slot.innerHTML = `
      <div class="mom-counts">
        <span class="mom-count">بررسی‌شده <b>${c.scanned}</b></span>
        <span class="mom-count">واچ‌لیست <b>${c.approved}</b></span>
        <span class="mom-count">رد فومو <b>${c.fomo}</b></span>
        <span class="mom-count">رد فیلتر <b>${c.filter}</b></span>
        <span class="mom-count">حجم ناکافی <b>${c.failLiquidity}</b></span>
        <span class="mom-count">سن ناکافی <b>${c.failHistory}</b></span>
        <span class="mom-count">خارج از ۱۰–۵۰ <b>${c.failMomentum}</b></span>
        <span class="mom-count">بوست جعلی <b>${c.failBoost}</b></span>
      </div>
      <div class="mom-head"><h3>واچ‌لیست این دور</h3><span>${esc(lastNote || '')}</span></div>
      ${approved ? `<div class="mom-grid">${approved}</div>` : `<div class="mom-empty">این دور نامزدی برای واچ‌لیست نماند. یا فیلتر سخت رد شده، یا رشد در محدودهٔ تلهٔ خروج / فومو بوده است. در بازار آرام، ترکیب حجم بالای ۴۰ میلیون و رشد ۱۰ تا ۵۰ درصد کمیاب است. از فرم بالا می‌توانید همان نماد را با اعداد خودتان بسنجید.</div>`}
      <div class="mom-head"><h3>رد به دلیل فومو یا تلهٔ نقدینگی</h3>${b.fomo.length > 6 ? `<button type="button" class="tool" data-mom-more>${showFomo ? 'نمایش کمتر' : 'نمایش بیشتر'}</button>` : ''}</div>
      ${fomo ? `<div class="mom-grid">${fomo}</div>` : '<div class="mom-empty">در این دور موردی به‌عنوان فومو یا تلهٔ نقدینگی رد نشد.</div>'}
      ${misses}`;
    paintIcons();
  }
  function firstFail(row) {
    for (const key of ['history', 'liquidity', 'momentum', 'fakeBoost', 'instrument']) {
      if (!row.filters[key].pass) return row.filters[key].text;
    }
    return row.verdictLabel;
  }

  let lastBoard = null, lastNote = '';
  function paintPins() {
    const slot = host.querySelector('[data-mom-pins]');
    if (!slot) return;
    const pins = readPins();
    slot.innerHTML = `<div class="mom-head"><h3>واچ‌لیست ذخیره‌شده در همین مرورگر</h3><span>حداکثر ۳۰ مورد · پاک‌کردن دادهٔ سایت آن را حذف می‌کند</span></div>` +
      (pins.length ? pins.map(p => {
        const stale = Date.now() - p.at > STALE_MS;
        return `<div class="mom-pin"><div><b>${esc(p.symbol)}</b> <small>${esc(p.verdictLabel)} · ریسک ${esc(p.riskLabel)}${p.source === 'simulation' ? ' · شبیه‌سازی' : ''}</small><br>
          <small class="${stale ? 'mom-stale' : ''}">${stale ? 'کهنه — دوباره بسنجید. ' : ''}قیمت ثبت ${num(px(p.price))} · ورود ${num(px(p.entry))} · حد ${num(px(p.stop))} · هدفها ${num(px(p.tp1))} / ${num(px(p.tp2))}</small></div>
          <button type="button" class="tool" data-mom-unpin="${esc(p.id)}">حذف</button></div>`;
      }).join('') : '<div class="mom-empty">هنوز موردی ثبت نشده. ثبت، فقط یادداشت محلی است و قیمت را دنبال نمی‌کند.</div>');
  }

  function render(model) {
    if (!host) return;
    lastCtx = model && model.ctx || lastCtx;
    known = new Set(model && model.knownIds || []);
    lastBoard = model && model.board;
    lastNote = model && model.universeNote || '';
    const envSlot = host.querySelector('[data-mom-env]');
    if (envSlot) envSlot.innerHTML = envHtml(model && model.board && model.board.environment, lastNote);
    paintBoard();
    paintPins();
  }

  root.MomentumView = {
    get ready() { return !!host; },
    mount(next) {
      options = next || {};
      host = options.element;
      if (!host || !Engine) return;
      shell();
      paintPins();
    },
    render
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
