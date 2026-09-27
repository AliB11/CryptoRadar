/* Momentum watchlist screener.
   Advisory only: never an order, never a buy-at-market signal.
   Independent of the terminal BUY/RSI score — that score is mean-reversion
   tilted and would systematically reject the 10–50% band this screen exists for.
   CoinGecko markets data has no wallet-level whale flow. Smart-money here is a
   labeled price-structure proxy. Fear & Greed is recorded and then ignored. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarMomentum = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const THRESHOLDS = Object.freeze({
    minVolumeUsd: 40e6,
    minChangePct: 10,
    maxChangePct: 50,
    minHistoryDays: 30,
    washTurnover: 2.5,
    washMcapUsd: 5e9,
    attentionTurnover: 1.2,
    attentionMcapUsd: 5e8,
    printMismatchPct: 12,
    youngDays: 60,
    youngMcapUsd: 3e8
  });
  const SYMBOL = /^[A-Za-z0-9.\-]{1,20}$/;
  const VERDICT = {
    approve: 'تأیید برای واچ‌لیست',
    'reject-fomo': 'رد به دلیل فومو',
    'reject-filter': 'رد — فیلتر سخت'
  };
  const RISK = {
    low: 'کم',
    medium: 'متوسط',
    high: 'بالا',
    exit: 'خطر نقدینگی خروج'
  };
  const NEXT_RISK = { low: 'medium', medium: 'high', high: 'exit', exit: 'exit' };

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const num = value => {
    if (value == null || value === '') return null;
    const raw = typeof value === 'string' ? value.replace(/%/g, '').replace(/,/g, '').trim() : value;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const usd = value => {
    if (!finite(value)) return '—';
    const sign = value < 0 ? '-' : '';
    const a = Math.abs(value);
    const body = a >= 1e12 ? (a / 1e12).toFixed(2) + 'T'
      : a >= 1e9 ? (a / 1e9).toFixed(2) + 'B'
      : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M'
      : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K'
      : a.toFixed(0);
    return sign + '$' + body;
  };
  const px = value => {
    if (!finite(value) || value <= 0) return '—';
    if (value >= 1000) return '$' + value.toFixed(2);
    if (value >= 1) return '$' + value.toFixed(4);
    if (value >= 0.0001) return '$' + value.toFixed(6);
    return '$' + value.toExponential(2);
  };
  const pct = (value, digits) => (value > 0 ? '+' : '') + value.toFixed(digits == null ? 2 : digits) + '%';
  const filter = (pass, code, text, extra) => ({ pass: !!pass, code, text, ...(extra || {}) });

  function rsi(prices, period) {
    if (!prices || prices.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = prices[i] - prices[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / period, avgL = loss / period;
    for (let i = period + 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
      avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgL === 0) return avgG === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  function ema(prices, period) {
    if (!prices || prices.length < period) return null;
    const k = 2 / (period + 1);
    let e = 0;
    for (let i = 0; i < period; i++) e += prices[i];
    e /= period;
    for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
    return e;
  }

  function std(values) {
    if (!values || values.length < 2) return 0;
    const m = values.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
  }

  function invalid(error) {
    return { ok: false, version: VERSION, error };
  }

  function ageOf(input, now) {
    let days = null;
    let source = 'unknown';
    const declared = num(input.historyDays);
    if (declared != null && declared >= 0 && declared <= 20000) {
      days = declared;
      source = input.ageAssumed ? 'assumed-simulation' : 'declared';
    }
    const stamps = [];
    for (const key of ['listedAt', 'atlDate']) {
      if (input[key] == null || input[key] === '') continue;
      const t = typeof input[key] === 'number' ? input[key] : Date.parse(input[key]);
      if (finite(t) && t > 0 && t <= now) stamps.push(t);
    }
    if (stamps.length) {
      const fromStamp = (now - Math.min(...stamps)) / 86400000;
      if (days == null || fromStamp > days) {
        days = fromStamp;
        source = input.listedAt != null && Date.parse(input.listedAt) === Math.min(...stamps) ? 'listed' : 'atl';
      }
    }
    const floors = [['ch1y', 365, 'change1y'], ['ch200d', 200, 'change200'], ['ch30d', 30, 'change30']];
    for (const [key, floor, label] of floors) {
      if (num(input[key]) == null) continue;
      if (days == null || days < floor) {
        days = Math.max(days || 0, floor);
        source = label;
      }
    }
    return { days, source };
  }

  function environmentOf(context) {
    const ctx = context || {};
    const btc = ctx.btc && typeof ctx.btc === 'object' ? ctx.btc : null;
    const btcCh24 = btc ? num(btc.ch24) : null;
    const btcScore = btc ? num(btc.score) : null;
    const dominance = num(ctx.dominance);
    const marketCh24 = num(ctx.marketCh24);
    const domDelta = btcCh24 != null && marketCh24 != null ? btcCh24 - marketCh24 : null;
    let stance = 'unknown';
    if (btc && (btcCh24 != null || btcScore != null)) {
      const hostile = (btcScore != null && btcScore <= -25) ||
        (btcCh24 != null && btcCh24 <= -3) ||
        (domDelta != null && domDelta >= 1.5 && btcCh24 != null && btcCh24 < 0);
      const supportive = btcScore != null && btcScore >= 15 &&
        btcCh24 != null && btcCh24 > -1 &&
        !(domDelta != null && domDelta >= 1.2);
      stance = hostile ? 'hostile' : supportive ? 'supportive' : 'neutral';
    }
    const fng = num(ctx.fearGreed);
    return {
      stance,
      btcCh24,
      btcScore,
      dominance,
      marketCh24,
      domDelta,
      fearGreed: fng,
      fearGreedIgnored: true,
      text: envText(stance, btcCh24, btcScore, dominance, domDelta, fng)
    };
  }

  function envText(stance, btcCh24, btcScore, dominance, domDelta, fng) {
    const stanceFa = { supportive: 'حمایتی', hostile: 'خصمانه', neutral: 'خنثی', unknown: 'نامشخص' }[stance];
    const btc = btcCh24 == null ? 'تغییر ۲۴س بیت‌کوین نامشخص' : 'بیت‌کوین ' + pct(btcCh24, 2);
    const score = btcScore == null ? '' : ' · امتیاز لنگر ' + (btcScore > 0 ? '+' : '') + Math.round(btcScore);
    const dom = dominance == null ? '' : ' · دامیننس ' + dominance.toFixed(1) + '%';
    const delta = domDelta == null ? '' : ' · اختلاف بیت‌کوین با بازار ' + pct(domDelta, 2) +
      (domDelta >= 0 ? ' (پروکسی افزایش دامیننس)' : ' (پروکسی کاهش دامیننس)');
    const poll = fng == null ? '' : ' · ترس‌وطمع ' + Math.round(fng) + ' نادیده گرفته شد';
    return 'محیط ' + stanceFa + ': ' + btc + score + dom + delta + poll + '.';
  }

  function structureOf(input, price, ch24) {
    const prices = Array.isArray(input.prices)
      ? input.prices.filter(v => typeof v === 'number' && v > 0 && Number.isFinite(v))
      : [];
    const n = prices.length;
    const out = {
      candles: n >= 48,
      bars: n,
      rsi: n >= 15 ? rsi(prices, 14) : null,
      ema12: n >= 12 ? ema(prices, 12) : null,
      ema26: n >= 26 ? ema(prices, 26) : null,
      atrPct: null,
      rangePos: null,
      extensionEma: null,
      priorHigh: null,
      priorLow: null,
      brokeOut: false,
      held: false,
      rejection: input.chartStatus === 'rejection',
      climax: false,
      extended: input.chartStatus === 'extended',
      swingLow: null,
      high24: null,
      low24: null,
      smartMoney: 'unavailable',
      breakoutValid: false,
      turnover: null
    };
    if (n >= 25) {
      const rets = [];
      for (let i = n - 24; i < n; i++) rets.push(prices[i] / prices[i - 1] - 1);
      out.atrPct = std(rets) * Math.sqrt(24);
    }
    const day = n ? prices.slice(-24) : [];
    let high24 = num(input.high24);
    let low24 = num(input.low24);
    if (!(high24 > 0)) high24 = day.length ? Math.max(...day) : null;
    if (!(low24 > 0)) low24 = day.length ? Math.min(...day) : null;
    if (high24 != null && price > high24) high24 = price;
    if (low24 != null && price < low24) low24 = price;
    out.high24 = high24;
    out.low24 = low24;
    if (high24 != null && low24 != null && high24 > low24) out.rangePos = (price - low24) / (high24 - low24);
    if (out.ema26) out.extensionEma = price / out.ema26 - 1;
    if (n >= 48) {
      const prior = prices.slice(-72, -24);
      if (prior.length) {
        out.priorHigh = Math.max(...prior);
        out.priorLow = Math.min(...prior);
        out.brokeOut = price > out.priorHigh * 1.005;
        out.held = price > out.priorHigh * 0.985;
      }
      const swing = prices.slice(-36, -6);
      if (swing.length) out.swingLow = Math.min(...swing);
      const recentLow = Math.min(...prices.slice(-24));
      const older = prices.slice(-72, -24);
      const higherLows = older.length ? recentLow > Math.min(...older) * 1.005 : false;
      const distributing = out.rejection ||
        (out.rsi != null && out.rsi >= 75 && out.rangePos != null && out.rangePos > 0.85) ||
        (out.extensionEma != null && out.extensionEma > 0.12 && out.rangePos != null && out.rangePos > 0.88);
      const accumulating = higherLows && out.rangePos != null && out.rangePos >= 0.55 &&
        out.rsi != null && out.rsi >= 48 && out.rsi <= 68 && !out.rejection &&
        ch24 >= THRESHOLDS.minChangePct && ch24 <= THRESHOLDS.maxChangePct;
      out.smartMoney = distributing ? 'distribution' : accumulating ? 'accumulation' : 'unavailable';
    }
    if (!out.rejection && out.rangePos != null && out.rangePos < 0.42 && ch24 >= 8) out.rejection = true;
    const mcap = num(input.mcap);
    const vol = num(input.vol24);
    out.turnover = mcap > 0 && vol != null ? vol / mcap : null;
    out.climax = !!(out.turnover != null && out.turnover >= 0.85 && ch24 >= 28 &&
      (out.rsi == null || out.rsi >= 68) && mcap != null && mcap < 8e9);
    if ((out.rsi != null && out.rsi >= 72) ||
        (out.extensionEma != null && out.extensionEma > 0.08) ||
        (out.rangePos != null && out.rangePos > 0.9 && ch24 >= 18)) out.extended = true;
    out.breakoutValid = !!(out.brokeOut && out.held && !out.rejection &&
      out.rangePos != null && out.rangePos >= 0.5 &&
      ch24 >= THRESHOLDS.minChangePct && ch24 <= THRESHOLDS.maxChangePct);
    return out;
  }

  function planOf(price, ch24, structure) {
    const atr = clamp(
      structure.atrPct != null && structure.atrPct > 0 ? structure.atrPct : Math.abs(ch24) / 100 * 0.45,
      0.03, 0.12
    );
    let entry = null;
    let anchor = 'measured-pullback';
    if (structure.brokeOut && structure.priorHigh && structure.priorHigh < price * 0.995 && structure.priorHigh > price * 0.8) {
      entry = structure.priorHigh;
      anchor = 'breakout-retest';
    } else if (structure.ema12 && structure.ema12 < price * 0.995 && structure.ema12 > price * 0.85) {
      entry = structure.ema12;
      anchor = 'ema12';
    } else {
      entry = price * (1 - Math.max(0.03, atr * 0.8));
    }
    const chasingHigh = (structure.high24 != null && price >= structure.high24 * 0.985) ||
      (structure.rangePos != null && structure.rangePos > 0.9);
    if (!(entry < price)) entry = price * (chasingHigh ? 0.97 : 0.985);
    let stop = null;
    if (structure.swingLow && structure.swingLow < entry) {
      const dist = (entry - structure.swingLow * 0.995) / entry;
      if (dist >= 0.025 && dist <= 0.12) stop = structure.swingLow * 0.995;
    }
    if (stop == null) stop = entry * (1 - clamp(atr * 1.15, 0.028, 0.12));
    let dist = (entry - stop) / entry;
    if (!(stop < entry) || dist < 0.025 || dist > 0.12) {
      dist = clamp(atr, 0.028, 0.12);
      stop = entry * (1 - dist);
    }
    const risk = entry - stop;
    const tp1 = entry + risk;
    const tp2 = entry + 2.2 * risk;
    const inZone = !chasingHigh && price <= entry * 1.015 && price >= entry * 0.99;
    if (inZone) entry = Math.min(entry, price);
    const riskPct = (entry - stop) / entry * 100;
    const rawSize = 100 / riskPct;
    const size = Math.min(rawSize, 25);
    const mode = inZone ? 'zone-active' : 'wait-pullback';
    const text = (mode === 'zone-active'
      ? 'قیمت به ناحیهٔ پولبک رسیده؛ باز هم خرید مارکت در سقف روز ممنوع است. '
      : 'ورود مارکت در سقف ممنوع. فقط پولبک به ' + px(entry) + '. ') +
      'حد ضرر ' + px(stop) + ' (' + pct(-riskPct, 1) + ' از ورود). ' +
      'هدف اول ' + px(tp1) + ' (۱R، خروج بخشی) و هدف دوم ' + px(tp2) + ' (۲٫۲R). ' +
      'با ریسک ۱٪ سرمایه، اندازهٔ خام ' + rawSize.toFixed(1) + '% است' +
      (rawSize > 25 ? '؛ سقف محافظه‌کارانه ۲۵٪ اعمال شد.' : '.');
    return {
      entry, stop, tp1, tp2, riskPct, rr1: 1, rr2: 2.2, anchor, mode,
      marketAtHighForbidden: true, chasingHigh, sizePct: size, rawSizePct: rawSize, text,
      actionable: false
    };
  }

  function fakeBoostOf(input, ch24, ageDays, vol, mcap) {
    const reasons = [];
    const turnover = mcap > 0 ? vol / mcap : null;
    if (input.boosted === true) {
      reasons.push(filter(false, 'EXPLICIT_BOOST', 'ورودی، بوست یا ترند تبلیغاتی را اعلام کرده است — بدون اتکا به نظرسنجی عمومی رد می‌شود.'));
    }
    const thinAttention = !(vol >= THRESHOLDS.minVolumeUsd &&
      (ageDays == null || ageDays >= THRESHOLDS.minHistoryDays) &&
      !(turnover != null && turnover > THRESHOLDS.attentionTurnover && mcap < THRESHOLDS.attentionMcapUsd));
    if (input.trending === true && thinAttention) {
      reasons.push(filter(false, 'ATTENTION_WITHOUT_DEPTH',
        'در جست‌وجوهای داغ هست اما عمق یا سابقهٔ هم‌خوان ندارد' +
        (turnover == null ? '' : ' (گردش حجم ' + turnover.toFixed(2) + ')') + '.'));
    }
    if (turnover != null && turnover > THRESHOLDS.washTurnover && mcap < THRESHOLDS.washMcapUsd) {
      reasons.push(filter(false, 'WASH_TURNOVER',
        'گردش حجم ' + turnover.toFixed(2) + ' برابر ارزش بازار ' + usd(mcap) +
        ' است؛ آستانهٔ مشکوک ' + THRESHOLDS.washTurnover.toFixed(1) + ' برای ارزش زیر ' + usd(THRESHOLDS.washMcapUsd) + '.'));
    }
    const path = num(input.sparkCh24);
    if (path != null && Math.abs(ch24 - path) > THRESHOLDS.printMismatchPct) {
      reasons.push(filter(false, 'PRINT_MISMATCH',
        'چاپ ۲۴ساعته ' + pct(ch24, 2) + ' با مسیر ساعتی ' + pct(path, 2) +
        ' بیش از ' + THRESHOLDS.printMismatchPct + ' واحد اختلاف دارد.'));
    }
    if (!reasons.length) {
      return filter(true, 'BOOST_OK',
        'بوست جعلی دیده نشد' + (turnover == null ? '؛ گردش حجم به‌خاطر نبود ارزش بازار سنجیده نشد.' :
          '؛ گردش حجم ' + turnover.toFixed(2) + ' است.') +
        (input.trending ? ' حضور در جست‌وجوی داغ با عمق کافی، به‌تنهایی بوست جعلی نیست.' : ''),
        { turnover, reasons: [] });
    }
    return { pass: false, code: reasons[0].code, text: reasons.map(r => r.text).join(' '), turnover, reasons };
  }

  function screen(input, context) {
    const src = input && typeof input === 'object' ? input : {};
    const symbol = String(src.symbol || src.sym || '').trim().toUpperCase();
    if (!SYMBOL.test(symbol)) return invalid('نماد معتبر نیست.');
    const price = num(src.price);
    const ch24 = num(src.ch24 != null ? src.ch24 : src.change24);
    const vol = num(src.vol24 != null ? src.vol24 : src.volume24);
    if (!(price > 0) || price > 1e12) return invalid('قیمت فعلی باید مثبت و متناهی باشد.');
    if (ch24 == null || ch24 < -99.9 || ch24 > 5000) return invalid('رشد ۲۴ساعته معتبر نیست.');
    if (vol == null || vol < 0 || vol > 1e15) return invalid('حجم ۲۴ساعته معتبر نیست.');
    const now = num(context && context.now) != null && num(context.now) > 0 ? num(context.now) : Date.now();
    const source = src.source === 'live' || src.source === 'simulation' ? src.source : 'manual';
    const mcap = num(src.mcap);
    const age = ageOf(src, now);
    const env = environmentOf(context);
    const structure = structureOf(src, price, ch24);

    const history = age.days == null
      ? filter(false, 'HISTORY_UNKNOWN', 'سابقهٔ معاملاتی اثبات نشد. اسپارک‌لاین ۷روزه برای حداقل ۱ ماه کافی نیست و سن نامعلوم رد می‌شود.')
      : age.days + 1e-9 >= THRESHOLDS.minHistoryDays
        ? filter(true, 'HISTORY_OK', 'سابقه ' + age.days.toFixed(0) + ' روز ≥ ' + THRESHOLDS.minHistoryDays + ' روز (' + ageLabel(age.source) + ').')
        : filter(false, 'HISTORY_SHORT', 'سابقه ' + age.days.toFixed(1) + ' روز < حداقل ' + THRESHOLDS.minHistoryDays + ' روز.');
    const liquidity = vol >= THRESHOLDS.minVolumeUsd
      ? filter(true, 'VOL_OK', 'حجم ۲۴ساعته ' + usd(vol) + ' ≥ حداقل ' + usd(THRESHOLDS.minVolumeUsd) + ' — قبول.')
      : filter(false, 'VOL_LOW', 'حجم ۲۴ساعته ' + usd(vol) + ' < حداقل ' + usd(THRESHOLDS.minVolumeUsd) + ' — رد.');
    const momentum = ch24 + 1e-9 >= THRESHOLDS.minChangePct && ch24 - 1e-9 <= THRESHOLDS.maxChangePct
      ? filter(true, 'BAND_OK', 'رشد ۲۴ساعته ' + pct(ch24, 2) + ' داخل باند ' + THRESHOLDS.minChangePct + '% تا ' + THRESHOLDS.maxChangePct + '% — قبول.')
      : ch24 > THRESHOLDS.maxChangePct
        ? filter(false, 'BAND_HIGH', 'رشد ۲۴ساعته ' + pct(ch24, 2) + ' بالای سقف ' + THRESHOLDS.maxChangePct + '% است — خارج از چارچوب و در محدودهٔ تعقیب.')
        : filter(false, 'BAND_LOW', 'رشد ۲۴ساعته ' + pct(ch24, 2) + ' پایین‌تر از کف ' + THRESHOLDS.minChangePct + '% است — هنوز مومنتوم هدف این غربال نیست.');
    const boost = fakeBoostOf(src, ch24, age.days, vol, mcap);
    const instrument = src.leveraged === true
      ? filter(false, 'LEVERAGED', 'ابزار اهرمی است و پروژهٔ نقدشوندهٔ این چارچوب محسوب نمی‌شود.')
      : filter(true, 'INSTRUMENT_OK', 'ابزار اهرمی شناسایی نشد.');
    const hardPass = history.pass && liquidity.pass && momentum.pass && boost.pass && instrument.pass;

    const plan = planOf(price, ch24, structure);
    const warnings = [];
    if (source === 'simulation') warnings.push({ code: 'SIMULATION', text: 'دادهٔ شبیه‌سازی است؛ این حکم بازار زنده نیست.' });
    if (age.source === 'declared') warnings.push({ code: 'AGE_DECLARED', text: 'سن پروژه از ورودی شماست، نه از تاریخ فهرست بازار.' });
    if (age.source === 'assumed-simulation') warnings.push({ code: 'AGE_ASSUMED', text: 'در حالت آفلاین سن پروژه‌های شبیه‌سازی فرض شده است.' });
    if (!structure.candles) warnings.push({ code: 'THIN_PATH', text: 'مسیر ساعتی کافی نیست؛ شکست یا تله فقط از اعداد اعلام‌شده استنباط نمی‌شود.' });
    if (src.chartStatus === 'breakout' || src.chartStatus === 'pullback') warnings.push({ code: 'CHART_LABEL', text: 'برچسب چارت به‌تنهایی شکست یا پولبک را تأیید نمی‌کند؛ اگر مسیر قیمت نباشد، اعداد اعلام‌شده مقدم‌اند.' });
    if (structure.smartMoney === 'unavailable') warnings.push({ code: 'SMART_UNAVAILABLE', text: 'شواهد ورود پول هوشمند در سطح کیف‌پول موجود نیست و پروکسی ساختاری انباشت هم تأیید نشد.' });
    if (structure.smartMoney === 'distribution') warnings.push({ code: 'SMART_DISTRIBUTION', text: 'ساختار قیمت به توزیع / عرضه در سقف شبیه‌تر است تا انباشت. این جریان ولت نهنگ نیست.' });
    if (structure.smartMoney === 'accumulation') warnings.push({ code: 'SMART_PROXY', text: 'فقط پروکسی ساختاری انباشت (کف بالاتر و نگهداری شکست) دیده شد؛ inflow کیف‌پول تأیید نشده است.' });
    warnings.push({ code: 'FNG_IGNORED', text: 'شاخص ترس و طمع در قبول یا رد این حکم استفاده نشد.' });

    let risk = 'low';
    const bump = () => { risk = NEXT_RISK[risk]; };
    // Extended and distribution describe the same chase. Count that story once.
    // Exit-liquidity is a failed hold or a volume climax, not merely a close near the high.
    if (!structure.candles) bump();
    else if (structure.smartMoney !== 'accumulation') bump();
    if (structure.extended && structure.smartMoney !== 'distribution') bump();
    if (env.stance === 'hostile' || env.stance === 'unknown') bump();
    if (age.days != null && age.days < THRESHOLDS.youngDays && mcap != null && mcap < THRESHOLDS.youngMcapUsd) bump();
    if (source === 'simulation') bump();
    if (structure.rejection || structure.climax || ch24 > THRESHOLDS.maxChangePct || !boost.pass) risk = 'exit';
    if (!hardPass && risk === 'low') risk = 'medium';

    const fomo = !boost.pass || ch24 > THRESHOLDS.maxChangePct || risk === 'exit' ||
      structure.rejection || structure.climax || !instrument.pass && ch24 >= THRESHOLDS.minChangePct;
    let verdict = 'reject-filter';
    if (hardPass && risk !== 'exit' && plan.stop < plan.entry && plan.entry < plan.tp1) verdict = 'approve';
    else if (fomo) verdict = 'reject-fomo';
    plan.actionable = verdict === 'approve';

    const reasons = [history, liquidity, momentum, boost, instrument].map(f => ({
      code: f.code, pass: f.pass, text: f.text
    }));
    if (structure.rejection) reasons.push({ code: 'REJECTION', pass: false, text: 'بسته شدن در بخش پایینی دامنهٔ ۲۴ساعته یا وضعیت چارتی «پس‌زدن»؛ رشد فعلی تلهٔ نقدینگی خروج است نه شکست معتبر.' });
    else if (structure.breakoutValid) reasons.push({ code: 'BREAKOUT', pass: true, text: 'قیمت بالای سقف بازهٔ پیش از ۲۴ساعت مانده و دامنه را پس نزده است. ورود همچنان روی پولبک است، نه روی سقف.' });
    else reasons.push({ code: 'NO_BREAKOUT', pass: false, text: 'شکست معتبر با نگهداری سطح، از مسیر موجود تأیید نشد. اگر فیلترها قبول شوند فقط به‌عنوان دیده‌بان پولبک، نه ورود مارکت.' });

    return {
      ok: true,
      version: VERSION,
      id: typeof src.id === 'string' ? src.id : null,
      symbol,
      name: typeof src.name === 'string' && src.name ? src.name.slice(0, 80) : symbol,
      source,
      quote: {
        price, ch24, vol24: vol, mcap, ageDays: age.days, ageSource: age.source,
        high24: structure.high24, low24: structure.low24
      },
      filters: {
        history, liquidity, momentum, fakeBoost: {
          pass: boost.pass, code: boost.code, text: boost.text, turnover: boost.turnover, reasons: boost.reasons || []
        },
        instrument
      },
      hardPass,
      structure: {
        candles: structure.candles,
        bars: structure.bars,
        rsi: structure.rsi,
        rangePos: structure.rangePos,
        extensionEma: structure.extensionEma,
        priorHigh: structure.priorHigh,
        brokeOut: structure.brokeOut,
        held: structure.held,
        rejection: structure.rejection,
        climax: structure.climax,
        extended: structure.extended,
        breakoutValid: structure.breakoutValid,
        smartMoney: structure.smartMoney,
        turnover: structure.turnover,
        atrPct: structure.atrPct
      },
      environment: env,
      plan,
      risk,
      riskLabel: RISK[risk],
      verdict,
      verdictLabel: VERDICT[verdict],
      reasons,
      warnings
    };
  }

  function ageLabel(source) {
    return {
      declared: 'سن اعلام‌شده',
      'assumed-simulation': 'فرض شبیه‌سازی',
      listed: 'تاریخ فهرست',
      atl: 'حد پایین از تاریخ کف تاریخی',
      change30: 'وجود بازده ۳۰روزه',
      change200: 'وجود بازده ۲۰۰روزه',
      change1y: 'وجود بازده یک‌ساله',
      unknown: 'نامشخص'
    }[source] || source;
  }

  function proximity(row) {
    let score = 0;
    if (row.filters.history.pass) score += 3;
    if (row.filters.liquidity.pass) score += 3;
    if (row.filters.fakeBoost.pass) score += 2;
    if (row.filters.instrument.pass) score += 1;
    if (row.filters.momentum.pass) score += 2;
    const ch = row.quote.ch24;
    if (ch != null) score += Math.max(0, 1.5 - Math.min(Math.abs(ch - 20), 40) / 20);
    return score;
  }

  function screenAll(list, context) {
    const rows = [];
    let invalidCount = 0;
    for (const coin of list || []) {
      const row = screen(coin, context);
      if (!row.ok) invalidCount++;
      else rows.push(row);
    }
    const rank = { low: 0, medium: 1, high: 2, exit: 3 };
    const approved = rows.filter(r => r.verdict === 'approve')
      .sort((a, b) => rank[a.risk] - rank[b.risk] || b.quote.vol24 - a.quote.vol24);
    const fomo = rows.filter(r => r.verdict === 'reject-fomo')
      .sort((a, b) => b.quote.vol24 - a.quote.vol24);
    const filtered = rows.filter(r => r.verdict === 'reject-filter');
    const nearMisses = filtered.filter(r =>
      [r.filters.history, r.filters.liquidity, r.filters.momentum, r.filters.fakeBoost, r.filters.instrument]
        .filter(f => f.pass).length >= 2)
      .sort((a, b) => proximity(b) - proximity(a) || b.quote.vol24 - a.quote.vol24)
      .slice(0, 8);
    const countFail = code => rows.filter(r => !r.filters[code].pass).length;
    return {
      version: VERSION,
      scanned: rows.length,
      invalid: invalidCount,
      approved,
      fomo,
      nearMisses,
      environment: environmentOf(context),
      counts: {
        scanned: rows.length,
        approved: approved.length,
        fomo: fomo.length,
        filter: filtered.length,
        failHistory: countFail('history'),
        failLiquidity: countFail('liquidity'),
        failMomentum: countFail('momentum'),
        failBoost: countFail('fakeBoost'),
        failInstrument: countFail('instrument'),
        low: approved.filter(r => r.risk === 'low').length,
        medium: approved.filter(r => r.risk === 'medium').length,
        high: approved.filter(r => r.risk === 'high').length
      }
    };
  }

  return {
    VERSION, THRESHOLDS, VERDICT, RISK,
    screen, screenAll, environmentOf, rsi, ema
  };
});
