// Strategy playbooks evaluate market context for different intraday approaches.
// Each evaluator returns a consistent shape so the agent and UI can reason about alignment.

function pctChange(newValue, oldValue) {
  if (!Number.isFinite(newValue) || !Number.isFinite(oldValue) || oldValue === 0) return null;
  return (newValue - oldValue) / oldValue;
}

function evaluateMomentum({ bars, indicators, price, volume, avgVolume }) {
  const reasons = [];
  const riskFlags = [];
  let score = 0;
  let bias = 'neutral';

  const close = price;
  const prevClose = bars?.length > 1 ? (Number.isFinite(bars[bars.length - 2].c) ? bars[bars.length - 2].c : Number(bars[bars.length - 2].close)) : null;
  const change1m = pctChange(close, prevClose);
  if (Number.isFinite(change1m)) {
    if (change1m > 0.003) {
      reasons.push(`Price accelerating +${(change1m * 100).toFixed(2)}% last bar`);
      score += 0.2;
    } else if (change1m < -0.003) {
      reasons.push(`Price fading ${(change1m * 100).toFixed(2)}% last bar`);
      score -= 0.2;
    }
  }

  if (indicators?.ema20 && close > indicators.ema20) {
    reasons.push('Above EMA20 intraday trendline');
    score += 0.25;
  } else if (indicators?.ema20 && close < indicators.ema20) {
    reasons.push('Below EMA20 intraday trendline');
    score -= 0.25;
  }

  if (indicators?.sma50 && close > indicators.sma50) {
    reasons.push('Holding above 50-period base');
    score += 0.15;
  } else if (indicators?.sma50 && close < indicators.sma50) {
    reasons.push('Losing the 50-period base');
    score -= 0.15;
  }

  if (Number.isFinite(volume) && Number.isFinite(avgVolume) && avgVolume > 0) {
    const volumeRatio = volume / avgVolume;
    if (volumeRatio >= 1.3) {
      reasons.push(`Volume expansion ${(volumeRatio * 100).toFixed(0)}% of average`);
      score += 0.2;
    } else if (volumeRatio <= 0.6) {
      riskFlags.push('Volume thin relative to average');
      score -= 0.1;
    }
  }

  if (indicators?.macd?.histogram != null) {
    if (indicators.macd.histogram > 0) {
      reasons.push('MACD histogram positive');
      score += 0.1;
    } else {
      reasons.push('MACD histogram negative');
      score -= 0.1;
    }
  }

  if (score > 0.15) bias = 'bullish';
  if (score < -0.15) bias = 'bearish';

  return {
    name: 'momentum',
    label: 'Momentum Trend',
    score: Number(score.toFixed(3)),
    magnitude: Math.min(Math.abs(score), 1),
    bias,
    reasons,
    riskFlags,
    inputs: {
      price,
      ema20: indicators?.ema20 ?? null,
      sma50: indicators?.sma50 ?? null,
    },
  };
}

function evaluateMeanReversion({ price, indicators }) {
  const reasons = [];
  const riskFlags = [];
  let score = 0;
  let bias = 'neutral';

  const bb = indicators?.bb;
  if (bb && Number.isFinite(bb.lower) && Number.isFinite(bb.upper)) {
    const range = bb.upper - bb.lower;
    if (range > 0) {
      const position = (price - bb.lower) / range;
      if (position < 0.1) {
        reasons.push('Price hugging lower Bollinger band');
        score += 0.35;
        bias = 'bullish';
      } else if (position > 0.9) {
        reasons.push('Price testing upper Bollinger band');
        score -= 0.35;
        bias = 'bearish';
      }
    }
  }

  if (Number.isFinite(indicators?.rsi)) {
    if (indicators.rsi < 32) {
      reasons.push(`RSI oversold ${indicators.rsi.toFixed(1)}`);
      score += 0.2;
    } else if (indicators.rsi > 68) {
      reasons.push(`RSI overbought ${indicators.rsi.toFixed(1)}`);
      score -= 0.2;
    }
  }

  const sma20 = indicators?.sma20;
  if (Number.isFinite(sma20)) {
    const deviation = pctChange(price, sma20);
    if (deviation != null) {
      if (deviation < -0.015) {
        reasons.push(`Price ${(deviation * 100).toFixed(1)}% below 20 SMA`);
        score += 0.2;
        bias = 'bullish';
      } else if (deviation > 0.015) {
        reasons.push(`Price ${(deviation * 100).toFixed(1)}% above 20 SMA`);
        score -= 0.2;
        bias = 'bearish';
      }
    }
  }

  if (score === 0) {
    riskFlags.push('No extreme deviation from mean detected');
  }

  return {
    name: 'mean_reversion',
    label: 'Mean Reversion',
    score: Number(score.toFixed(3)),
    magnitude: Math.min(Math.abs(score), 1),
    bias,
    reasons,
    riskFlags,
    inputs: {
      rsi: indicators?.rsi ?? null,
      bollinger: bb ? {
        upper: bb.upper,
        lower: bb.lower,
      } : null,
      sma20: sma20 ?? null,
    },
  };
}

