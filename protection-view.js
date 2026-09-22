/* Portfolio protection UI. All fills require explicit user recording. */
(function (root) {
  'use strict';
  const Engine = root.RadarProtection;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = value => Number(value).toLocaleString('en-US', { maximumSignificantDigits: 10 });
  const price = value => value == null ? '—' : '$' + number(value);
  const date = value => new Date(value).toLocaleString('fa-IR');
  const reasons = {
    STOP_LOSS: 'حد ضرر اولیه', TRAILING_STOP: 'حد ضرر متحرک', BREAKEVEN_STOP: 'حد ضرر در نقطهٔ ورود',
    TARGET_1: 'هدف اول', TARGET_2: 'هدف دوم', TIME_EXIT: 'پایان مهلت نگهداری', INVALIDATION: 'ابطال قیمتی سناریو'
  };
  const problems = { missing: 'قیمت در دسترس نیست', stale: 'داده کهنه است', error: 'دریافت قیمت ناموفق بود',
    invalid: 'قیمت یا زمان داده نامعتبر است', source: 'منبع داده با طرح سازگار نیست', future: 'زمان داده در آینده است',
    'before-entry': 'منتظر قیمت جدیدتر از زمان ورود', 'out-of-order': 'داده قدیمی‌تر از مشاهدهٔ قبلی است', 'invalid-plan': 'طرح ذخیره‌شده نامعتبر است' };
  const plans = rows => rows.flatMap(row => Array.isArray(row.protections) ? row.protections.map(p => ({ row, p })) : []);
  let options, host, quotes = {}, polling = null, lastFetch = 0;
  const get = selector => host.querySelector(selector);
  const id = () => root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'position-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const localDate = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

  function fail(message, scope = 'form') {
    const el = get('[data-protection-error]');
    el.textContent = message; el.hidden = false; el.dataset.scope = scope;
  }
  function clearError() { get('[data-protection-error]').hidden = true; }
  function find(rows, planId) {
    for (const row of rows) {
      const index = (row.protections || []).findIndex(p => p.id === planId);
      if (index >= 0) return { row, index, p: row.protections[index] };
    }
    throw new Error('معامله پیدا نشد؛ صفحه را به‌روز کنید.');
  }

  function open(coinId) {
    const rows = options.getPortfolio().filter(row => Number(row.qty) > 0);
    if (!rows.length) { fail('ابتدا دارایی و بهای خرید را به پرتفوی اضافه کنید.'); return; }
    get('[name="coinId"]').innerHTML = rows.map(row => `<option value="${esc(row.id)}">${esc(row.sym)} — ${esc(row.name)}</option>`).join('');
    if (rows.some(row => row.id === coinId)) get('[name="coinId"]').value = coinId;
    get('[data-fill-form]').hidden = true;
    get('[data-plan-form]').hidden = false;
    populate();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function populate() {
    const row = options.getPortfolio().find(r => r.id === get('[name="coinId"]').value);
    if (!row) return;
    const form = get('[data-plan-form]');
    for (const name of ['stop', 'target1', 'target2', 'trailPct', 'maxHours', 'invalidation']) form.elements[name].value = '';
    form.elements.quantity.value = row.qty;
    form.elements.entryPrice.value = row.buy || '';
    form.elements.enteredAt.value = localDate(Date.now());
    form.elements.target1Pct.value = '50';
    form.elements.breakeven.checked = true;
    const exists = (row.protections || []).some(Engine.active);
    get('[data-plan-mode]').textContent = exists ? 'این دارایی طرح فعال دارد. خرید اضافه، شرایط طرح قبلی را عوض نمی‌کند.' :
      row.id.startsWith('sim-') ? 'طرح آزمایشی — فقط دادهٔ شبیه‌سازی؛ بدون اعلان واقعی بازار.' : 'طرح واقعی — فقط قیمت مستقل CoinGecko با زمان معتبر؛ بدون اتصال معاملاتی به صرافی.';
    get('[data-plan-save]').disabled = exists;
    clearError();
  }

  async function savePlan(event) {
    event.preventDefault(); clearError();
    const form = event.target, input = Object.fromEntries(new FormData(form));
    const now = Date.now();
    const button = get('[data-plan-save]'); button.disabled = true;
    try {
      const saved = await options.mutate(rows => {
        const row = rows.find(r => r.id === input.coinId);
        if (!row || !Number.isFinite(Number(row.qty)) || Number(input.quantity) > Number(row.qty)) throw new Error('تعداد طرح بیشتر از موجودی فعلی پرتفوی است.');
        if ((row.protections || []).some(Engine.active)) throw new Error('برای این دارایی یک طرح فعال وجود دارد.');
        const p = Engine.create({ ...input, id: id(), symbol: row.sym,
          mode: row.id.startsWith('sim-') ? 'simulation' : 'live',
          enteredAt: new Date(input.enteredAt).getTime(), breakeven: form.elements.breakeven.checked }, now);
        row.protections = [...(row.protections || []), p];
        return p;
      });
      if (!saved.ok) throw new Error(saved.error);
      get('[data-plan-form]').hidden = true;
      options.onChange(); render();
      options.toast('طرح حفاظت ثبت شد؛ هیچ سفارشی ارسال نشده است.', 'ok');
      await refresh(true);
    } catch (error) { fail(error.message); }
    finally { button.disabled = false; }
  }

  function eventText(event) {
    const reason = reasons[event.reason] || '';
    if (event.type === 'CREATED') return 'پایش فعال شد؛ شرایط ورود و ریسک ثبت شد.';
    if (event.type === 'SIGNAL') return `${event.action === 'EXIT_LONG' ? 'هشدار خروج کامل' : 'هشدار کاهش دارایی'} — ${reason} — تعداد ${number(event.quantity)} — قیمت مشاهده‌شده ${price(event.observedPrice)}؛ انجام نشده`;
    if (event.type === 'STOP_RAISED') return `حد ضرر به ${price(event.stop)} افزایش یافت — ${reason}`;
    if (event.type === 'SUPERSEDED') return 'هشدار قبلی با خروج کامل جایگزین شد — ' + reason;
    if (event.type === 'EXECUTION_RECORDED') return `ثبت دستی خروج ${number(event.quantity)} واحد در ${price(event.price)} — سود/زیان ناخالص ${price(event.grossPnl)} (بدون هزینه‌ها)`;
    if (event.type === 'CLOSED') return 'خروج کامل توسط کاربر ثبت شد.';
    if (event.type === 'CANCELLED') return 'پایش توسط کاربر متوقف شد؛ فروش ثبت نشده است.';
    return event.type;
  }

  function render() {
    if (!host) return;
    const all = plans(options.getPortfolio()), valid = all.filter(({ p }) => Engine.validPosition(p));
    const count = valid.filter(({ p }) => Engine.active(p)).length;
    get('[data-protection-count]').textContent = number(count) + ' طرح فعال';
    get('[data-protection-invalid]').hidden = all.length === valid.length;
    const expanded = new Set([...host.querySelectorAll('.protect-history[open]')].map(el => el.closest('[data-plan-id]').dataset.planId));
    const cards = valid.slice().reverse().map(({ row, p }) => {
      const watching = Engine.active(p), quote = quotes[p.coinId];
      const problem = watching ? Engine.quoteProblem(p, quote, Date.now()) : null;
      const status = p.status === 'CLOSED' ? 'خروج ثبت‌شده' : p.status === 'CANCELLED' ? 'پایش متوقف‌شده' : p.pending ? 'هشدار خروج — منتظر اقدام شما' : 'در حال پایش';
      const pending = p.pending;
      return `<article class="protect-card ${pending ? 'protect-pending' : ''}" data-plan-id="${esc(p.id)}">
        <header><div><b>${esc(row.sym)} · ${esc(row.name)}</b><span class="protect-mode">${p.mode === 'live' ? 'واقعی' : 'آزمایشی'} · ${status}</span></div>
          ${watching ? `<button type="button" class="tool" data-protect-cancel="${esc(p.id)}">توقف پایش</button>` : ''}</header>
        ${watching ? `<p class="protect-data ${problem ? 'down' : 'up'}">${problem ? 'پایش قیمتی معلق: ' + esc(problems[problem] || problem) + '؛ حد حفاظتی حذف نشده است.' : 'قیمت معتبر ' + price(quote.price) + ' · زمان منبع: ' + date(quote.asOf)}</p>` : ''}
        <div class="protect-metrics">
          <div><span>ورود ثبت‌شده</span><b class="num">${price(p.entryPrice)}</b></div>
          <div><span>تعداد باقی‌مانده / اولیه</span><b class="num">${number(p.remainingQty)} / ${number(p.initialQty)}</b></div>
          <div><span>حد ضرر فعال / اولیه</span><b class="num down">${price(p.stop)} / ${price(p.plan.initialStop)}</b></div>
          <div><span>هدف اول / دوم</span><b class="num">${price(p.plan.target1)} / ${price(p.plan.target2)}</b></div>
        </div>
        <p class="protect-meta">ورود: ${date(p.enteredAt)} · شروع پایش: ${date(p.createdAt)}<br>
          سقف مشاهده‌شده از شروع پایش: <span class="num">${price(p.highWater)}</span> ·
          متحرک: ${p.plan.trailPct == null ? 'خاموش' : number(p.plan.trailPct) + '%؛ فعال‌سازی در ' + price(p.plan.trailActivation)} ·
          مهلت خروج: ${p.plan.maxHours == null ? 'ندارد' : date(p.enteredAt + p.plan.maxHours * 3600000)} ·
          ابطال قیمتی: <span class="num">${price(p.plan.invalidation)}</span><br>
          ${p.plan.target1 == null ? '' : 'سهم هدف اول: ' + number(p.plan.target1Pct) + '% از تعداد اولیه · '}
          انتقال حد ضرر به ورود پس از ثبت کامل خروج اول: ${p.plan.breakeven ? 'فعال' : 'خاموش'}
          ${watching && Number(row.qty) > p.remainingQty ? '<br>بخشی از موجودی فعلی خارج از این طرح است؛ خرید اضافه خودکار به طرح نمی‌پیوندد.' : ''}
        </p>
        ${pending ? `<div class="protect-action" role="status"><strong>${pending.action === 'EXIT_LONG' ? 'خروج از تمام باقی‌مانده' : 'کاهش بخشی از دارایی'} — ${reasons[pending.reason] || esc(pending.reason)}</strong>
          <p>تعداد پیشنهادی: <b class="num">${number(pending.quantity)}</b> · قیمت هنگام هشدار: <b class="num">${price(pending.observedPrice)}</b><br>این هشدار فروش انجام‌شده نیست؛ با برگشت قیمت نیز خودکار پاک نمی‌شود.</p>
          <button type="button" class="tool on" data-fill-open="${esc(p.id)}" data-signal="${esc(pending.id)}">ثبت خروجی که انجام داده‌ام</button></div>` : ''}
        <details class="protect-history" ${expanded.has(p.id) ? 'open' : ''}><summary>تاریخچهٔ معامله (${number(p.events.length)})</summary>
          <ol>${p.events.slice().reverse().map(event => `<li><time>${date(event.at)}</time><span>${esc(eventText(event))}</span></li>`).join('')}</ol>
          <small class="num">${esc(p.id)}</small></details>
      </article>`;
    });
    get('[data-protection-cards]').innerHTML = cards.join('') || '<div class="empty">طرح حفاظتی ثبت نشده است. از «ثبت طرح حفاظت» یا دکمهٔ حفاظت کنار دارایی‌های پرتفوی شروع کنید.</div>';
  }

  async function refresh(force) {
    if (!host || polling) return polling;
    if (!force && Date.now() - lastFetch < 60000) { render(); return; }
    lastFetch = Date.now();
    polling = (async () => {
      const current = plans(options.getPortfolio()).filter(({ p }) => Engine.validPosition(p) && Engine.active(p));
      if (!current.length) { render(); return; }
      get('[data-protection-refresh]').disabled = true;
      const live = current.filter(({ p }) => p.mode === 'live').map(({ p }) => p.coinId);
      const received = await Engine.fetchQuotes(live, { directOnly: options.directOnly() });
      const simulated = options.simulatedQuotes();
      for (const { p } of current) if (p.mode === 'simulation') received[p.coinId] = simulated[p.coinId] || { coinId: p.coinId, status: 'missing' };
      quotes = received;
      const saved = await options.mutate(rows => {
        const emitted = [];
        for (const row of rows) {
          if (!Array.isArray(row.protections)) continue;
          row.protections = row.protections.map(p => {
            if (!Engine.validPosition(p) || !Engine.active(p)) return p;
            const result = Engine.evaluate(p, received[p.coinId]);
            for (const event of result.events) if (event.type === 'SIGNAL') emitted.push({ p: result.position, event });
            return result.position;
          });
        }
        return emitted;
      });
      if (!saved.ok) { fail(saved.error + ' پایش ثبت نشده؛ هشدار جدید ارسال نشد.', 'poll'); return; }
      if (get('[data-protection-error]').dataset.scope === 'poll') clearError();
      for (const { p, event } of saved.value) {
        const text = `${p.mode === 'simulation' ? 'آزمایشی — ' : ''}${p.symbol}: ${event.action === 'EXIT_LONG' ? 'خروج از خرید' : 'کاهش دارایی'}؛ ${reasons[event.reason]}؛ تعداد ${number(event.quantity)}. فروش خودکار انجام نشده است.`;
        options.toast(esc(text), 'warn', 10000);
        if (p.mode === 'live') options.notify('حفاظت سرمایه — ' + p.symbol, text, 'protection-' + event.id, '#secPortfolio', null);
      }
      options.onChange();
    })().catch(() => { quotes = {}; fail('پایش حفاظت ناموفق بود؛ حد ضرر و تاریخچه حفظ شدند.', 'poll'); })
      .finally(() => { polling = null; get('[data-protection-refresh]').disabled = false; render(); });
    return polling;
  }

  function openFill(planId, signalId) {
    const { p } = find(options.getPortfolio(), planId);
    if (!p.pending || p.pending.id !== signalId) throw new Error('هشدار تغییر کرده است؛ دوباره بررسی کنید.');
    get('[data-plan-form]').hidden = true;
    const form = get('[data-fill-form]');
    form.elements.planId.value = planId; form.elements.signalId.value = signalId;
    form.elements.quantity.value = p.pending.quantity; form.elements.price.value = '';
    get('[data-fill-title]').textContent = 'ثبت دستی خروج ' + p.symbol + ' — ' + reasons[p.pending.reason];
    form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.price.focus();
  }

  async function saveFill(event) {
    event.preventDefault(); clearError();
    const form = event.target, input = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      if (!root.confirm('آیا این تعداد را واقعاً خارج کرده‌اید؟ فقط سابقه و موجودی محلی ثبت می‌شود؛ هیچ سفارشی ارسال نمی‌شود.')) return;
      const saved = await options.mutate(rows => {
        const { row, index, p } = find(rows, input.planId);
        const updated = Engine.recordExecution(p, input);
        const amount = p.remainingQty - updated.remainingQty;
        if (!Number.isFinite(Number(row.qty)) || Number(row.qty) + p.initialQty * 1e-10 < amount) throw new Error('موجودی پرتفوی کافی نیست؛ ابتدا اختلاف موجودی را بررسی کنید.');
        row.qty = Math.max(0, Number(row.qty) - amount);
        row.protections[index] = updated;
      });
      if (!saved.ok) throw new Error(saved.error);
      form.hidden = true; options.onChange(); render();
      options.toast('خروج دستی ثبت شد و موجودی محلی به‌روز شد؛ سفارشی ارسال نشد.', 'ok');
    } catch (error) { fail(error.message); }
    finally { button.disabled = false; }
  }

  function mount(config) {
    options = config; host = config.element;
    host.innerHTML = `<div class="protect-heading"><div><h3>حفاظت سرمایه — خروج از خرید</h3><span data-protection-count></span></div>
      <div><button class="tool on" type="button" data-protection-new>ثبت طرح حفاظت</button> <button class="tool" type="button" data-protection-refresh>بررسی قیمت</button></div></div>
      <p class="protect-notice">فقط هشدار و ثبت دستی؛ نه فروش خودکار و نه تضمین اجرای حد ضرر. بررسی تقریباً هر ۹۰ ثانیه، فقط هنگام اجرای برنامه؛ با بسته‌شدن یا تعلیق مرورگر پایش متوقف می‌شود. دادهٔ بیش از ۵ دقیقه مبنای هشدار تازه نیست. طرح ذخیره‌شده با تغییر سیگنال خرید یا رفرش بازنویسی نمی‌شود.</p>
      <p class="protect-error" data-protection-error role="alert" hidden></p>
      <p class="protect-error" data-protection-invalid hidden>بعضی طرح‌های ذخیره‌شده معتبر نیستند و پایش نمی‌شوند؛ دادهٔ آن‌ها حذف نشده است.</p>
      <form class="protect-form" data-plan-form hidden>
        <h4>ثبت شرایط معامله و حفاظت از این لحظه</h4><p data-plan-mode></p>
        <div class="protect-fields">
          <label>دارایی پرتفوی<select name="coinId" required></select></label>
          <label>تعداد تحت حفاظت<input name="quantity" type="number" step="any" min="0" required></label>
          <label>قیمت ورود ($)<input name="entryPrice" type="number" step="any" min="0" required></label>
          <label>زمان واقعی ورود<input name="enteredAt" type="datetime-local" required></label>
          <label>حد ضرر اولیه ($)<input name="stop" type="number" step="any" min="0" required></label>
          <label>هدف اول ($) — اختیاری<input name="target1" type="number" step="any" min="0"></label>
          <label>سهم خروج اول (%)<input name="target1Pct" type="number" step="any" min="0" max="99.99" value="50" required></label>
          <label>هدف نهایی ($) — اختیاری<input name="target2" type="number" step="any" min="0"></label>
          <label>فاصلهٔ متحرک (%) — اختیاری<input name="trailPct" type="number" step="any" min="0" max="99.99"></label>
          <label>مهلت از ورود (ساعت) — اختیاری<input name="maxHours" type="number" step="any" min="0"></label>
          <label>ابطال قیمت زیرِ ($) — اختیاری<input name="invalidation" type="number" step="any" min="0"></label>
        </div>
        <label class="protect-check"><input type="checkbox" name="breakeven" checked>پس از ثبت کامل اجرای هدف اول، حد ضرر حداقل به قیمت ورود برسد.</label>
        <p class="protect-meta">متحرک از سود ۱R فعال می‌شود: قیمت ورود + فاصلهٔ ورود تا حد ضرر اولیه. مبنا فقط سقف‌های مشاهده‌شده از شروع پایش است، نه سقف تاریخی. مقدار خالی یعنی غیرفعال؛ هیچ درصد ریسکی خودکار انتخاب نمی‌شود. ابطال قیمتی بین حد ضرر و ورود است. قیمت‌ها آستانهٔ هشدارند، نه تضمین قیمت فروش. زمان ورود پیشنهادی را برای خریدهای قبلی اصلاح کنید.</p>
        <button class="tool on" type="submit" data-plan-save>ثبت و آغاز پایش</button> <button class="tool" type="button" data-plan-close>انصراف</button>
      </form>
      <form class="protect-form" data-fill-form hidden><h4 data-fill-title></h4>
        <input name="planId" type="hidden"><input name="signalId" type="hidden">
        <div class="protect-fields"><label>تعداد خارج‌شده<input name="quantity" type="number" step="any" min="0" required></label><label>قیمت واقعی خروج ($)<input name="price" type="number" step="any" min="0" required></label></div>
        <p class="protect-meta">فقط خروجی را ثبت کنید که انجام داده‌اید. ثبت بخشی از مقدار مجاز است؛ باقی‌ماندهٔ هشدار حفظ می‌شود. تعداد پرتفوی فقط پس از ثبت شما کاهش می‌یابد. سود/زیان ثبت‌شده ناخالص و بدون کارمزد است.</p>
        <button class="tool on" type="submit">تأیید ثبت دستی خروج</button> <button class="tool" type="button" data-fill-close>انصراف</button>
      </form><div class="protect-cards" data-protection-cards></div>`;
    get('[data-plan-form]').addEventListener('submit', savePlan);
    get('[data-fill-form]').addEventListener('submit', saveFill);
    get('[name="coinId"]').addEventListener('change', populate);
    host.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button) return;
      try {
        if (button.hasAttribute('data-protection-new')) open();
        if (button.hasAttribute('data-plan-close')) get('[data-plan-form]').hidden = true;
        if (button.hasAttribute('data-fill-close')) get('[data-fill-form]').hidden = true;
        if (button.hasAttribute('data-protection-refresh')) await refresh(true);
        if (button.dataset.fillOpen) openFill(button.dataset.fillOpen, button.dataset.signal);
        if (button.dataset.protectCancel && root.confirm('پایش این طرح متوقف شود؟ این کار فروش نیست و موجودی تغییر نمی‌کند.')) {
          const saved = await options.mutate(rows => {
            const { row, index, p } = find(rows, button.dataset.protectCancel);
            row.protections[index] = Engine.cancel(p);
          });
          if (!saved.ok) throw new Error(saved.error);
          options.onChange(); render();
        }
      } catch (error) { fail(error.message); }
    });
    setInterval(() => refresh(), 90000);
    setInterval(render, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    render(); refresh();
  }
  root.ProtectionView = { mount, open, render, refresh };
})(globalThis);
