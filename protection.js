/* Long-position protection only: advisories, never exchange orders. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarProtection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_QUOTE_AGE = 5 * 60 * 1000;
  const COIN_ID = /^[a-z0-9-]+$/;
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
    !/[\u0000-\u001f]/.test(value);
  const MODES = new Set(['live', 'simulation']);
  const ACTIONS = new Set(['EXIT_LONG', 'REDUCE_LONG']);
  const STOP_REASONS = new Set(['STOP_LOSS', 'TRAILING_STOP', 'BREAKEVEN_STOP']);
  const EVENT_TYPES = new Set(['CREATED', 'STOP_RAISED', 'SIGNAL', 'SUPERSEDED',
    'EXECUTION_RECORDED', 'CLOSED', 'CANCELLED']);

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const positive = value => finite(value) && value > 0;
  const optional = value => value == null || value === '' ? null : Number(value);
  const copy = position => ({
    ...position,
    plan: { ...position.plan },
    pending: position.pending ? { ...position.pending } : null,
    lastQuote: position.lastQuote ? { ...position.lastQuote } : null,
    events: position.events.slice()
  });

  // Invalid records must not disable portfolio controls as if they were being
  // monitored. Function declarations are hoisted so this can be used by the
  // view before the validator is exported.
  function active(position) {
    return validPosition(position) && position.status === 'ACTIVE' && position.remainingQty > 0;
  }

  // Floating-point tolerance must not scale with the whole position forever. A
  // position of 1e12 units should not make a 50-unit unsold remainder look like
  // dust, while normal decimal quantities still get room for IEEE-754 noise.
  function quantityTolerance(...values) {
    const scale = values.filter(finite).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    return Math.max(
      Number.EPSILON * Math.max(1, scale) * 64,
      Math.min(scale * 1e-10, 1e-8)
    );
  }

  function append(position, type, at, details) {
    const event = { id: position.id + ':' + position.nextEvent++, type, at, ...details };
    position.events.push(event);
    return event;
  }

  // A deterministic local fingerprint catches accidental edits to the entry
  // snapshot (for example a UI refresh writing a new target into an old plan).
  // It is an integrity check, not a security boundary: localStorage is user
  // controlled and this app never treats it as a tamper-proof ledger.
  function snapshotOf(position) {
    const plan = position.plan || {};
    return JSON.stringify([
      position.id, position.coinId, position.symbol, position.mode,
      position.entryPrice, position.enteredAt, position.initialQty,
      plan.initialStop, plan.target1, plan.target2, plan.target1Pct,
      plan.trailPct, plan.maxHours, plan.invalidation, plan.breakeven,
      plan.trailActivation
    ]);
  }

  function validClock(now) {
    return finite(now) && now > 0;
  }

  function create(input = {}, now = Date.now()) {
    const createdAt = Number(now);
    const entryPrice = Number(input.entryPrice), qty = Number(input.quantity);
    const enteredAt = Number(input.enteredAt), stop = Number(input.stop);
    const target1 = optional(input.target1), target2 = optional(input.target2);
    const trailPct = optional(input.trailPct), maxHours = optional(input.maxHours);
    const invalidation = optional(input.invalidation);
    const target1Pct = input.target1Pct == null ? 50 : Number(input.target1Pct);

    if (!validClock(createdAt)) throw new Error('زمان ایجاد طرح معتبر نیست.');
    if (!validId(input.id) ||
        typeof input.coinId !== 'string' || !COIN_ID.test(input.coinId))
      throw new Error('شناسهٔ معامله یا دارایی معتبر نیست.');
    if (!MODES.has(input.mode)) throw new Error('نوع دادهٔ معامله مشخص نیست.');
    if (!positive(entryPrice) || !positive(qty) || !positive(entryPrice * qty))
      throw new Error('قیمت ورود، تعداد و ارزش معامله باید مثبت و متناهی باشند.');
    if (!finite(enteredAt) || enteredAt <= 0 || enteredAt > createdAt)
      throw new Error('زمان ورود معتبر و غیرآینده را وارد کنید.');
    if (!positive(stop) || stop >= entryPrice)
      throw new Error('حد ضرر اولیه باید مثبت و پایین‌تر از قیمت ورود باشد.');
    if (!positive(entryPrice + (entryPrice - stop)) ||
        !finite(entryPrice + (entryPrice - stop)))
      throw new Error('مقادیر قیمت از دامنهٔ قابل محاسبه خارج‌اند.');
    if (target1 != null && (!positive(target1) || target1 <= entryPrice))
      throw new Error('هدف اول باید بالاتر از قیمت ورود باشد.');
    if (target2 != null && (!positive(target2) || target2 <= (target1 == null ? entryPrice : target1)))
      throw new Error('هدف دوم باید بالاتر از ورود و هدف اول باشد.');
    if (!positive(target1Pct) || target1Pct >= 100)
      throw new Error('سهم خروج اول باید بین صفر و صد درصد باشد.');
    if (trailPct != null && (!positive(trailPct) || trailPct >= 100))
      throw new Error('فاصلهٔ متحرک باید بین صفر و صد درصد باشد.');
    if (maxHours != null && (!positive(maxHours) ||
        !finite(enteredAt + maxHours * 3600000) || enteredAt + maxHours * 3600000 <= enteredAt))
      throw new Error('مهلت نگهداری معتبر نیست.');
    if (invalidation != null && (!positive(invalidation) || invalidation <= stop || invalidation >= entryPrice))
      throw new Error('قیمت ابطال باید بین حد ضرر و قیمت ورود باشد.');

    const position = {
      version: VERSION, id: input.id, coinId: input.coinId,
      symbol: String(input.symbol || input.coinId), mode: input.mode,
      entryPrice, enteredAt, createdAt, initialQty: qty, remainingQty: qty,
      status: 'ACTIVE', stop, stopReason: 'STOP_LOSS', highWater: entryPrice,
      target1Triggered: false, target1Completed: false, trailingActive: false,
      plan: {
        initialStop: stop, target1, target2, target1Pct, trailPct, maxHours,
        invalidation, breakeven: input.breakeven === true,
        trailActivation: entryPrice + (entryPrice - stop)
      },
      pending: null, lastQuote: null, nextEvent: 1, events: []
    };
    position.snapshot = snapshotOf(position);
    append(position, 'CREATED', createdAt, { reason: 'MONITORING_STARTED' });
    return position;
  }

  function samePlanNumber(actual, original, key) {
    return actual.plan[key] === original.plan[key];
  }

  function validLastQuote(position) {
    if (position.lastQuote == null) return true;
    const quote = position.lastQuote;
    return quote && typeof quote === 'object' && !Array.isArray(quote) &&
      quote.coinId === position.coinId && quote.source === position.mode &&
      positive(quote.price) && finite(quote.asOf) && quote.asOf >= position.enteredAt;
  }

  // Invalid persisted records are never silently converted into active positions.
  // This is deliberately stricter than merely checking status: the saved
  // snapshot is the contract that prevents a refresh or signal from rewriting
  // the original risk.
  function validPosition(position) {
    if (!position || position.version !== VERSION ||
        !['ACTIVE', 'CLOSED', 'CANCELLED'].includes(position.status)) return false;
    try {
      if (!validId(position.id) ||
          typeof position.coinId !== 'string' || !COIN_ID.test(position.coinId) ||
          !MODES.has(position.mode) || typeof position.symbol !== 'string' ||
          !position.symbol || !validClock(position.createdAt) ||
          !finite(position.enteredAt) || position.enteredAt <= 0 ||
          position.createdAt < position.enteredAt ||
          !position.plan || typeof position.plan !== 'object' || Array.isArray(position.plan)) return false;

      const plan = position.plan;
      const original = create({
        id: position.id, coinId: position.coinId, symbol: position.symbol, mode: position.mode,
        entryPrice: position.entryPrice, quantity: position.initialQty, enteredAt: position.enteredAt,
        stop: plan.initialStop, target1: plan.target1, target2: plan.target2,
        target1Pct: plan.target1Pct, trailPct: plan.trailPct, maxHours: plan.maxHours,
        invalidation: plan.invalidation, breakeven: plan.breakeven
      }, position.createdAt);

      if (position.entryPrice !== original.entryPrice ||
          position.initialQty !== original.initialQty ||
          position.enteredAt !== original.enteredAt ||
          position.createdAt !== original.createdAt ||
          position.symbol !== original.symbol ||
          !samePlanNumber(position, original, 'initialStop') ||
          !samePlanNumber(position, original, 'target1') ||
          !samePlanNumber(position, original, 'target2') ||
          !samePlanNumber(position, original, 'target1Pct') ||
          !samePlanNumber(position, original, 'trailPct') ||
          !samePlanNumber(position, original, 'maxHours') ||
          !samePlanNumber(position, original, 'invalidation') ||
          !samePlanNumber(position, original, 'trailActivation') ||
          plan.breakeven !== original.plan.breakeven ||
          !positive(position.entryPrice) || !positive(position.initialQty) ||
          position.snapshot != null && position.snapshot !== snapshotOf(position)) return false;

      if (!finite(position.remainingQty) || position.remainingQty < 0 ||
          position.remainingQty > position.initialQty + quantityTolerance(position.remainingQty, position.initialQty) ||
          !positive(position.stop) || position.stop < plan.initialStop ||
          !positive(position.highWater) || position.highWater < position.entryPrice ||
          position.stop > position.highWater || !STOP_REASONS.has(position.stopReason) ||
          typeof position.target1Triggered !== 'boolean' ||
          typeof position.target1Completed !== 'boolean' ||
          typeof position.trailingActive !== 'boolean' ||
          position.target1Completed && !position.target1Triggered ||
          (position.target1Triggered || position.target1Completed) && plan.target1 == null ||
          plan.trailPct == null && position.trailingActive ||
          position.trailingActive && plan.trailPct != null && position.highWater < plan.trailActivation ||
          position.stopReason === 'TRAILING_STOP' && (plan.trailPct == null || !position.trailingActive) ||
          position.stopReason === 'BREAKEVEN_STOP' && (!plan.breakeven || position.stop < position.entryPrice) ||
          position.stopReason === 'STOP_LOSS' && position.stop !== plan.initialStop) return false;

      if ((position.status === 'ACTIVE' && position.remainingQty <= 0) ||
          (position.status === 'CLOSED' && position.remainingQty !== 0) ||
          (position.status !== 'ACTIVE' && position.pending != null) ||
          position.status === 'CLOSED' && (!validClock(position.closedAt) || position.closedAt < position.createdAt)) return false;
      if (!validLastQuote(position)) return false;

      if (!Array.isArray(position.events) || !position.events.length ||
          !Number.isInteger(position.nextEvent) || position.nextEvent !== position.events.length + 1)
        return false;
      for (let index = 0; index < position.events.length; index++) {
        const event = position.events[index];
        if (!event || !EVENT_TYPES.has(event.type) ||
            event.id !== position.id + ':' + (index + 1) || !validClock(event.at) ||
            event.at < position.createdAt) return false;
      }
      const created = position.events[0];
      if (created.type !== 'CREATED' || created.at !== position.createdAt ||
          created.reason !== 'MONITORING_STARTED') return false;
      const hasTargetSignal = position.events.some(event => event.type === 'SIGNAL' && event.reason === 'TARGET_1');
      const hasTargetExecution = position.events.some(event => event.type === 'EXECUTION_RECORDED' && event.reason === 'TARGET_1');
      const hasTrailingRaise = position.events.some(event => event.type === 'STOP_RAISED' && event.reason === 'TRAILING_STOP');
      const hasBreakevenRaise = position.events.some(event => event.type === 'STOP_RAISED' && event.reason === 'BREAKEVEN_STOP');
      if (position.target1Triggered !== hasTargetSignal ||
          position.target1Completed && !hasTargetExecution ||
          position.stopReason === 'TRAILING_STOP' && !hasTrailingRaise ||
          position.stopReason === 'BREAKEVEN_STOP' && !hasBreakevenRaise) return false;

      if (position.pending != null) {
        const signals = position.events.filter(event => event.type === 'SIGNAL');
        const signal = signals[signals.length - 1];
        const reasons = ['INVALIDATION', 'TIME_EXIT', 'TARGET_1', 'TARGET_2'];
        if (!signal || position.pending.id !== signal.id ||
            position.pending.type !== 'SIGNAL' ||
            position.pending.action !== signal.action ||
            position.pending.reason !== signal.reason ||
            position.pending.observedPrice !== signal.observedPrice ||
            position.pending.quoteAt !== signal.quoteAt ||
            !ACTIONS.has(signal.action) ||
            !STOP_REASONS.has(signal.reason) && !reasons.includes(signal.reason) ||
            !positive(signal.quantity) || !positive(signal.observedPrice) ||
            !finite(signal.quoteAt) || signal.quoteAt < position.enteredAt ||
            !positive(position.pending.quantity) ||
            position.pending.quantity > signal.quantity + quantityTolerance(position.pending.quantity, signal.quantity) ||
            position.pending.quantity > position.remainingQty + quantityTolerance(position.pending.quantity, position.remainingQty)) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function quoteProblem(position, quote, now = Date.now()) {
    if (!validClock(Number(now))) return 'invalid-time';
    if (!quote) return 'missing';
    if (quote.status && quote.status !== 'fresh') return quote.status;
    if (quote.coinId !== position.coinId || quote.source !== position.mode) return 'source';
    if (!positive(quote.price) || !finite(quote.asOf) || quote.asOf <= 0) return 'invalid';
    if (quote.asOf > now + 60000) return 'future';
    if (now - quote.asOf > MAX_QUOTE_AGE) return 'stale';
    if (quote.asOf < position.enteredAt) return 'before-entry';
    if (position.lastQuote && quote.asOf < position.lastQuote.asOf) return 'out-of-order';
    return null;
  }

  function trigger(position, action, reason, quantity, quote, now) {
    const priority = {
      STOP_LOSS: 5, TRAILING_STOP: 5, BREAKEVEN_STOP: 5,
      INVALIDATION: 4, TIME_EXIT: 3, TARGET_2: 2, TARGET_1: 1
    };
    // An unfilled profit/time exit must not suppress a later protective stop.
    if (position.pending && priority[reason] <= (priority[position.pending.reason] ?? -Infinity)) return;
    if (position.pending) append(position, 'SUPERSEDED', now, {
      signalId: position.pending.id, reason
    });
    const event = append(position, 'SIGNAL', now, {
      action, reason, quantity, observedPrice: quote.price, quoteAt: quote.asOf,
      // This is the precise meaning of protection certainty: the configured
      // condition was met by an observed quote. It is not a forecast of what
      // price will do next and it is not an execution receipt.
      certainty: 'CONDITION_MET', conditionMet: true
    });
    position.pending = { ...event };
    return event;
  }

  function evaluate(position, quote, now = Date.now()) {
    if (!validPosition(position)) return { position, events: [], problem: 'invalid-plan' };
    const clock = Number(now);
    if (!validClock(clock) || clock < position.createdAt)
      return { position, events: [], problem: 'invalid-time' };
    if (!active(position)) return { position, events: [], problem: null };
    const problem = quoteProblem(position, quote, clock);
    if (problem) return { position, events: [], problem };

    const next = copy(position), before = next.events.length;
    // A cached/repeated observation is not a new high-water mark or price
    // trigger. The current quote is still accepted only when it is newer.
    const freshObservation = !next.lastQuote || quote.asOf > next.lastQuote.asOf;
    const observed = freshObservation ? quote : next.lastQuote;
    if (freshObservation) {
      next.lastQuote = {
        coinId: quote.coinId, price: quote.price, asOf: quote.asOf, source: quote.source
      };
      next.highWater = Math.max(next.highWater, quote.price);
      if (next.plan.trailPct != null && next.highWater >= next.plan.trailActivation) {
        next.trailingActive = true;
        const nextStop = next.highWater * (1 - next.plan.trailPct / 100);
        if (nextStop > next.stop) {
          next.stop = nextStop;
          next.stopReason = 'TRAILING_STOP';
          append(next, 'STOP_RAISED', clock, { stop: next.stop, reason: next.stopReason });
        }
      }
    }

    // Protective rules do not consult BUY/SELL labels, RSI, grades or
    // confidence. Once a configured stop is crossed, this branch wins over
    // profit targets and every advisory signal from the analysis terminal.
    if (observed.price <= next.stop) trigger(next, 'EXIT_LONG', next.stopReason, next.remainingQty, observed, clock);
    else if (next.plan.invalidation != null && observed.price <= next.plan.invalidation)
      trigger(next, 'EXIT_LONG', 'INVALIDATION', next.remainingQty, observed, clock);
    else if (next.plan.maxHours != null && clock >= next.enteredAt + next.plan.maxHours * 3600000)
      trigger(next, 'EXIT_LONG', 'TIME_EXIT', next.remainingQty, observed, clock);
    else if (next.plan.target2 != null && observed.price >= next.plan.target2)
      trigger(next, 'EXIT_LONG', 'TARGET_2', next.remainingQty, observed, clock);
    else if (!next.target1Triggered && next.plan.target1 != null && observed.price >= next.plan.target1) {
      if (trigger(next, 'REDUCE_LONG', 'TARGET_1',
          Math.min(next.remainingQty, next.initialQty * next.plan.target1Pct / 100), observed, clock))
        next.target1Triggered = true;
    }
    return { position: next, events: next.events.slice(before), problem: null };
  }

  function recordExecution(position, input = {}, now = Date.now()) {
    if (!validPosition(position) || !active(position) || !position.pending)
      throw new Error('هشدار خروج فعالی برای این معامله وجود ندارد.');
    const clock = Number(now);
    if (!validClock(clock) || clock < position.createdAt)
      throw new Error('زمان ثبت خروج معتبر نیست.');
    if (input.signalId !== position.pending.id)
      throw new Error('هشدار تغییر کرده است؛ مقدار خروج جدید را بررسی کنید.');
    const quantity = Number(input.quantity), price = Number(input.price);
    const quantityLimit = quantityTolerance(quantity, position.pending.quantity, position.remainingQty);
    if (!positive(quantity) || quantity > position.pending.quantity + quantityLimit ||
        quantity > position.remainingQty + quantityLimit)
      throw new Error('تعداد خروج باید مثبت و حداکثر به اندازهٔ مقدار هشدار باشد.');
    if (!positive(price)) throw new Error('قیمت واقعی خروج انجام‌شده را وارد کنید.');

    const next = copy(position);
    const amount = Math.min(quantity, next.pending.quantity, next.remainingQty);
    const grossPnl = (price - next.entryPrice) * amount;
    if (!finite(grossPnl)) throw new Error('سود/زیان خروج از دامنهٔ قابل محاسبه خارج است.');
    append(next, 'EXECUTION_RECORDED', clock, {
      signalId: next.pending.id, action: next.pending.action,
      reason: next.pending.reason, quantity: amount, price, grossPnl
    });
    next.remainingQty = Math.max(0, next.remainingQty - amount);
    next.pending.quantity = Math.max(0, next.pending.quantity - amount);

    if (next.remainingQty <= quantityTolerance(next.remainingQty, amount)) {
      next.remainingQty = 0;
      next.status = 'CLOSED';
      next.closedAt = clock;
      next.pending = null;
      append(next, 'CLOSED', clock, { reason: 'USER_RECORDED_EXIT' });
    } else if (next.pending.quantity <= quantityTolerance(next.pending.quantity, amount)) {
      if (next.pending.reason === 'TARGET_1') {
        next.target1Completed = true;
        if (next.plan.breakeven && next.entryPrice > next.stop) {
          next.stop = next.entryPrice;
          next.stopReason = 'BREAKEVEN_STOP';
          append(next, 'STOP_RAISED', clock, { stop: next.stop, reason: next.stopReason });
        }
      }
      next.pending = null;
    }
    return next;
  }

  function cancel(position, now = Date.now()) {
    if (!validPosition(position) || !active(position)) throw new Error('این طرح فعال نیست.');
    const clock = Number(now);
    if (!validClock(clock) || clock < position.createdAt) throw new Error('زمان توقف پایش معتبر نیست.');
    const next = copy(position);
    next.status = 'CANCELLED';
    next.pending = null;
    append(next, 'CANCELLED', clock, { reason: 'MONITORING_STOPPED_NOT_SOLD' });
    return next;
  }

  async function fetchQuotes(ids, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const clock = typeof options.now === 'function'
      ? options.now
      : () => options.now == null ? Date.now() : options.now;
    const result = {};
    const unique = [...new Set(Array.isArray(ids) ? ids : [])]
      .filter(id => typeof id === 'string' && COIN_ID.test(id) && !id.startsWith('sim-'));

    for (let start = 0; start < unique.length; start += 50) {
      const batch = unique.slice(start, start + 50);
      const params = new URLSearchParams({
        vs_currency: 'usd', ids: batch.join(','), per_page: '250', page: '1', sparkline: 'false'
      });
      const urls = options.directOnly ? [] : ['/api/proxy?src=cg&path=coins%2Fmarkets&' + params];
      urls.push('https://api.coingecko.com/api/v3/coins/markets?' + params);
      let data = null, failed = 'error';
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetcher(url, {
            signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' }
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const cacheHeader = response.headers && typeof response.headers.get === 'function'
            ? response.headers.get('X-Radar-Cache') : null;
          if ((cacheHeader || '').toUpperCase() === 'STALE') {
            failed = 'stale';
            break;
          }
          const body = await response.json();
          if (!Array.isArray(body)) throw new Error('Invalid market response');
          data = body;
          break;
        } catch (_) {
          failed = 'error';
        } finally {
          clearTimeout(timer);
        }
      }
      for (const id of batch) {
        const row = data && data.find(candidate => candidate && candidate.id === id);
        if (!row) {
          result[id] = { coinId: id, status: data ? 'missing' : failed };
          continue;
        }
        const quote = {
          coinId: id,
          price: typeof row.current_price === 'number' ? row.current_price : NaN,
          asOf: typeof row.last_updated === 'string' ? Date.parse(row.last_updated) : NaN,
          source: 'live'
        };
        const problem = quoteProblem({ coinId: id, mode: 'live', enteredAt: 0 }, quote, Number(clock()));
        result[id] = { ...quote, status: problem || 'fresh' };
      }
    }
    return result;
  }

  return Object.freeze({
    VERSION, MAX_QUOTE_AGE, create, active, validPosition, quoteProblem,
    evaluate, recordExecution, cancel, fetchQuotes
  });
});
