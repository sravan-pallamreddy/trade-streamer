function isWeekend(date) {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}

function addDays(date, days) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function businessDaysUntil(from, to) {
  // Approx: counts weekdays only (no holiday calendar)
  let days = 0;
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (cur < to) {
    if (!isWeekend(cur)) days++;
    cur = addDays(cur, 1);
  }
  return days;
}

function nextWeeklyExpiry(minBusinessDays = 2) {
  const now = new Date();
  // Find upcoming Friday (UTC)
  const day = now.getUTCDay(); // 0 Sun .. 6 Sat
  const daysToFri = (5 - day + 7) % 7 || 7; // next Friday, at least +1..+7
  let candidate = addDays(now, daysToFri);
  // Ensure at least minBusinessDays from today
  if (businessDaysUntil(now, candidate) < minBusinessDays) {
    candidate = addDays(candidate, 7);
  }
  return candidate; // Date (UTC)
}

function nextMonthlyExpiry(minBusinessDays = 2) {
  const now = new Date();
  // Find the last business day of the current month
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  // If today is after the 15th, look at next month
  if (now.getDate() > 15) {
    endOfMonth.setMonth(endOfMonth.getMonth() + 1, 0);
  }
  // Go back to Friday if not already
  while (endOfMonth.getDay() !== 5) {
    endOfMonth.setDate(endOfMonth.getDate() - 1);
  }
  return endOfMonth;
}

