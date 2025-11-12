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
    const chain = await withRetries(() => etrade.getOptionChain({
      symbol: ticker,
      expiry,
      includeGreeks: true
    }));

    // Find exact match
    const targetType = side === 'CALL' ? 'CALL' : 'PUT';
    let match = chain.find(opt => 
      opt.strike === strike && 
      opt.type === targetType
    );

    // Expand search window +/- 1 strike if not found
    if (!match) {
      match = chain.find(opt =>
        Math.abs(opt.strike - strike) <= 1 &&
        opt.type === targetType
      );
    }

    if (!match) {
      console.warn(`[missing_leg] Option leg not found: ${ticker} ${strike} ${expiry} ${side}`);
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
    const quotes = await withRetries(() => etrade.getEquityQuotes([ticker]));
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
    bars = await withRetries(() => fetchFmpBars(ticker, { interval: '1m', limit: 60 }));
    vwap = computeVWAP(bars);
    volume_20ma = computeVolume20MA(bars);
    if (bars.length > 0) {
      volume_1m = bars[bars.length - 1]?.v ?? null;
    }
  } catch (err) {
    console.error(`Bars error for ${ticker}:`, err.message);
  }

  // Fetch technical indicators from FMP
  const indicators = await fetchFmpIndicators(ticker);
  let snapshotRsi = indicators.rsi;
  let snapshotMacdHist = indicators.macd_hist;
  let snapshotMacdSignal = indicators.macd_signal;

  if (bars.length) {
    const localIndicators = calculateIndicators(bars);
    if ((snapshotRsi == null) && Number.isFinite(localIndicators?.rsi)) {
      snapshotRsi = localIndicators.rsi;
    }
    const derivedMacd = localIndicators?.macd;
    if (derivedMacd) {
      if (snapshotMacdSignal == null && Number.isFinite(derivedMacd.signal)) {
        snapshotMacdSignal = derivedMacd.signal;
      }
      const localHist = Number.isFinite(derivedMacd.histogram)
        ? derivedMacd.histogram
        : (Number.isFinite(derivedMacd.macd) && Number.isFinite(derivedMacd.signal))
          ? derivedMacd.macd - derivedMacd.signal
          : null;
      if (snapshotMacdHist == null && Number.isFinite(localHist)) {
        snapshotMacdHist = localHist;
      }
    }
  }

  // Fetch option leg data
  const optionData = await fetchOptionLeg(ticker, strike, expiry, side);

  const relVol = (Number.isFinite(volume_1m) && Number.isFinite(volume_20ma) && volume_20ma > 0)
    ? volume_1m / Math.max(volume_20ma, 1)
    : null;

  const spreadPct = (Number.isFinite(optionData.bid) && Number.isFinite(optionData.ask))
    ? (optionData.ask - optionData.bid) / Math.max(optionData.mid ?? (optionData.ask + optionData.bid) / 2, 0.01)
    : null;

  const clock = getCTClock();
  const time_ct = clock.isoTime;

  return {
    time_ct,
    ticker,
    price: Number.isFinite(price) ? price : null,
    vwap: Number.isFinite(vwap) ? vwap : null,
    rsi: Number.isFinite(snapshotRsi) ? snapshotRsi : null,
    macd_hist: Number.isFinite(snapshotMacdHist) ? snapshotMacdHist : null,
    macd_signal: Number.isFinite(snapshotMacdSignal) ? snapshotMacdSignal : null,
    volume_1m: Number.isFinite(volume_1m) ? volume_1m : null,
    volume_20ma: Number.isFinite(volume_20ma) ? volume_20ma : null,
    rel_vol_live: Number.isFinite(relVol) ? relVol : null,
    bid: optionData.bid,
    ask: optionData.ask,
    mid: optionData.mid,
    spread_pct: Number.isFinite(spreadPct) ? spreadPct : null,
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
 * Check if current time is past target time in CT
 */
function isTimePast(targetHour, targetMinute, targetSecond, clock = getCTClock()) {
  const { hour, minute, second } = clock;
  if (hour > targetHour) return true;
  if (hour === targetHour) {
    if (minute > targetMinute) return true;
    if (minute === targetMinute && second >= targetSecond) return true;
  }
  return false;
}

/**
 * Wait until specific time in CT
 */
async function waitUntilCT(targetHour, targetMinute, targetSecond) {
  // Poll faster pre-open so we can hit the cadence exactly
  while (true) {
    const clock = getCTClock();
    if (isTimePast(targetHour, targetMinute, targetSecond, clock)) {
      break;
    }
    await sleep(WAIT_POLL_MS);
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

  console.log('READY_FOR_SNAPSHOTS');
  // Wait until 08:30:15 CT for first emission
  await waitUntilCT(8, 30, 15);

  // Emission loop
  let emissionCount = 0;

  while (true) {
    const loopClock = getCTClock();

    // Stop at 09:30:00 CT
    if (isTimePast(9, 30, 0, loopClock)) {
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
          time_ct: loopClock.isoTime,
          ticker: config.ticker,
          price: null,
          vwap: null,
          rsi: null,
          macd_hist: null,
          macd_signal: null,
          volume_1m: null,
          volume_20ma: null,
          rel_vol_live: null,
          bid: null,
          ask: null,
          mid: null,
          spread_pct: null,
          oi: null,
          iv: null,
          delta: null
        });
      }
    }

    emissionCount++;

    // Determine next interval
    const postEmitClock = getCTClock();
    const beforeSwitch = !isTimePast(8, 33, 0, postEmitClock);
    const intervalMs = beforeSwitch ? 5000 : 15000;
    await sleep(intervalMs);
  }

  console.error(`Completed ${emissionCount} emission cycles.`);
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
