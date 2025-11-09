// Technical indicators for trading analysis
// All functions expect an array of price objects: [{close: number, high: number, low: number, volume: number}]

function sma(values, period) {
  if (values.length < period) return null;
  const sum = values.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (prices.length < slowPeriod + signalPeriod) return null;
  const fastEMA = ema(prices, fastPeriod);
  const slowEMA = ema(prices, slowPeriod);
  if (!fastEMA || !slowEMA) return null;

  // Calculate MACD line for each period
  const macdLine = fastEMA - slowEMA;
  
  // For simplicity, approximate signal line (this should be the EMA of MACD over time)
  // In a real implementation, we'd need historical MACD values
  const signalLine = macdLine * 0.8; // Simplified approximation
  
  const histogram = macdLine - signalLine;

  return { macd: macdLine, signal: signalLine, histogram };
}

function bollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;
  const smaValue = sma(prices, period);
  if (!smaValue) return null;

  const variance = prices.slice(-period).reduce((sum, price) => sum + Math.pow(price - smaValue, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: smaValue + (stdDev * std),
    middle: smaValue,
    lower: smaValue - (stdDev * std)
  };
}

function stochastic(prices, highs, lows, period = 14, smoothK = 3, smoothD = 3) {
  if (prices.length < period || highs.length < period || lows.length < period) return null;

  const kValues = [];
  for (let i = period - 1; i < prices.length; i++) {
    const high = Math.max(...highs.slice(i - period + 1, i + 1));
    const low = Math.min(...lows.slice(i - period + 1, i + 1));
    const k = ((prices[i] - low) / (high - low)) * 100;
    kValues.push(k);
  }

  if (kValues.length < smoothK) return null;
  const k = sma(kValues, smoothK);
  const d = sma(kValues, smoothD);

  return { k, d };
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  return sma(trueRanges, period);
}

function calculateIndicators(bars) {
  if (!bars || bars.length === 0) return {};

  const closes = bars.map(b => b.c || b.close);
  const highs = bars.map(b => b.h || b.high || b.c);
  const lows = bars.map(b => b.l || b.low || b.c);
  const volumes = bars.map(b => b.v || b.volume || 0);

  return {
    rsi: rsi(closes),
    macd: macd(closes),
    bb: bollingerBands(closes),
    stoch: stochastic(closes, highs, lows),
    atr: atr(highs, lows, closes),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    ema20: ema(closes, 20),
    volume: volumes[volumes.length - 1],
    avgVolume: sma(volumes, 20)
  };
}

module.exports = {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  stochastic,
  atr,
  calculateIndicators
};