function next0DTEExpiry() {
  // Same day expiry - use today if market is open, otherwise next business day
  const now = new Date();
  let candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // If after 4 PM ET (21:00 UTC during DST adjustments we approximate with 20)
  if (now.getUTCHours() >= 20) {
    candidate = addDays(candidate, 1);
  }
  while (isWeekend(candidate)) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

function getExpiryByType(expiryType = 'weekly', minBusinessDays = 2) {
  switch (expiryType) {
    case '0dte':
      return next0DTEExpiry();
    case 'monthly':
      return nextMonthlyExpiry(minBusinessDays);
    case 'weekly':
    default:
      return nextWeeklyExpiry(minBusinessDays);
  }
}

function formatExpiryISO(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function roundStrike(price, increment) {
  return Math.round(price / increment) * increment;
}

function ceilStrike(price, increment) {
  if (!Number.isFinite(price)) return price;
  return Math.ceil(price / increment) * increment;
}

function floorStrike(price, increment) {
  if (!Number.isFinite(price)) return price;
  return Math.floor(price / increment) * increment;
}

const OPTION_CONFIG = {
  SPY: { multiplier: 100, strikeIncrement: 1, supports0DTE: true, defaultOTMPct: 0.004 },
  QQQ: { multiplier: 100, strikeIncrement: 1, supports0DTE: true, defaultOTMPct: 0.005 },
  AAPL: { multiplier: 100, strikeIncrement: 1, supports0DTE: false, defaultOTMPct: 0.01 },
  TSLA: { multiplier: 100, strikeIncrement: 1, supports0DTE: false, defaultOTMPct: 0.012 },
  GOOGL: { multiplier: 100, strikeIncrement: 1, supports0DTE: false, defaultOTMPct: 0.008 },
  NVDA: { multiplier: 100, strikeIncrement: 1, supports0DTE: false, defaultOTMPct: 0.01 },
  CVNA: { multiplier: 100, strikeIncrement: 1, supports0DTE: false, defaultOTMPct: 0.015 },
  HOOD: { multiplier: 100, strikeIncrement: 0.5, supports0DTE: false, defaultOTMPct: 0.02, fallbackExpiryType: 'weekly' },
};

function describeExpiryType(type) {
  switch ((type || '').toLowerCase()) {
    case '0dte':
      return '0DTE';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'custom':
      return 'Custom';
    default:
      return (type || 'Weekly').toString();
  }
}

function resolveExpiryDate({ symbol, requestedType = 'weekly', minBusinessDays = 2, expiryOverride }) {
  if (expiryOverride) {
    const overrideDate = new Date(expiryOverride);
    if (Number.isNaN(overrideDate.getTime())) {
      throw new Error(`Invalid expiry override: ${expiryOverride}`);
    }
    return {
      date: overrideDate,
      effectiveType: 'custom',
      requestedType,
      fallbackReason: null,
    };
  }

  const conf = OPTION_CONFIG[symbol] || {};
  const normalizedRequested = (requestedType || 'weekly').toString().toLowerCase();
  let effectiveType = normalizedRequested;
  let fallbackReason = null;

  if (effectiveType === '0dte' && !conf.supports0DTE) {
    fallbackReason = '0DTE expiration not available for this symbol; falling back to weekly expiry.';
    const fallback = conf.fallbackExpiryType ? conf.fallbackExpiryType.toString().toLowerCase() : 'weekly';
    effectiveType = fallback;
  }

  if (!['0dte', 'weekly', 'monthly'].includes(effectiveType)) {
    fallbackReason = `Unsupported expiry type "${effectiveType}"; defaulting to weekly expiry.`;
    effectiveType = 'weekly';
  }

  const date = getExpiryByType(effectiveType, minBusinessDays);

  return {
    date,
    effectiveType,
    requestedType: normalizedRequested,
    fallbackReason,
  };
}

// Standard normal CDF approximation
function normCdf(x) {
  // Abramowitz-Stegun approximation via erf
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  // Numerical approximation (Abramowitz-Stegun 7.1.26)
  const sign = Math.sign(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function bsOptionPrice({ S, K, T, r = 0.01, sigma = 0.2, type = 'call' }) {
  // Black-Scholes price (no dividends)
  if (T <= 0 || sigma <= 0) return Math.max(0, (type === 'call' ? S - K : K - S));
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'call') {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  } else {
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  }
}

function pickContract({ symbol, side, underlyingPrice, otmPct, minBusinessDays = 2, expiryOverride, expiryType = 'weekly' }) {
  const conf = OPTION_CONFIG[symbol];
  if (!conf) throw new Error(`Unsupported symbol for options config: ${symbol}`);
  const { strikeIncrement } = conf;

  const resolvedExpiry = resolveExpiryDate({ symbol, requestedType: expiryType, minBusinessDays, expiryOverride });
  const expiryDate = resolvedExpiry.date;
  const expiry = formatExpiryISO(expiryDate);

  const targetOtmPct = otmPct != null && Number.isFinite(otmPct)
    ? otmPct
    : (conf.defaultOTMPct != null ? conf.defaultOTMPct : 0.02);

  let strike;
  if (side === 'call') {
    const target = underlyingPrice * (1 + targetOtmPct);
    strike = ceilStrike(target, strikeIncrement);
  } else {
    const target = underlyingPrice * (1 - targetOtmPct);
    strike = floorStrike(target, strikeIncrement);
  }

  return {
    symbol,
    side,
    strike,
    expiry,
    strikeIncrement,
    multiplier: conf.multiplier,
    expiryType: resolvedExpiry.effectiveType,
    requestedExpiryType: resolvedExpiry.requestedType,
    expiryFallbackReason: resolvedExpiry.fallbackReason,
    otmPctUsed: targetOtmPct,
  };
}

function toOccString({ symbol, expiry, side, strike }) {
  // Simple readable format, not full OCC encoded ticker
  return `${symbol} ${expiry} ${strike}${side === 'call' ? 'C' : 'P'}`;
}

function buildSuggestion({
  symbol,
  direction = 'long',
  side, // 'call' | 'put'
  underlyingPrice,
  iv = 0.2,
  r = 0.01,
  otmPct,
  minBusinessDays = 2,
  expiryOverride,
  expiryType = 'weekly',
  stopLossPct = 0.5,
  takeProfitMult = 2.0,
}) {
  if (direction !== 'long') throw new Error('Only long options are supported in this MVP');

  const base = pickContract({ symbol, side, underlyingPrice, otmPct, minBusinessDays, expiryOverride, expiryType });
  const now = new Date();
  const exp = new Date(base.expiry + 'T20:00:00Z'); // approx end of day UTC
  const msToExp = Math.max(0, exp - now);
  const T = msToExp / (365 * 24 * 60 * 60 * 1000);

  const entry = bsOptionPrice({ S: underlyingPrice, K: base.strike, T, r, sigma: iv, type: side });
  const stop = Math.max(0.01, entry * (1 - stopLossPct));
  const tp = entry * (1 + takeProfitMult);

  const effectiveExpiryType = base.expiryType || expiryType;
  const expiryDesc = describeExpiryType(effectiveExpiryType);
  const requestedExpiryDesc = base.requestedExpiryType && base.requestedExpiryType !== effectiveExpiryType
    ? describeExpiryType(base.requestedExpiryType)
    : null;
  const expiryRationalePrefix = requestedExpiryDesc && requestedExpiryDesc !== expiryDesc
    ? `${expiryDesc} (requested ${requestedExpiryDesc})`
    : expiryDesc;

  return {
    symbol,
    direction,
    side,
    underlying_price: underlyingPrice,
    contract: toOccString({ symbol, expiry: base.expiry, side, strike: base.strike }),
    expiry: base.expiry,
    strike: base.strike,
    multiplier: base.multiplier,
    expiry_type: effectiveExpiryType,
    requested_expiry_type: base.requestedExpiryType,
    expiry_fallback_reason: base.expiryFallbackReason,
  target_otm_pct: base.otmPctUsed,
    est_entry: Number(entry.toFixed(2)),
    stop: Number(stop.toFixed(2)),
    take_profit: Number(tp.toFixed(2)),
    assumptions: {
      iv,
      r,
      otm_pct: otmPct,
  otm_pct_used: base.otmPctUsed,
      min_business_days: minBusinessDays,
      stop_loss_pct: stopLossPct,
      take_profit_mult: takeProfitMult,
      expiry_type: effectiveExpiryType,
      expiry_type_requested: base.requestedExpiryType,
    },
    rationale: `${expiryRationalePrefix} ${side.toUpperCase()} ~${Math.round((base.otmPctUsed ?? otmPct ?? 0) * 100)}% OTM with TP ${takeProfitMult}x and SL ${Math.round(stopLossPct * 100)}%`,
  };
}

module.exports = {
  nextWeeklyExpiry,
  pickContract,
  buildSuggestion,
};
