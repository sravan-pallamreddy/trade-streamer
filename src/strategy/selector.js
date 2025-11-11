function midPrice({ bid, ask, last }) {
  const b = Number.isFinite(bid) ? bid : null;
  const a = Number.isFinite(ask) ? ask : null;
  const l = Number.isFinite(last) ? last : null;
  if (b != null && a != null && a >= b && a > 0) return (b + a) / 2;
  if (l != null) return l;
  if (a != null) return a;
  if (b != null) return b;
  return null;
}

function pickByDelta(options, side, targetDelta = 0.3) {
  const type = side.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  const target = type === 'PUT' ? -Math.abs(targetDelta) : Math.abs(targetDelta);
  let best = null, bestDiff = Infinity;
  for (const o of options) {
    if (o.type !== type) continue;
    if (o.delta == null) continue;
    const d = o.delta;
    const diff = Math.abs(d - target);
    if (diff < bestDiff) { best = o; bestDiff = diff; }
  }
  return best;
}

function pickByPremium(options, side, targetPremium = 0.2) {
  const type = side.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  let best = null, bestDiff = Infinity;
  for (const o of options) {
    if (o.type !== type) continue;
    const m = midPrice(o);
    if (m == null) continue;
    const diff = Math.abs(m - targetPremium);
    if (diff < bestDiff) { best = o; bestDiff = diff; }
  }
  return best;
}

function pickNearestStrike(options, side, targetStrike) {
  if (!Number.isFinite(targetStrike)) return null;
  const type = side.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  let best = null;
  let bestDiff = Infinity;
  for (const opt of options) {
    if (!opt || opt.type !== type) continue;
    const strike = Number(opt.strike);
    if (!Number.isFinite(strike)) continue;
    const diff = Math.abs(strike - targetStrike);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

function selectOptimalOption(options, side, {
  targetDelta = side === 'call' ? 0.35 : -0.35,
  maxSpreadPct = 0.35,
  minOpenInterest = 50,
} = {}) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const type = side.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  let best = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    if (!opt || opt.type !== type) continue;
    const mid = midPrice(opt);
    if (mid == null || mid <= 0) continue;
    const bid = Number.isFinite(opt.bid) ? opt.bid : null;
    const ask = Number.isFinite(opt.ask) ? opt.ask : null;
    const spread = bid != null && ask != null ? Math.max(0, ask - bid) : null;
    const spreadPct = spread != null ? (spread / mid) : maxSpreadPct;
    const delta = typeof opt.delta === 'number' ? opt.delta : null;
    const oi = Number.isFinite(opt.oi) ? opt.oi : 0;
    const vol = Number.isFinite(opt.vol) ? opt.vol : 0;

    const deltaTarget = type === 'PUT' ? -Math.abs(targetDelta) : Math.abs(targetDelta);
    const deltaScore = delta == null ? 0.25 : Math.max(0, 1 - Math.abs(delta - deltaTarget) / 0.2);
    const spreadScore = Math.max(0, 1 - (spreadPct / Math.max(maxSpreadPct, 0.01)));
    const oiScore = Math.min(1, Math.log10(oi + 1) / Math.log10(minOpenInterest + 10));
    const volScore = Math.min(1, Math.log10(vol + 1) / Math.log10(1000));

    const totalScore = (deltaScore * 0.45) + (spreadScore * 0.3) + (oiScore * 0.15) + (volScore * 0.1);

    if (totalScore > bestScore) {
      bestScore = totalScore;
      best = { ...opt, _metrics: { spread, spreadPct, mid, deltaScore, spreadScore, oiScore, volScore, totalScore } };
    }
  }

  return best;
}

module.exports = {
  midPrice,
  pickByDelta,
  pickByPremium,
  pickNearestStrike,
  selectOptimalOption,
};

