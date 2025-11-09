// Simple rule gates using streaming quotes (no volumes)
// Maintains per-symbol rolling window to compute EMAs and slope.

const state = new Map();
const metrics = new Map();

function getBuf(symbol) {
  if (!state.has(symbol)) state.set(symbol, []);
  return state.get(symbol);
}

function pushQuote({ symbol, price, ts }, maxLen = 600) {
  const buf = getBuf(symbol);
  buf.push({ t: new Date(ts).getTime() || Date.now(), p: Number(price) });
  if (buf.length > maxLen) buf.splice(0, buf.length - maxLen);
}

function ema(values, period) {
  if (!values || values.length === 0) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function slope(values) {
  if (!values || values.length < 2) return 0;
  const a = values[0], b = values[values.length - 1];
  return Math.sign(b - a);
}

function computeIndicators(symbol, { fast = 5, slow = 20 } = {}) {
  const buf = getBuf(symbol);
  if (buf.length < Math.max(fast, slow)) return { ready: false };
  const prices = buf.map(x => x.p);
  const fastEma = ema(prices.slice(-fast), fast);
  const slowEma = ema(prices.slice(-slow), slow);
  const fastSlope = slope(prices.slice(-fast));
  const slowSlope = slope(prices.slice(-slow));
  return {
    ready: true,
    fastEma,
    slowEma,
    fastSlope,
    slowSlope,
  };
}

function mapFutures(symbol) {
  if (symbol === 'QQQ') return 'NQ';
  if (symbol === 'SPY') return 'ES';
  return null;
}

function evaluate(symbol, side, opts = {}) {
  const { fast = 5, slow = 20, requireTrend = true, requireFutures = false, requireVWAP = false, minRVOL = 0 } = opts;
  const ind = computeIndicators(symbol, { fast, slow });
  const res = { pass: true, reasons: [], ind };
  if (!ind.ready) {
    res.pass = false; res.reasons.push('not_ready');
    return res;
  }
  if (requireTrend) {
    if (side === 'call') {
      if (!(ind.fastEma > ind.slowEma)) { res.pass = false; res.reasons.push('ema_not_bullish'); }
      if (!(ind.fastSlope > 0 && ind.slowSlope >= 0)) { res.pass = false; res.reasons.push('slope_not_up'); }
    } else {
      if (!(ind.fastEma < ind.slowEma)) { res.pass = false; res.reasons.push('ema_not_bearish'); }
      if (!(ind.fastSlope < 0 && ind.slowSlope <= 0)) { res.pass = false; res.reasons.push('slope_not_down'); }
    }
  }
  if (requireVWAP || (minRVOL && minRVOL > 0)) {
    const m = metrics.get(symbol);
    if (!m) { res.pass = false; res.reasons.push('no_bars'); }
    else {
      // VWAP side check
      if (requireVWAP) {
        const last = getBuf(symbol).slice(-1)[0]?.p;
        if (last != null && m.vwap != null) {
          const ok = side === 'call' ? (last >= m.vwap) : (last <= m.vwap);
          if (!ok) { res.pass = false; res.reasons.push('vwap_side'); }
        }
      }
      // RVOL check
      if (minRVOL && m.rvol != null) {
        if (!(m.rvol >= minRVOL)) { res.pass = false; res.reasons.push('rvol_low'); }
      }
      res.metrics = m;
    }
  }
  if (requireFutures) {
    const fut = mapFutures(symbol);
    if (fut) {
      const fi = computeIndicators(fut, { fast, slow });
      if (!fi.ready) { res.pass = false; res.reasons.push('fut_not_ready'); }
      else {
        const ok = side === 'call' ? (fi.fastSlope > 0 && fi.slowSlope >= 0) : (fi.fastSlope < 0 && fi.slowSlope <= 0);
        if (!ok) { res.pass = false; res.reasons.push('fut_disagree'); }
      }
    }
  }
  return res;
}

module.exports = {
  pushQuote,
  computeIndicators,
  evaluate,
  mapFutures,
  // metrics
  setMetrics(symbol, m) { metrics.set(symbol, m); },
  getMetrics(symbol) { return metrics.get(symbol) || null; },
};
