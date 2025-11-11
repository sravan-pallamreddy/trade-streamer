#!/usr/bin/env node
require('dotenv').config();

const etrade = require('../providers/etrade');
const { fetchFmpBars } = require('../providers/bars');
const { calculateIndicators } = require('../strategy/indicators');

const CT_TIMEZONE = 'America/Chicago';
const CT_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CT_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 250;
const WAIT_POLL_MS = 250;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryError(err) {
  if (!err) return false;
  if (typeof err.status === 'number') {
    if (err.status >= 500 || err.status === 429) return true;
    return false;
  }
  // Network/Abort/unknown errors surface without status
  return true;
}

async function withRetries(fn, { retries = MAX_RETRIES, delayMs = RETRY_DELAY_MS } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetryError(err)) {
        throw err;
      }
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

function getCTClock() {
  const parts = CT_TIME_FORMATTER.formatToParts(new Date());
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  return {
    hour,
    minute,
    second,
    isoTime: `${map.hour}:${map.minute}:${map.second}`,
  };
}

/**
 * Parse ticker configurations from environment or CLI
 * Expected format: TSLA:450:2025-11-14:CALL,AAPL:175:2025-11-15:PUT
 */
function parseTickerConfig() {
  const configStr = process.env.SNAPSHOT_TICKERS || '';
  if (!configStr.trim()) {
    console.error('ERROR: SNAPSHOT_TICKERS environment variable required');
    console.error('Format: SYMBOL:STRIKE:EXPIRY:SIDE[,...]');
    console.error('Example: TSLA:450:2025-11-14:CALL,AAPL:175:2025-11-15:PUT');
    process.exit(1);
  }

  return configStr.split(',').map(entry => {
    const [ticker, strike, expiry, side] = entry.trim().split(':');
    if (!ticker || !strike || !expiry || !side) {
      throw new Error(`Invalid ticker config: ${entry}`);
    }
    return {
      ticker: ticker.toUpperCase(),
      strike: Number(strike),
      expiry, // YYYY-MM-DD
      side: side.toUpperCase() // CALL or PUT
    };
  });
}

/**
 * Compute VWAP from candle array
 */
