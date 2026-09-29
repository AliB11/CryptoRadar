'use strict';
/** Paper-only signal book. Never modifies real portfolio holdings or sends orders. */
const GRADES = new Set(['A+']);
const FACTORS = ['trend', 'macd', 'rsi', 'boll', 'anchor', 'stable', 'robust', 'edge'];
const LABELS = new Set(['BUY', 'BUY2', 'SELL', 'SELL2']);
const MAX_OPEN = 5;
const NOTIONAL = 100; // USD per entry, deliberately bounded
const COOLDOWN = 6 * 3600000;
const MAX_QUOTE_AGE = 5 * 60000;
const MAX_HISTORY = 2000;

function validObservation(s, now) {
  return s && typeof s.coinId === 'string' && /^[a-z0-9-]{1,80}$/.test(s.coinId) &&
    !s.coinId.startsWith('sim-') &&
    ['BUY', 'BUY2', 'SELL', 'SELL2', 'NEU', 'PRONE'].includes(s.label) &&
    ['A+', 'A', 'B+', 'B', 'C', 'D', '—'].includes(s.grade) &&
    Number.isFinite(s.observedPrice) && s.observedPrice > 0 &&
    Number.isFinite(s.observedAt) && s.observedAt > 0 &&
    s.observedAt <= now + 60000 && now - s.observedAt <= MAX_QUOTE_AGE;
}
function qualified(s) {
  return LABELS.has(s.label) && GRADES.has(s.grade) &&
    s.factors && FACTORS.every(k => s.factors[k] === true);
}
function validSignal(s, now) { return validObservation(s, now) && qualified(s); }
// Record every browser evaluation: a weaker/neutral result resets confirmation
// and cancels queued buys. Two A+ samples separated by a C are not a streak.
function observe(state, signal, now = Date.now()) {
  init(state);
  if (!validObservation(signal, now)) return { ok: false, reason: 'invalid-signal' };
  const s = {
    coinId: signal.coinId, symbol: String(signal.symbol || signal.coinId).slice(0, 20),
    label: signal.label, grade: signal.grade, observedAt: signal.observedAt,
    observedPrice: signal.observedPrice, receivedAt: now, graderVersion: 'terminal-v1',
    factors: Object.fromEntries(FACTORS.map(k => [k, signal.factors && signal.factors[k] === true]))
  };
  const prior = state.signalQueue.find(p => p.coinId === s.coinId);
  const conflict = prior && prior.observedAt === s.observedAt &&
    prior.label.startsWith('BUY') !== s.label.startsWith('BUY');
  const confirm = state.signalConfirm[s.coinId];
  if (s.observedAt < (state.signalSeen[s.coinId] || 0) || prior && prior.observedAt > s.observedAt)
    return { ok: true, queued: false };
  state.signalEvaluationAt = now;
  if (!qualified(s) || conflict) {
    if (confirm && confirm.at <= s.observedAt) delete state.signalConfirm[s.coinId];
    state.signalQueue = state.signalQueue.filter(p => p.coinId !== s.coinId || p.observedAt > s.observedAt);
    state.signalSeen[s.coinId] = Math.max(state.signalSeen[s.coinId] || 0, s.observedAt);
    return { ok: true, queued: false, reason: 'confirmation-reset' };
  }
  if (!s.label.startsWith('BUY')) delete state.signalConfirm[s.coinId];
  if (s.observedAt <= (state.signalSeen[s.coinId] || 0) || prior && prior.observedAt === s.observedAt)
    return { ok: true, queued: false };
  state.signalQueue = state.signalQueue.filter(p => p.coinId !== s.coinId && now - p.observedAt <= MAX_QUOTE_AGE);
  state.signalQueue.push(s);
  state.signalQueue = state.signalQueue.slice(-150);
  return { ok: true, queued: true };
}
function validQuote(q, now) {
  return q && q.source === 'live' && q.status === 'fresh' && Number.isFinite(q.price) && q.price > 0 &&
    Number.isFinite(q.asOf) && q.asOf <= now + 60000 && now - q.asOf <= MAX_QUOTE_AGE;
}
function init(state) {
  if (!Array.isArray(state.signalQueue)) state.signalQueue = [];
  if (!Array.isArray(state.signalPositions)) state.signalPositions = [];
  if (!Array.isArray(state.signalLedger)) state.signalLedger = [];
  if (!state.signalConfirm || typeof state.signalConfirm !== 'object') state.signalConfirm = {};
  if (!state.signalSeen || typeof state.signalSeen !== 'object') state.signalSeen = {};
  return state;
}
function fill(state, position, side, reason, price, at, signal) {
  const qty = position.quantity;
  const pnl = side === 'SELL' ? (price - position.entryPrice) * qty : null;
  const entry = {
    id: side.toLowerCase() + '-' + position.id, positionId: position.id,
    coinId: position.coinId, symbol: position.symbol, side, reason,
    price, quantity: qty, at, paper: true, mode: 'paper',
    ...(pnl == null ? {} : { grossPnl: pnl }),
    ...(signal ? { label: signal.label, grade: signal.grade } : {})
  };
  // A position has at most one entry and one exit. Keep audit bounded.
  state.signalLedger.push(entry);
  if (state.signalLedger.length > MAX_HISTORY) state.signalLedger.splice(0, state.signalLedger.length - MAX_HISTORY);
  return entry;
}
function execute(state, signal, quote, now = Date.now()) {
  init(state);
  if (!validSignal(signal, now) || !validQuote(quote, now) || quote.coinId !== signal.coinId)
    return { ok: false, reason: 'invalid-or-stale' };
  if (quote.asOf < signal.observedAt) return { ok: false, reason: 'old-quote' };
  if (Math.abs(quote.price / signal.observedPrice - 1) > 0.02) return { ok: false, reason: 'price-drift' };
  if (signal.observedAt <= (state.signalSeen[signal.coinId] || 0))
    return { ok: false, reason: 'already-seen' };
  const open = state.signalPositions.find(p => p.coinId === signal.coinId && p.status === 'OPEN');
  const buying = signal.label.startsWith('BUY');
  // Consume a valid observation once, including a skipped trade (already open,
  // capacity limit, or no position). A refresh must not replay old signals.
  state.signalSeen[signal.coinId] = signal.observedAt;
  if (buying) {
    if (open) return { ok: false, reason: 'already-open' };
    if (state.signalPositions.filter(p => p.status === 'OPEN').length >= MAX_OPEN)
      return { ok: false, reason: 'limit' };
    const recent = state.signalPositions.some(p => p.coinId === signal.coinId && now - Math.max(p.enteredAt, p.closedAt || 0) < COOLDOWN);
    if (recent) return { ok: false, reason: 'cooldown' };
    const prior = state.signalConfirm[signal.coinId];
    if (!prior || prior.side !== 'BUY' || signal.observedAt - prior.at > MAX_QUOTE_AGE ||
        (signal.receivedAt || now) - prior.receivedAt > MAX_QUOTE_AGE) {
      state.signalConfirm[signal.coinId] = { side: 'BUY', at: signal.observedAt, receivedAt: signal.receivedAt || now };
      return { ok: false, reason: 'awaiting-confirmation' };
    }
    if (signal.observedAt - prior.at < 60000) return { ok: false, reason: 'awaiting-confirmation' };
    delete state.signalConfirm[signal.coinId];
    const price = quote.price * 1.001; // pessimistic 10 bps buy slippage
    const position = {
      id: signal.coinId + '-' + prior.at, coinId: signal.coinId,
      symbol: String(signal.symbol || signal.coinId).slice(0, 20),
      status: 'OPEN', enteredAt: now, entryPrice: price,
      quantity: NOTIONAL / price, stop: price * 0.95, target: price * 1.10,
      label: signal.label, grade: signal.grade, source: 'auto-signal', paper: true,
      graderVersion: 'terminal-v1', firstObservationAt: prior.at, confirmedAt: signal.observedAt
    };
    state.signalPositions.push(position);
    // Keep only recent closed positions, but never evict an open position.
    if (state.signalPositions.length > MAX_HISTORY) {
      const i = state.signalPositions.findIndex(p => p.status === 'CLOSED');
      if (i >= 0) state.signalPositions.splice(i, 1);
    }
    return { ok: true, fill: fill(state, position, 'BUY', 'CONFIRMED_SIGNAL', price, now, signal) };
  }
  delete state.signalConfirm[signal.coinId];
  if (!open) return { ok: false, reason: 'no-open-position' };
  if (signal.observedAt <= open.enteredAt || quote.asOf <= open.enteredAt)
    return { ok: false, reason: 'before-entry' };
  return close(state, open, quote.price, now, 'OPPOSITE_SIGNAL', signal);
}
function close(state, position, observedPrice, now, reason, signal) {
  if (position.status !== 'OPEN' || !(observedPrice > 0)) return { ok: false, reason: 'already-closed' };
  const price = observedPrice * 0.999; // pessimistic 10 bps sell slippage
  delete state.signalConfirm[position.coinId];
  position.status = 'CLOSED';
  position.closedAt = now;
  position.exitReason = reason;
  return { ok: true, fill: fill(state, position, 'SELL', reason, price, now, signal) };
}
function checkStops(state, quotes, now = Date.now()) {
  init(state);
  const fills = [];
  for (const p of state.signalPositions) {
    if (p.status !== 'OPEN') continue;
    const q = quotes[p.coinId];
    if (!validQuote(q, now) || q.coinId !== p.coinId || q.asOf <= p.enteredAt) continue; // never execute on stale/simulated data
    const reason = q.price <= p.stop ? 'STOP_LOSS' : q.price >= p.target ? 'TAKE_PROFIT' : null;
    if (reason) fills.push(close(state, p, q.price, now, reason).fill);
  }
  return fills;
}
module.exports = { observe, validObservation, validSignal, execute, checkStops, init, MAX_OPEN, NOTIONAL };
