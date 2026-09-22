/* Long-position protection only: advisories, never exchange orders. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarProtection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const MAX_QUOTE_AGE = 5 * 60 * 1000;
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const optional = v => v == null || v === '' ? null : Number(v);
  const copy = p => ({ ...p, plan: { ...p.plan }, pending: p.pending ? { ...p.pending } : null,
    lastQuote: p.lastQuote ? { ...p.lastQuote } : null, events: p.events.slice() });
  const active = p => p && p.version === VERSION && p.status === 'ACTIVE' && p.remainingQty > 0;
  const tolerance = p => p.initialQty * 1e-10;

  function append(p, type, at, details) {
    const event = { id: p.id + ':' + p.nextEvent++, type, at, ...details };
    p.events.push(event);
    return event;
  }

  function create(input, now = Date.now()) {
    const entryPrice = Number(input.entryPrice), qty = Number(input.quantity);
    const enteredAt = Number(input.enteredAt), stop = Number(input.stop);
    const target1 = optional(input.target1), target2 = optional(input.target2);
    const trailPct = optional(input.trailPct), maxHours = optional(input.maxHours);
    const invalidation = optional(input.invalidation);
    const target1Pct = input.target1Pct == null ? 50 : Number(input.target1Pct);
    if (!input.id || !/^[a-z0-9-]+$/.test(input.coinId || '')) throw new Error('شناسهٔ معامله یا دارایی معتبر نیست.');
    if (!['live', 'simulation'].includes(input.mode)) throw new Error('نوع دادهٔ معامله مشخص نیست.');
    if (!positive(entryPrice) || !positive(qty) || !positive(entryPrice * qty)) throw new Error('قیمت ورود، تعداد و ارزش معامله باید مثبت و متناهی باشند.');
    if (!Number.isFinite(enteredAt) || enteredAt <= 0 || enteredAt > now) throw new Error('زمان ورود معتبر و غیرآینده را وارد کنید.');
    if (!positive(stop) || stop >= entryPrice) throw new Error('حد ضرر اولیه باید مثبت و پایین‌تر از قیمت ورود باشد.');
    if (!positive(entryPrice + (entryPrice - stop))) throw new Error('مقادیر قیمت از دامنهٔ قابل محاسبه خارج‌اند.');
    if (target1 != null && (!positive(target1) || target1 <= entryPrice)) throw new Error('هدف اول باید بالاتر از قیمت ورود باشد.');
    if (target2 != null && (!positive(target2) || target2 <= (target1 || entryPrice))) throw new Error('هدف دوم باید بالاتر از ورود و هدف اول باشد.');
    if (!positive(target1Pct) || target1Pct >= 100) throw new Error('سهم خروج اول باید بین صفر و صد درصد باشد.');
    if (trailPct != null && (!positive(trailPct) || trailPct >= 100)) throw new Error('فاصلهٔ متحرک باید بین صفر و صد درصد باشد.');
    if (maxHours != null && (!positive(maxHours) || !Number.isFinite(enteredAt + maxHours * 3600000))) throw new Error('مهلت نگهداری معتبر نیست.');
    if (invalidation != null && (!positive(invalidation) || invalidation <= stop || invalidation >= entryPrice)) throw new Error('قیمت ابطال باید بین حد ضرر و قیمت ورود باشد.');
    const p = {
      version: VERSION, id: String(input.id), coinId: input.coinId,
      symbol: String(input.symbol || input.coinId), mode: input.mode,
      entryPrice, enteredAt, createdAt: now, initialQty: qty, remainingQty: qty,
      status: 'ACTIVE', stop, stopReason: 'STOP_LOSS', highWater: entryPrice,
      target1Triggered: false, target1Completed: false, trailingActive: false,
      plan: { initialStop: stop, target1, target2, target1Pct, trailPct, maxHours,
        invalidation, breakeven: input.breakeven === true,
        trailActivation: entryPrice + (entryPrice - stop) },
      pending: null, lastQuote: null, nextEvent: 1, events: []
    };
    append(p, 'CREATED', now, { reason: 'MONITORING_STARTED' });
    return p;
  }

  // Invalid persisted records are never silently converted into active positions.
  function validPosition(p) {
    if (!p || p.version !== VERSION || !['ACTIVE', 'CLOSED', 'CANCELLED'].includes(p.status)) return false;
    try {
      const original = create({ id: p.id, coinId: p.coinId, symbol: p.symbol, mode: p.mode,
        entryPrice: p.entryPrice, quantity: p.initialQty, enteredAt: p.enteredAt,
        stop: p.plan.initialStop, ...p.plan }, Math.max(p.createdAt, p.enteredAt));
      return positive(p.entryPrice) && positive(p.initialQty) && Number.isFinite(p.createdAt) &&
        p.plan.trailActivation === original.plan.trailActivation && typeof p.plan.breakeven === 'boolean' &&
        positive(p.stop) && p.stop >= p.plan.initialStop && positive(p.highWater) && p.stop <= p.highWater &&
        Number.isFinite(p.remainingQty) && p.remainingQty >= 0 && p.remainingQty <= p.initialQty &&
        (p.status !== 'CLOSED' || p.remainingQty === 0) && (p.status !== 'ACTIVE' || p.remainingQty > 0) &&
        Number.isInteger(p.nextEvent) && p.nextEvent > 0 && Array.isArray(p.events) &&
        p.events.every(e => e && typeof e.id === 'string' && Number.isFinite(e.at)) &&
        (!p.pending || (typeof p.pending.id === 'string' && ['EXIT_LONG', 'REDUCE_LONG'].includes(p.pending.action) && positive(p.pending.quantity) && p.pending.quantity <= p.remainingQty + tolerance(p)));
    } catch (_) { return false; }
  }

  function quoteProblem(p, quote, now = Date.now()) {
    if (!quote) return 'missing';
    if (quote.status && quote.status !== 'fresh') return quote.status;
    if (quote.coinId !== p.coinId || quote.source !== p.mode) return 'source';
    if (!positive(quote.price) || !Number.isFinite(quote.asOf)) return 'invalid';
    if (quote.asOf > now + 60000) return 'future';
    if (now - quote.asOf > MAX_QUOTE_AGE) return 'stale';
    if (quote.asOf < p.enteredAt) return 'before-entry';
    if (p.lastQuote && quote.asOf < p.lastQuote.asOf) return 'out-of-order';
    return null;
  }

  function trigger(p, action, reason, quantity, quote, now) {
    const priority = { STOP_LOSS: 5, TRAILING_STOP: 5, BREAKEVEN_STOP: 5, INVALIDATION: 4, TIME_EXIT: 3, TARGET_2: 2, TARGET_1: 1 };
    // An unfilled profit/time exit must not suppress a later protective stop.
    if (p.pending && priority[reason] <= priority[p.pending.reason]) return;
    if (p.pending) append(p, 'SUPERSEDED', now, { signalId: p.pending.id, reason });
    const event = append(p, 'SIGNAL', now, { action, reason, quantity, observedPrice: quote.price, quoteAt: quote.asOf });
    p.pending = { ...event };
    return event;
  }

  function evaluate(position, quote, now = Date.now()) {
    if (!validPosition(position)) return { position, events: [], problem: 'invalid-plan' };
    if (!active(position)) return { position, events: [], problem: null };
    const problem = quoteProblem(position, quote, now);
    if (problem) return { position, events: [], problem };
    const p = copy(position), before = p.events.length;
    // A cached/repeated observation is not a new high-water mark or price trigger.
    const freshObservation = !p.lastQuote || quote.asOf > p.lastQuote.asOf;
    const observed = freshObservation ? quote : p.lastQuote;
    if (freshObservation) {
      p.lastQuote = { coinId: quote.coinId, price: quote.price, asOf: quote.asOf, source: quote.source };
      p.highWater = Math.max(p.highWater, quote.price);
      if (p.plan.trailPct != null && p.highWater >= p.plan.trailActivation) {
        p.trailingActive = true;
        const nextStop = p.highWater * (1 - p.plan.trailPct / 100);
        if (nextStop > p.stop) {
          p.stop = nextStop; p.stopReason = 'TRAILING_STOP';
          append(p, 'STOP_RAISED', now, { stop: p.stop, reason: p.stopReason });
        }
      }
    }
    // Protective rules do not consult BUY/SELL labels, RSI, grades or confidence.
    if (observed.price <= p.stop) trigger(p, 'EXIT_LONG', p.stopReason, p.remainingQty, observed, now);
    else if (p.plan.invalidation != null && observed.price <= p.plan.invalidation)
      trigger(p, 'EXIT_LONG', 'INVALIDATION', p.remainingQty, observed, now);
    else if (p.plan.maxHours != null && now >= p.enteredAt + p.plan.maxHours * 3600000)
      trigger(p, 'EXIT_LONG', 'TIME_EXIT', p.remainingQty, observed, now);
    else if (p.plan.target2 != null && observed.price >= p.plan.target2)
      trigger(p, 'EXIT_LONG', 'TARGET_2', p.remainingQty, observed, now);
    else if (!p.target1Triggered && p.plan.target1 != null && observed.price >= p.plan.target1) {
      if (trigger(p, 'REDUCE_LONG', 'TARGET_1', Math.min(p.remainingQty, p.initialQty * p.plan.target1Pct / 100), observed, now))
        p.target1Triggered = true;
    }
    return { position: p, events: p.events.slice(before), problem: null };
  }

  function recordExecution(position, input, now = Date.now()) {
    if (!validPosition(position) || !active(position) || !position.pending) throw new Error('هشدار خروج فعالی برای این معامله وجود ندارد.');
    if (input.signalId !== position.pending.id) throw new Error('هشدار تغییر کرده است؛ مقدار خروج جدید را بررسی کنید.');
    const quantity = Number(input.quantity), price = Number(input.price);
    if (!positive(quantity) || quantity > position.pending.quantity + tolerance(position) || quantity > position.remainingQty + tolerance(position))
      throw new Error('تعداد خروج باید مثبت و حداکثر به اندازهٔ مقدار هشدار باشد.');
    if (!positive(price)) throw new Error('قیمت واقعی خروج انجام‌شده را وارد کنید.');
    const p = copy(position), amount = Math.min(quantity, p.pending.quantity, p.remainingQty);
    append(p, 'EXECUTION_RECORDED', now, { signalId: p.pending.id, action: p.pending.action,
      reason: p.pending.reason, quantity: amount, price, grossPnl: (price - p.entryPrice) * amount });
    p.remainingQty = Math.max(0, p.remainingQty - amount);
    p.pending.quantity = Math.max(0, p.pending.quantity - amount);
    if (p.remainingQty <= tolerance(p)) {
      p.remainingQty = 0; p.status = 'CLOSED'; p.closedAt = now; p.pending = null;
      append(p, 'CLOSED', now, { reason: 'USER_RECORDED_EXIT' });
    } else if (p.pending.quantity <= tolerance(p)) {
      if (p.pending.reason === 'TARGET_1') {
        p.target1Completed = true;
        if (p.plan.breakeven && p.entryPrice > p.stop) {
          p.stop = p.entryPrice; p.stopReason = 'BREAKEVEN_STOP';
          append(p, 'STOP_RAISED', now, { stop: p.stop, reason: p.stopReason });
        }
      }
      p.pending = null;
    }
    return p;
  }

  function cancel(position, now = Date.now()) {
    if (!validPosition(position) || !active(position)) throw new Error('این طرح فعال نیست.');
    const p = copy(position);
    p.status = 'CANCELLED'; p.pending = null;
    append(p, 'CANCELLED', now, { reason: 'MONITORING_STOPPED_NOT_SOLD' });
    return p;
  }

  async function fetchQuotes(ids, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const clock = options.now || Date.now;
    const result = {};
    const unique = [...new Set(ids)].filter(id => /^[a-z0-9-]+$/.test(id) && !id.startsWith('sim-'));
    for (let start = 0; start < unique.length; start += 50) {
      const batch = unique.slice(start, start + 50);
      const params = new URLSearchParams({ vs_currency: 'usd', ids: batch.join(','), per_page: '250', page: '1', sparkline: 'false' });
      const urls = options.directOnly ? [] : ['/api/proxy?src=cg&path=coins%2Fmarkets&' + params];
      urls.push('https://api.coingecko.com/api/v3/coins/markets?' + params);
      let data = null, failed = 'error';
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetcher(url, { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          if ((response.headers.get('X-Radar-Cache') || '').toUpperCase() === 'STALE') { failed = 'stale'; break; }
          const body = await response.json();
          if (!Array.isArray(body)) throw new Error('Invalid market response');
          data = body; break;
        } catch (_) { failed = 'error'; }
        finally { clearTimeout(timer); }
      }
      for (const id of batch) {
        const row = data && data.find(c => c && c.id === id);
        if (!row) { result[id] = { coinId: id, status: data ? 'missing' : failed }; continue; }
        const quote = { coinId: id, price: typeof row.current_price === 'number' ? row.current_price : NaN,
          asOf: typeof row.last_updated === 'string' ? Date.parse(row.last_updated) : NaN, source: 'live' };
        const problem = quoteProblem({ coinId: id, mode: 'live', enteredAt: 0 }, quote, clock());
        result[id] = { ...quote, status: problem || 'fresh' };
      }
    }
    return result;
  }

  return Object.freeze({ VERSION, MAX_QUOTE_AGE, create, active, validPosition, quoteProblem, evaluate, recordExecution, cancel, fetchQuotes });
});
