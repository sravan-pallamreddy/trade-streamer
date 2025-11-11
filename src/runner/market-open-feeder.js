#!/usr/bin/env node
require('dotenv').config();

const { fetchFmpBars } = require('../providers/bars');
const { getEquityQuotes, getOptionChain } = require('../providers/etrade');

// Compute RSI from price bars
function computeRSI(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push(bars[i].c - bars[i - 1].c);
  }
  const recent = changes.slice(-period);
  const gains = recent.filter(x => x > 0).reduce((sum, x) => sum + x, 0) / period;
  const losses = Math.abs(recent.filter(x => x < 0).reduce((sum, x) => sum + x, 0)) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

// Compute MACD from price bars
function computeMACD(bars, fast = 12, slow = 26, signal = 9) {
  if (!bars || bars.length < slow + signal) return { hist: null, signal: null };
  const closes = bars.map(b => b.c);
  
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let emaVal = data[0];
    for (let i = 1; i < data.length; i++) {
      emaVal = data[i] * k + emaVal * (1 - k);
    }
    return emaVal;
  };
  
  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);
  const macdLine = fastEMA - slowEMA;
  
  // Signal line is EMA of MACD (simplified - using last value)
  const signalLine = macdLine * 0.8; // Approximation
  const hist = macdLine - signalLine;
  
  return { hist, signal: signalLine };
}

// Compute VWAP from bars
function computeVWAP(bars) {
  if (!bars || bars.length === 0) return null;
  let sumPV = 0;
  let sumV = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    sumPV += typical * bar.v;
    sumV += bar.v;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

// Format time in CT
function formatTimeCT(date) {
  const ctOffset = -6; // CT is UTC-6 (CST) or UTC-5 (CDT) - using CST
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const ctDate = new Date(utc + (3600000 * ctOffset));
  return ctDate.toTimeString().split(' ')[0]; // HH:MM:SS
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry with exponential backoff
async function retry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(200 + (i * 100));
    }
  }
}

// Fetch snapshot data for a ticker
async function fetchTickerSnapshot(ticker, contract) {
  const snapshot = {
    time_ct: formatTimeCT(new Date()),
    ticker: ticker,
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
    delta: null,
  };

  try {
    // Fetch stock price from E*TRADE
    const quotes = await retry(() => getEquityQuotes([ticker]));
    if (quotes[ticker]) {
      snapshot.price = quotes[ticker].price;
    }
  } catch (err) {
    console.error(`[${ticker}] Price fetch error:`, err.message);
  }

  try {
    // Fetch 1-minute bars from FMP (last 60 bars)
    const bars = await retry(() => fetchFmpBars(ticker, { interval: '1m', limit: 60 }));
    if (bars && bars.length > 0) {
      // Compute derived metrics
      snapshot.vwap = computeVWAP(bars);
      snapshot.rsi = computeRSI(bars, 14);
      const macd = computeMACD(bars, 12, 26, 9);
      snapshot.macd_hist = macd.hist;
      snapshot.macd_signal = macd.signal;
      
      // Volume metrics
      const last20 = bars.slice(-20);
      snapshot.volume_1m = bars[bars.length - 1]?.v || null;
      const vol20sum = last20.reduce((sum, b) => sum + (b.v || 0), 0);
      snapshot.volume_20ma = last20.length > 0 ? vol20sum / last20.length : null;
    }
  } catch (err) {
    console.error(`[${ticker}] Bars fetch error:`, err.message);
  }

  try {
    // Fetch option data from E*TRADE
    if (contract && contract.expiry && contract.strike && contract.side) {
      const chain = await retry(() => getOptionChain({
        symbol: ticker,
        expiry: contract.expiry,
        includeGreeks: true
      }));
      
      // Find matching option leg
      const side = contract.side.toUpperCase();
      const targetStrike = Number(contract.strike);
      
      let match = chain.find(opt => 
        opt.type === side && 
        Math.abs(opt.strike - targetStrike) < 0.01
      );
      
      // Fallback: search ±1 strike
      if (!match) {
        match = chain.find(opt => 
          opt.type === side && 
          Math.abs(opt.strike - targetStrike) <= 1
        );
      }
      
      if (match) {
        snapshot.bid = match.bid;
        snapshot.ask = match.ask;
        snapshot.mid = (match.bid != null && match.ask != null) 
          ? (match.bid + match.ask) / 2 
          : null;
        snapshot.oi = match.oi;
        snapshot.delta = match.delta;
        snapshot.iv = null; // E*TRADE doesn't always provide IV in standard response
      } else {
        console.error(`[${ticker}] Option leg not found: ${side} ${targetStrike} ${contract.expiry}`);
      }
    }
  } catch (err) {
    console.error(`[${ticker}] Option chain error:`, err.message);
  }

  return snapshot;
}