function evaluateBreakout({ bars, price, indicators }) {
  const reasons = [];
  const riskFlags = [];
  let score = 0;
  let bias = 'neutral';

  if (!bars || bars.length < 40) {
    riskFlags.push('Not enough bars for breakout analysis');
    return {
      name: 'breakout',
      label: 'Breakout / Breakdown',
      score: 0,
      bias,
      reasons,
      riskFlags,
      inputs: {},
    };
  }

  const closes = bars.map((b) => Number.isFinite(b.c) ? b.c : Number(b.close));
  const highs = bars.map((b) => Number.isFinite(b.h) ? b.h : Number(b.high));
  const lows = bars.map((b) => Number.isFinite(b.l) ? b.l : Number(b.low));

  const recentHigh = Math.max(...highs.slice(-30));
  const recentLow = Math.min(...lows.slice(-30));
  const range = recentHigh - recentLow;
  if (!Number.isFinite(range) || range === 0) {
    return {
      name: 'breakout',
      label: 'Breakout / Breakdown',
      score: 0,
      bias,
      reasons,
      riskFlags: ['Unable to compute range'],
      inputs: {},
    };
  }

  const distanceFromHigh = (price - recentHigh) / range;
  const distanceFromLow = (price - recentLow) / range;

  if (distanceFromHigh > 0.05) {
    reasons.push('Price clearing recent highs');
    score += 0.35;
    bias = 'bullish';
  } else if (distanceFromHigh > -0.02 && distanceFromHigh <= 0.05) {
    reasons.push('Testing breakout zone');
    score += 0.2;
    bias = 'bullish';
  }

  if (distanceFromLow < -0.05) {
    reasons.push('Price breaking below recent lows');
    score -= 0.35;
    bias = 'bearish';
  } else if (distanceFromLow < 0.02 && distanceFromLow >= -0.05) {
    reasons.push('Testing breakdown zone');
    score -= 0.2;
    bias = 'bearish';
  }

  const atr = indicators?.atr;
  if (Number.isFinite(atr) && Number.isFinite(range) && range > 0) {
    const atrToRange = atr / range;
    if (atrToRange < 0.2) {
      riskFlags.push('Tight range, breakout may lack follow-through');
    } else if (atrToRange > 0.6) {
      reasons.push('Range expansion supports breakout move');
      score += 0.1;
    }
  }

  return {
    name: 'breakout',
    label: 'Breakout / Breakdown',
    score: Number(score.toFixed(3)),
    magnitude: Math.min(Math.abs(score), 1),
    bias,
    reasons,
    riskFlags,
    inputs: {
      recentHigh,
      recentLow,
      atr: atr ?? null,
    },
  };
}

function evaluateStrategies(payload) {
  const results = [
    evaluateMomentum(payload),
    evaluateMeanReversion(payload),
    evaluateBreakout(payload),
  ];

  const ranked = results
    .map((entry) => ({ ...entry }))
    .sort((a, b) => (b.magnitude ?? Math.abs(b.score)) - (a.magnitude ?? Math.abs(a.score)));

  const primary = ranked[0];

  return {
    all: results,
    ranked,
    primary,
  };
}

module.exports = {
  evaluateStrategies,
  evaluateMomentum,
  evaluateMeanReversion,
  evaluateBreakout,
};
