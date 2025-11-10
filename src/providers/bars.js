const cache = new Map();
const fmpCache = new Map();
const { calculateIndicators } = require('../strategy/indicators');

const FMP_INTERVAL_MAP = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '60m': '1hour',
  '1h': '1hour',
  '4h': '4hour',
};

function resolveFmpInterval(interval) {
  if (!interval) return '1min';
  const key = interval.toLowerCase();
  return FMP_INTERVAL_MAP[key] || '1min';
}

function buildFmpLimit(range, interval) {
  if (Number.isFinite(range)) return range;
  const normalizedInterval = resolveFmpInterval(interval);
  switch (normalizedInterval) {
    case '1min':
      return 390;
    case '5min':
      return 120;
    case '15min':
      return 90;
    case '30min':
      return 120;
    case '1hour':
      return 120;
    case '4hour':
      return 120;
    default:
      return 390;
  }
}

async function fetchFmpBars(symbol, { range = '1d', interval = '1m', limit } = {}) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not configured');
  const normalizedInterval = resolveFmpInterval(interval);
  const numericLimit = Number(limit);
  const normalizedLimit = Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : buildFmpLimit(range, interval);
  const cacheKey = `fmp:${symbol}:${normalizedInterval}:${normalizedLimit}`;
  const now = Date.now();
  const cached = fmpCache.get(cacheKey);
  if (cached && (now - cached.at) < 20_000) return cached.data;

  const url = `https://financialmodelingprep.com/api/v3/historical-chart/${normalizedInterval}/${encodeURIComponent(symbol)}?apikey=${apiKey}&limit=${normalizedLimit}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*'
    }
  });
  if (!res.ok) throw new Error(`FMP chart HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('FMP returned no bars');
  }

  const bars = data
    .map(item => {
      if (!item || item.close == null || !item.date) return null;
      const ts = Date.parse(`${item.date}Z`);
      const close = Number(item.close);
      if (!Number.isFinite(ts) || !Number.isFinite(close)) return null;
      const highValue = Number(item.high);
      const lowValue = Number(item.low);
      const volumeValue = Number(item.volume);
      return {
        t: ts,
        c: close,
        h: Number.isFinite(highValue) ? highValue : close,
        l: Number.isFinite(lowValue) ? lowValue : close,
        v: Number.isFinite(volumeValue) && volumeValue >= 0 ? volumeValue : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  if (!bars.length) {
    throw new Error('FMP bars could not be parsed');
  }

  fmpCache.set(cacheKey, { at: now, data: bars });
  return bars;
}

async function fetchFmpBarsWithIndicators(symbol, options = {}) {
  const bars = await fetchFmpBars(symbol, options);
  const indicators = calculateIndicators(bars);
  return { bars, indicators };
}

async function fetchYahooBars(symbol, { range = '1d', interval = '1m' } = {}) {
  const now = Date.now();
  const key = `${symbol}:${range}:${interval}`;
  const cached = cache.get(key);
  if (cached && (now - cached.at) < 20_000) return cached.data; // 20s cache
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/'
    }
  });
  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const close = q?.close || [];
  const vol = q?.volume || [];
  const high = q?.high || [];
  const low = q?.low || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    const v = vol[i];
    const h = high[i];
    const l = low[i];
    if (c == null) continue;
    out.push({ t: ts[i] * 1000, c: Number(c), h: Number(h || c), l: Number(l || c), v: Number(v || 0) });
  }
  cache.set(key, { at: now, data: out });
  return out;
}

async function fetchYahooBarsWithIndicators(symbol, options = {}) {
  const bars = await fetchYahooBars(symbol, options);
  const indicators = calculateIndicators(bars);
  return { bars, indicators };
}

// Fallback bars fetcher using alternative sources
async function fetchBarsWithFallback(symbol, options = {}) {
  const attempts = [];
  if (process.env.FMP_API_KEY) {
    try {
      return await fetchFmpBarsWithIndicators(symbol, options);
    } catch (err) {
      attempts.push(`FMP: ${err.message}`);
      console.warn(`FMP bars failed for ${symbol}, falling back to Yahoo... (${err.message})`);
    }
  }

  try {
    const fallbackResult = await fetchYahooBarsWithIndicators(symbol, options);
    if (attempts.length) {
      return { ...fallbackResult, debug: { attempts } };
    }
    return fallbackResult;
  } catch (err) {
    attempts.push(`Yahoo: ${err.message}`);
    console.warn(`Yahoo bars failed for ${symbol}, using mock data for analysis... (${err.message})`);
    const mockBars = generateMockBars(symbol);
    const indicators = calculateIndicators(mockBars);
    return { bars: mockBars, indicators, debug: { attempts } };
  }
}

// Generate realistic mock bars data for technical analysis
function generateMockBars(symbol) {
  const now = Date.now();
  const bars = [];
  const basePrices = {
    'SPY': 450,
    'QQQ': 380,
    'AAPL': 175,
    'TSLA': 245,
    'GOOGL': 135,
    'NVDA': 485
  };

  const basePrice = basePrices[symbol] || 100;
  let currentPrice = basePrice;

  // Generate 100 bars of mock 1-minute data
  for (let i = 99; i >= 0; i--) {
    const timestamp = now - (i * 60 * 1000); // 1 minute intervals
    const volatility = 0.005; // 0.5% volatility
    const change = (Math.random() - 0.5) * 2 * volatility * currentPrice;
    currentPrice += change;

    // Ensure price stays reasonable
    currentPrice = Math.max(currentPrice, basePrice * 0.8);
    currentPrice = Math.min(currentPrice, basePrice * 1.2);

    const high = currentPrice * (1 + Math.random() * 0.01);
    const low = currentPrice * (1 - Math.random() * 0.01);
    const volume = Math.floor(Math.random() * 100000) + 50000;

    bars.push({
      t: timestamp,
      c: Number(currentPrice.toFixed(2)),
      h: Number(high.toFixed(2)),
      l: Number(low.toFixed(2)),
      v: volume
    });
  }

  return bars.reverse(); // Most recent last
}

module.exports = {
  fetchYahooBars,
  fetchYahooBarsWithIndicators,
  fetchFmpBars,
  fetchFmpBarsWithIndicators,
  fetchBarsWithFallback,
};