function computeVWAP(bars) {
  if (!bars || bars.length === 0) return null;
  let sumPV = 0;
  let sumV = 0;
  for (const bar of bars) {
    if (!bar.h || !bar.l || !bar.c || !bar.v) continue;
    const typical = (bar.h + bar.l + bar.c) / 3;
    sumPV += typical * bar.v;
    sumV += bar.v;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

/**
 * Compute 20-period moving average of volume
 */
function computeVolume20MA(bars) {
  if (!bars || bars.length === 0) return null;
  const tail = bars.slice(-20);
  if (tail.length === 0) return null;
  const sumVol = tail.reduce((acc, bar) => acc + (bar.v || 0), 0);
  return sumVol / tail.length;
}

/**
 * Fetch FMP technical indicators (RSI, MACD)
 */
async function fetchFmpIndicators(symbol) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return { rsi: null, macd: null, macd_signal: null, macd_hist: null };

  const headers = { 'Accept': 'application/json' };
  let rsi = null;
  let macd = null;
  let macd_signal = null;
  let macd_hist = null;

  const rsiUrl = `https://financialmodelingprep.com/api/v3/technical_indicator/1min/${encodeURIComponent(symbol)}?period=14&type=rsi&apikey=${apiKey}`;
  try {
    const rsiData = await withRetries(async () => {
      const res = await fetch(rsiUrl, { headers });
      if (!res.ok) {
        const error = new Error(`FMP RSI HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    });
    if (Array.isArray(rsiData) && rsiData.length > 0) {
      const value = Number(rsiData[0]?.rsi);
      if (Number.isFinite(value)) {
        rsi = value;
      }
    }
  } catch (err) {
    console.warn(`FMP RSI fetch failed for ${symbol}: ${err.message}`);
  }

  const macdUrl = `https://financialmodelingprep.com/api/v3/technical_indicator/1min/${encodeURIComponent(symbol)}?indicator=macd&fastperiod=12&slowperiod=26&signalperiod=9&apikey=${apiKey}`;
  try {
    const macdData = await withRetries(async () => {
      const res = await fetch(macdUrl, { headers });
      if (!res.ok) {
        const error = new Error(`FMP MACD HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    });
    if (Array.isArray(macdData) && macdData.length > 0) {
      const latest = macdData[0];
      const rawMacd = Number(latest?.macd);
      const rawSignal = Number(latest?.signal);
      let rawHist = Number(latest?.hist ?? latest?.histogram);
      if (Number.isFinite(rawMacd)) macd = rawMacd;
      if (Number.isFinite(rawSignal)) macd_signal = rawSignal;
      if (!Number.isFinite(rawHist) && Number.isFinite(rawMacd) && Number.isFinite(rawSignal)) {
        rawHist = rawMacd - rawSignal;
      }
      if (Number.isFinite(rawHist)) macd_hist = rawHist;
    }
  } catch (err) {
    console.warn(`FMP MACD fetch failed for ${symbol}: ${err.message}`);
  }

  return { rsi, macd, macd_signal, macd_hist };
}

/**
 * Fetch option chain data from E*TRADE for a specific leg
 */
async function fetchOptionLeg(ticker, strike, expiry, side) {
  try {
    const [year, month, day] = expiry.split('-').map(Number);
    const chain = await etrade.getOptionChain({
      symbol: ticker,
      expiry,
      includeGreeks: true
    });

    // Find exact match
    const targetType = side === 'CALL' ? 'CALL' : 'PUT';
    let match = chain.find(opt => 
      opt.strike === strike && 
      opt.type === targetType
    );

    // Expand search window ±1 strike if not found
    if (!match) {
      match = chain.find(opt =>
        Math.abs(opt.strike - strike) <= 1 &&
        opt.type === targetType
      );
    }

    if (!match) {
      console.error(`Option leg not found: ${ticker} ${strike} ${expiry} ${side}`);
      return { bid: null, ask: null, mid: null, oi: null, iv: null, delta: null };
    }

    const bid = match.bid;
    const ask = match.ask;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
    const oi = match.oi;
    const iv = match.raw?.greeks?.iv ?? match.raw?.impliedVolatility ?? null;
    const delta = match.delta;

    return {
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      mid: Number.isFinite(mid) ? mid : null,
      oi: Number.isFinite(oi) ? oi : null,
      iv: Number.isFinite(iv) ? iv : null,
      delta: Number.isFinite(delta) ? delta : null
    };
  } catch (err) {
    console.error(`Option chain error for ${ticker}:`, err.message);
    return { bid: null, ask: null, mid: null, oi: null, iv: null, delta: null };
  }
}

/**
 * Fetch equity quote from E*TRADE
 */
async function fetchEquityQuote(ticker) {
  try {
    const quotes = await etrade.getEquityQuotes([ticker]);
    const quote = quotes[ticker];
    if (!quote || !Number.isFinite(quote.price)) {
      return null;
    }
    return quote.price;
  } catch (err) {
    console.error(`Equity quote error for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Build a complete snapshot for one ticker
 */
async function buildSnapshot(config) {
  const { ticker, strike, expiry, side } = config;

  // Fetch equity price
  const price = await fetchEquityQuote(ticker);

  // Fetch 1-minute bars (last 60)
  let bars = [];
  let vwap = null;
  let volume_1m = null;
  let volume_20ma = null;
  try {
    bars = await fetchFmpBars(ticker, { interval: '1m', limit: 60 });
    vwap = computeVWAP(bars);
    volume_20ma = computeVolume20MA(bars);
    if (bars.length > 0) {
      volume_1m = bars[bars.length - 1]?.v ?? null;
    }
  } catch (err) {
    console.error(`Bars error for ${ticker}:`, err.message);
  }

  // Fetch technical indicators from FMP
  const { rsi, macd_hist, macd_signal } = await fetchFmpIndicators(ticker);

  // Fetch option leg data
  const optionData = await fetchOptionLeg(ticker, strike, expiry, side);

  // Get current time in CT (UTC-6 or UTC-5 depending on DST)
  const now = new Date();
  const ctOffset = -6 * 60; // CT is UTC-6 (CST) or UTC-5 (CDT) - simplified to CST
  const ctTime = new Date(now.getTime() + ctOffset * 60 * 1000);
  const time_ct = ctTime.toISOString().slice(11, 19); // HH:MM:SS

  return {
    time_ct,
    ticker,
    price: Number.isFinite(price) ? price : null,
    vwap: Number.isFinite(vwap) ? vwap : null,
    rsi: Number.isFinite(rsi) ? rsi : null,
    macd_hist: Number.isFinite(macd_hist) ? macd_hist : null,
    macd_signal: Number.isFinite(macd_signal) ? macd_signal : null,
    volume_1m: Number.isFinite(volume_1m) ? volume_1m : null,
    volume_20ma: Number.isFinite(volume_20ma) ? volume_20ma : null,
    bid: optionData.bid,
    ask: optionData.ask,
    mid: optionData.mid,
    oi: optionData.oi,
    iv: optionData.iv,
    delta: optionData.delta
  };
}

/**
 * Emit a snapshot with BEGIN/END framing
 */
function emitSnapshot(snapshot) {
  console.log('BEGIN SNAPSHOT');
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('END SNAPSHOT');
}

/**
 * Get current time in CT
 */
function getCurrentCT() {
  const now = new Date();
  const ctOffset = -6 * 60; // CST (UTC-6)
  return new Date(now.getTime() + ctOffset * 60 * 1000);
}

/**
 * Check if current time is past target time in CT
 */
function isTimePast(targetHour, targetMinute, targetSecond) {
  const ct = getCurrentCT();
  const ctHour = ct.getUTCHours();
  const ctMinute = ct.getUTCMinutes();
  const ctSecond = ct.getUTCSeconds();

  if (ctHour > targetHour) return true;
  if (ctHour === targetHour) {
    if (ctMinute > targetMinute) return true;
    if (ctMinute === targetMinute && ctSecond >= targetSecond) return true;
  }
  return false;
}

/**
 * Wait until specific time in CT
 */
async function waitUntilCT(targetHour, targetMinute, targetSecond) {
  while (!isTimePast(targetHour, targetMinute, targetSecond)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Main execution loop
 */
async function main() {
  const configs = parseTickerConfig();
  console.error(`Monitoring ${configs.length} ticker(s): ${configs.map(c => c.ticker).join(', ')}`);

  // Wait until 08:30:00 CT
  console.error('Waiting for 08:30:00 CT...');
  await waitUntilCT(8, 30, 0);

  // Warmup: fetch initial data
  console.error('Warming up (fetching initial candles & quotes)...');
  for (const config of configs) {
    try {
      await buildSnapshot(config);
    } catch (err) {
      console.error(`Warmup error for ${config.ticker}:`, err.message);
    }
  }

  // Wait until 08:30:15 CT for first emission
  await waitUntilCT(8, 30, 15);
  console.log('READY_FOR_SNAPSHOTS');

  // Emission loop
  let emissionCount = 0;
  const startTime = getCurrentCT();

  while (true) {
    const ct = getCurrentCT();
    const elapsed = (ct - startTime) / 1000; // seconds since 08:30:15

    // Stop at 09:30:00 CT
    if (isTimePast(9, 30, 0)) {
      console.error('Reached 09:30:00 CT, stopping emissions.');
      break;
    }

    // Emit snapshots for all tickers
    for (const config of configs) {
      try {
        const snapshot = await buildSnapshot(config);
        emitSnapshot(snapshot);
      } catch (err) {
        console.error(`Snapshot error for ${config.ticker}:`, err.message);
        // Emit with nulls on error
        emitSnapshot({
          time_ct: ct.toISOString().slice(11, 19),
          ticker: config.ticker,
          price: null,
          vwap: null,
          rsi: null,
          macd_hist: null,
          macd_signal: null,
          volume_1m: null,
          volume_20ma: null,
          bid: null,
          ask: null,
          mid: null,
          oi: null,
          iv: null,
          delta: null
        });
      }
    }

    emissionCount++;

    // Determine next interval
    let intervalMs;
    if (elapsed < 165) { // First 165 seconds (08:30:15 to 08:33:00)
      intervalMs = 5000;
    } else {
      intervalMs = 15000;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  console.error(`Completed ${emissionCount} emission cycles.`);
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
