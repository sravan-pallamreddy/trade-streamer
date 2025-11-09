// Trading algorithms for day trading and swing trading strategies
const { calculateIndicators } = require('./indicators');

function analyzeDayTradeSignals(bars, indicators, currentPrice) {
  if (!indicators || !bars || bars.length < 20) return { signals: [], strength: 0 };

  const signals = [];
  let strength = 0;

  // Momentum signals
  if (indicators.rsi > 70) {
    signals.push('overbought');
    strength -= 0.3;
  } else if (indicators.rsi < 30) {
    signals.push('oversold');
    strength += 0.3;
  }

  // MACD signals
  if (indicators.macd && indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
    signals.push('macd_bullish');
    strength += 0.2;
  } else if (indicators.macd && indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
    signals.push('macd_bearish');
    strength -= 0.2;
  }

  // Bollinger Band signals
  if (indicators.bb) {
    const bbPos = (currentPrice - indicators.bb.lower) / (indicators.bb.upper - indicators.bb.lower);
    if (bbPos > 0.8) {
      signals.push('bb_upper_breakout');
      strength += 0.2;
    } else if (bbPos < 0.2) {
      signals.push('bb_lower_breakout');
      strength -= 0.2;
    }
  }

  // Volume analysis
  if (indicators.avgVolume && indicators.volume > indicators.avgVolume * 1.5) {
    signals.push('high_volume');
    strength += 0.1;
  }

  // Simple support/resistance zones using recent lows/highs
  const recentBars = bars.slice(-30);
  if (recentBars.length >= 5) {
    const lows = recentBars.map(b => Number.isFinite(b.l) ? b.l : Number(b.low ?? b.c)).filter(Number.isFinite);
    const highs = recentBars.map(b => Number.isFinite(b.h) ? b.h : Number(b.high ?? b.c)).filter(Number.isFinite);
    const closes = recentBars.map(b => Number.isFinite(b.c) ? b.c : Number(b.close ?? b.h ?? b.l)).filter(Number.isFinite);
    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : undefined;

    if (lows.length > 0) {
      const support = Math.min(...lows);
      const diff = currentPrice - support;
      if (diff >= 0) {
        const proximity = support > 0 ? diff / support : Infinity;
        if (proximity <= 0.004) {
          signals.push('near_support');
          strength += 0.15;
          if (prevClose !== undefined && currentPrice > prevClose) {
            signals.push('support_bounce');
            strength += 0.1;
          }
        }
      }
    }

    if (highs.length > 0) {
      const resistance = Math.max(...highs);
      const diff = resistance - currentPrice;
      if (diff >= 0) {
        const proximity = resistance > 0 ? diff / resistance : Infinity;
        if (proximity <= 0.004) {
          signals.push('near_resistance');
          strength -= 0.15;
          if (prevClose !== undefined && currentPrice < prevClose) {
            signals.push('resistance_reject');
            strength -= 0.1;
          }
        }
      }
    }
  }

  return { signals, strength: Math.max(-1, Math.min(1, strength)) };
}

function analyzeSwingTradeSignals(bars, indicators, currentPrice) {
  if (!indicators || !bars || bars.length < 50) return { signals: [], strength: 0 };

  const signals = [];
  let strength = 0;

  // Trend analysis
  if (indicators.sma20 && indicators.sma50) {
    if (indicators.sma20 > indicators.sma50 && currentPrice > indicators.sma20) {
      signals.push('uptrend');
      strength += 0.4;
    } else if (indicators.sma20 < indicators.sma50 && currentPrice < indicators.sma20) {
      signals.push('downtrend');
      strength -= 0.4;
    }
  }

  // EMA trend
  if (indicators.ema20 && currentPrice > indicators.ema20) {
    signals.push('ema_support');
    strength += 0.2;
  } else if (indicators.ema20 && currentPrice < indicators.ema20) {
    signals.push('ema_resistance');
    strength -= 0.2;
  }

  // RSI for swing
  if (indicators.rsi > 65) {
    signals.push('swing_overbought');
    strength -= 0.2;
  } else if (indicators.rsi < 35) {
    signals.push('swing_oversold');
    strength += 0.2;
  }

  // MACD for swing
  if (indicators.macd && indicators.macd.macd > 0) {
    signals.push('macd_positive');
    strength += 0.3;
  }

  return { signals, strength: Math.max(-1, Math.min(1, strength)) };
}

function recommendOptionStrategy(signalStrength, direction, timeFrame = 'day') {
  // direction: 1 for bullish, -1 for bearish
  const absStrength = Math.abs(signalStrength);

  if (timeFrame === 'day') {
    if (absStrength > 0.5) {
      return {
        type: direction > 0 ? 'call' : 'put',
        expiry: '0dte', // Same day expiry
        otmPct: 0.005, // Very close to money
        confidence: absStrength
      };
    } else if (absStrength > 0.2) {
      return {
        type: direction > 0 ? 'call' : 'put',
        expiry: 'weekly',
        otmPct: 0.02,
        confidence: absStrength
      };
    }
  } else if (timeFrame === 'swing') {
    if (absStrength > 0.4) {
      return {
        type: direction > 0 ? 'call' : 'put',
        expiry: 'monthly',
        otmPct: 0.05,
        confidence: absStrength
      };
    }
  }

  return null;
}

function detectBreakout(bars, currentPrice) {
  if (!bars || bars.length < 20) return null;

  const recentHigh = Math.max(...bars.slice(-20).map(b => b.h));
  const recentLow = Math.min(...bars.slice(-20).map(b => b.l));

  if (currentPrice > recentHigh * 0.995) { // Within 0.5% of recent high
    return 'bullish_breakout';
  } else if (currentPrice < recentLow * 1.005) { // Within 0.5% of recent low
    return 'bearish_breakout';
  }

  return null;
}

function detectReversal(bars, indicators) {
  if (!bars || bars.length < 10 || !indicators) return null;

  // Double bottom/top patterns (simplified)
  const recent = bars.slice(-10);
  const prices = recent.map(b => b.c);

  // Check for potential reversal
  if (indicators.rsi < 30 && indicators.macd && indicators.macd.histogram < 0) {
    return 'potential_bullish_reversal';
  } else if (indicators.rsi > 70 && indicators.macd && indicators.macd.histogram > 0) {
    return 'potential_bearish_reversal';
  }

  return null;
}

module.exports = {
  analyzeDayTradeSignals,
  analyzeSwingTradeSignals,
  recommendOptionStrategy,
  detectBreakout,
  detectReversal
};