// Emit snapshot with framing
function emitSnapshot(snapshot) {
  console.log('BEGIN SNAPSHOT');
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('END SNAPSHOT');
}

// Main loop
async function run() {
  // Parse tickers and contracts from env
  const tickersEnv = process.env.FEEDER_TICKERS || process.env.SCAN_SYMBOLS || '';
  const tickers = tickersEnv.split(',').map(s => s.trim()).filter(Boolean);
  
  if (tickers.length === 0) {
    console.error('ERROR: No tickers specified. Set FEEDER_TICKERS or SCAN_SYMBOLS env variable.');
    process.exit(1);
  }

  // Parse contracts (optional, format: SYMBOL:STRIKE:EXPIRY:SIDE,...)
  const contractsEnv = process.env.FEEDER_CONTRACTS || '';
  const contracts = {};
  if (contractsEnv) {
    contractsEnv.split(',').forEach(spec => {
      const parts = spec.trim().split(':');
      if (parts.length === 4) {
        const [sym, strike, expiry, side] = parts;
        contracts[sym.toUpperCase()] = {
          strike: Number(strike),
          expiry: expiry,
          side: side.toUpperCase()
        };
      }
    });
  }

  console.error(`Market Data Feeder starting for: ${tickers.join(', ')}`);
  console.error(`Contracts configured: ${Object.keys(contracts).length}`);

  // Wait until 08:30:00 CT
  const now = new Date();
  const ctHour = now.getUTCHours() - 6; // Approximate CT
  const ctMinute = now.getUTCMinutes();
  const ctSecond = now.getUTCSeconds();
  
  const currentCTSeconds = ctHour * 3600 + ctMinute * 60 + ctSecond;
  const targetStartSeconds = 8 * 3600 + 30 * 60; // 08:30:00
  const firstEmitSeconds = targetStartSeconds + 15; // 08:30:15

  if (currentCTSeconds < targetStartSeconds) {
    const waitMs = (targetStartSeconds - currentCTSeconds) * 1000;
    console.error(`Waiting until 08:30:00 CT (${Math.round(waitMs/1000)}s)...`);
    await sleep(waitMs);
  }

  // Warmup phase
  console.error('Warming up (fetching initial data)...');
  for (const ticker of tickers) {
    try {
      await fetchTickerSnapshot(ticker, contracts[ticker]);
    } catch (err) {
      console.error(`Warmup error for ${ticker}:`, err.message);
    }
  }

  // Wait until 08:30:15 CT for first emission
  const nowAfterWarmup = new Date();
  const ctSecondsAfter = (nowAfterWarmup.getUTCHours() - 6) * 3600 + nowAfterWarmup.getUTCMinutes() * 60 + nowAfterWarmup.getUTCSeconds();
  if (ctSecondsAfter < firstEmitSeconds) {
    await sleep((firstEmitSeconds - ctSecondsAfter) * 1000);
  }

  console.log('READY_FOR_SNAPSHOTS');

  // Emission loop
  const endSeconds = 9 * 3600 + 30 * 60; // 09:30:00 CT
  let lastEmit = Date.now();

  while (true) {
    const loopStart = Date.now();
    const ctNow = new Date();
    const ctSec = (ctNow.getUTCHours() - 6) * 3600 + ctNow.getUTCMinutes() * 60 + ctNow.getUTCSeconds();

    if (ctSec >= endSeconds) {
      console.error('Reached 09:30:00 CT. Stopping feeder.');
      break;
    }

    // Determine cadence
    const earlyWindow = 8 * 3600 + 30 * 60 + 15; // 08:30:15
    const fastEnd = 8 * 3600 + 33 * 60; // 08:33:00
    const cadenceSec = (ctSec >= earlyWindow && ctSec < fastEnd) ? 5 : 15;

    // Emit snapshots for all tickers
    for (const ticker of tickers) {
      const snapshot = await fetchTickerSnapshot(ticker, contracts[ticker]);
      emitSnapshot(snapshot);
    }

    lastEmit = Date.now();

    // Sleep until next cadence
    const elapsed = Date.now() - loopStart;
    const sleepMs = Math.max(0, cadenceSec * 1000 - elapsed);
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
}

// Handle errors
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
