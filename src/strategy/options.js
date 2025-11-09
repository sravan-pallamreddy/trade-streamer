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
  // Same day expiry - use today if market is open
  const now = new Date();
  const hour = now.getHours();
  // If after 4 PM ET, use next day
  if (hour >= 20) { // 8 PM UTC = 4 PM ET
    return addDays(now, 1);
  }
  return now;
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
  return Math.ceil(price / increment) * increment;
}

function floorStrike(price, increment) {
  return Math.floor(price / increment) * increment;
}

const OPTION_CONFIG = {
  SPY: { multiplier: 100, strikeIncrement: 1 },
  QQQ: { multiplier: 100, strikeIncrement: 1 },
  AAPL: { multiplier: 100, strikeIncrement: 1 },
  TSLA: { multiplier: 100, strikeIncrement: 1 },
  GOOGL: { multiplier: 100, strikeIncrement: 1 },
  NVDA: { multiplier: 100, strikeIncrement: 1 },
};

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

function pickContract({ symbol, side, underlyingPrice, otmPct = 0.02, minBusinessDays = 2, expiryOverride, expiryType = 'weekly' }) {
  const conf = OPTION_CONFIG[symbol];
  if (!conf) throw new Error(`Unsupported symbol for options config: ${symbol}`);
  const { strikeIncrement } = conf;

  const expiryDate = expiryOverride ? new Date(expiryOverride) : getExpiryByType(expiryType, minBusinessDays);
  const expiry = formatExpiryISO(expiryDate);

  let strike;
  if (side === 'call') {
    const target = underlyingPrice * (1 + otmPct);
    strike = ceilStrike(target, strikeIncrement);
  } else {
    const target = underlyingPrice * (1 - otmPct);
    strike = floorStrike(target, strikeIncrement);
  }

  return { symbol, side, strike, expiry, strikeIncrement, multiplier: conf.multiplier };
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
  otmPct = 0.02,
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

  const expiryDesc = expiryType === '0dte' ? '0DTE' : expiryType === 'monthly' ? 'Monthly' : 'Weekly';

  return {
    symbol,
    direction,
    side,
    underlying_price: underlyingPrice,
    contract: toOccString({ symbol, expiry: base.expiry, side, strike: base.strike }),
    expiry: base.expiry,
    strike: base.strike,
    multiplier: base.multiplier,
    est_entry: Number(entry.toFixed(2)),
    stop: Number(stop.toFixed(2)),
    take_profit: Number(tp.toFixed(2)),
    assumptions: {
      iv,
      r,
      otm_pct: otmPct,
      min_business_days: minBusinessDays,
      stop_loss_pct: stopLossPct,
      take_profit_mult: takeProfitMult,
      expiry_type: expiryType,
    },
    rationale: `${expiryDesc} ${side.toUpperCase()} ~${Math.round(otmPct * 100)}% OTM with TP ${takeProfitMult}x and SL ${Math.round(stopLossPct * 100)}%`,
  };
}

module.exports = {
  nextWeeklyExpiry,
  pickContract,
  buildSuggestion,
};

