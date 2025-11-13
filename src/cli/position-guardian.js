#!/usr/bin/env node
// Position guardian: monitors open option trades and suggests add/trim/exit actions
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const util = require('util');

const { getQuotes } = require('../providers/quotes');
const etrade = require('../providers/etrade');
const { fetchOptionChain } = require('../providers/options-chain');
const { fetchBarsWithFallback } = require('../providers/bars');
const { analyzeDayTradeSignals, analyzeSwingTradeSignals } = require('../strategy/algorithms');
const { midPrice, pickNearestStrike } = require('../strategy/selector');
const { getClient } = require('../ai/client');

const sleep = util.promisify(setTimeout);
const COLORS = {
  red: (text) => process.stdout.isTTY ? `\x1b[31m${text}\x1b[0m` : text,
};

function colorize(color, text) {
  const fn = COLORS[color];
  return fn ? fn(text) : text;
}

function blink(text) {
  return process.stdout.isTTY ? `\x1b[5m${text}\x1b[0m` : text;
}

function parseArgs(argv) {
  const defaultAiClient = getClient(process.env.GUARDIAN_AI_PROVIDER || process.env.AI_PROVIDER);
  const aiModelEnv = process.env.GUARDIAN_AI_MODEL || process.env.AI_MODEL;
  const defaults = {
    file: process.env.GUARDIAN_POSITIONS_FILE || path.resolve(__dirname, '..', '..', 'data', 'open-positions.json'),
    provider: process.env.QUOTE_PROVIDER || 'fmp',
    strategy: process.env.TRADING_STRATEGY || 'day_trade',
    watch: process.env.GUARDIAN_WATCH?.toLowerCase() === 'false' ? false : true,
    intervalMs: (Number(process.env.GUARDIAN_INTERVAL_MS) || 300_000),
    ai: process.env.GUARDIAN_AI?.toLowerCase() === 'false' ? false : true,
    aiProvider: defaultAiClient.name,
    aiModel: aiModelEnv || defaultAiClient.defaultModel,
    source: (process.env.GUARDIAN_SOURCE || 'file').toLowerCase(),
    etradeAccount: process.env.GUARDIAN_ETRADE_ACCOUNT || 'gks_erdl0Zw3A5ALvAvXOA',
    etradeView: process.env.GUARDIAN_ETRADE_VIEW || 'QUICK',
  };

  const out = { ...defaults };
  const args = argv.slice(2);
  let aiModelExplicit = Boolean(aiModelEnv);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--file' || arg === '-f') && args[i + 1]) { out.file = path.resolve(args[++i]); continue; }
    if ((arg === '--provider' || arg === '-p') && args[i + 1]) { out.provider = args[++i]; continue; }
    if ((arg === '--strategy' || arg === '-s') && args[i + 1]) { out.strategy = args[++i]; continue; }
    if (arg === '--watch' || arg === '-w') { out.watch = true; continue; }
  if (arg === '--no-watch' || arg === '--once') { out.watch = false; continue; }
    if ((arg === '--interval' || arg === '-i') && args[i + 1]) { out.intervalMs = Number(args[++i]) * 1000; continue; }
    if (arg === '--ai') { out.ai = true; continue; }
    if (arg === '--no-ai') { out.ai = false; continue; }
    if ((arg === '--ai-provider') && args[i + 1]) {
      const client = getClient(args[++i]);
      out.aiProvider = client.name;
      if (!aiModelExplicit) out.aiModel = client.defaultModel;
      continue;
    }
    if ((arg === '--ai-model') && args[i + 1]) { out.aiModel = args[++i]; aiModelExplicit = true; continue; }
    if ((arg === '--source' || arg === '-S') && args[i + 1]) { out.source = args[++i]; continue; }
    if ((arg === '--etrade-account' || arg === '--account') && args[i + 1]) { out.etradeAccount = args[++i]; continue; }
    if ((arg === '--etrade-view') && args[i + 1]) { out.etradeView = args[++i]; continue; }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  out.source = (out.source || 'file').toLowerCase();
  out.etradeView = (out.etradeView || 'QUICK').toUpperCase();
  return out;
}

function printHelp() {
  console.log([
    'Usage: npm run guardian [-- --file data/open-positions.json --watch --interval 300 --no-ai]',
    '',
    'Monitors open option positions and prints add/trim/exit suggestions.',
    '',
    'Flags:',
    '  --file, -f <path>        Path to positions ledger (default: data/open-positions.json)',
  '  --source, -S <mode>      Data source: file | etrade (default: file)',
  '  --etrade-account <id>    E*TRADE accountIdKey when --source=etrade',
  '  --etrade-view <view>     Portfolio view for E*TRADE fetch (default: QUICK)',
    '  --provider, -p <name>    Quote provider for underlyings (default: env QUOTE_PROVIDER)',
    '  --strategy, -s <name>    Trading strategy profile (day_trade | swing_trade)',
  '  --watch, -w              Run continuously at intervals (default)',
  '  --no-watch, --once       Run a single evaluation and exit',
    '  --interval, -i <sec>     Poll interval when watching (default 300 seconds)',
    '  --ai / --no-ai           Enable or disable AI commentary (default on)',
    '  --ai-provider <name>     AI provider (openai|deepseek; default from env)',
    '  --ai-model <name>        Override AI model (default per provider or AI_MODEL env)',
    '  --help, -h               Show this message',
  ].join('\n'));
}

function loadPositionsFromFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(`⚠️  Positions file not found: ${file}`);
    return [];
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn('⚠️  Positions file format invalid (expected array).');
      return [];
    }
    return data.filter(Boolean);
  } catch (err) {
    console.error('❌ Failed to load positions file:', err.message);
    return [];
  }
}

function inferUnderlyingSymbol(rawSymbol, callPut) {
  if (!rawSymbol) return rawSymbol;
  const upper = rawSymbol.toUpperCase();
  if (callPut && /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(upper)) {
    return upper.replace(/\d{6}[CP]\d{8}$/, '');
  }
  const spaceSplit = upper.split(' ');
  if (spaceSplit.length > 1) return spaceSplit[0];
  const dashSplit = upper.split('-');
  if (dashSplit.length > 1) return dashSplit[0];
  const letters = upper.match(/^[A-Z]+/);
  return letters ? letters[0] : upper;
}

async function loadPositionsFromEtrade({ etradeAccount, etradeView }) {
  if (!etradeAccount) {
    console.error('❌ E*TRADE accountIdKey required. Provide via --etrade-account or GUARDIAN_ETRADE_ACCOUNT env.');
    return [];
  }
  try {
    const requestedView = (etradeView || 'QUICK').toUpperCase();
    const fallbacks = ['COMPLETE', 'QUICK', 'PERFORMANCE'];
    const views = Array.from(new Set([requestedView, ...fallbacks]));
    let rawPositions = [];
    let usedView = null;
    for (const view of views) {
      const { positions } = await etrade.getPortfolio(etradeAccount, { view });
      if (Array.isArray(positions) && positions.length > 0) {
        rawPositions = positions;
        usedView = view;
        break;
      }
    }
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      console.log(`ℹ️  No positions returned from E*TRADE portfolio (views tried: ${views.join(', ')}).`);
      return [];
    }
    const mapped = [];
    for (const pos of rawPositions) {
      if (!pos) continue;
      const callPut = (pos.callPut || '').toUpperCase();
      if (callPut !== 'CALL' && callPut !== 'PUT') continue; // monitor option contracts only
      const qtyValue = Number(pos.quantity ?? pos.Quantity ?? 0);
      if (!qtyValue) continue;
      const strikeRaw = pos.strike ?? pos.Strike ?? pos.strikePrice ?? null;
      const strike = strikeRaw != null ? Number(strikeRaw) : null;
      const expiry = pos.expiry || pos.Expiry || null;
      const underlying = inferUnderlyingSymbol(pos.symbol || pos.Symbol, callPut);
      const symbol = underlying ? underlying.toUpperCase() : null;
      if (!symbol) continue;
      const pricePaidRaw = pos.pricePaid ?? pos.PricePaid ?? null;
      const totalCostRaw = pos.totalCost ?? pos.TotalCost ?? null;
      const marketValueRaw = pos.marketValue ?? pos.MarketValue ?? null;
      const currentPriceRaw = pos.currentPrice ?? pos.Quick?.lastTrade ?? null;
      const pricePaid = pricePaidRaw != null ? Number(pricePaidRaw) : NaN;
      const totalCost = totalCostRaw != null ? Number(totalCostRaw) : NaN;
      const marketValue = marketValueRaw != null ? Number(marketValueRaw) : NaN;
      const currentPrice = currentPriceRaw != null ? Number(currentPriceRaw) : NaN;
      const multiplier = 100;
      const entry = Number.isFinite(pricePaid)
        ? pricePaid
        : (Number.isFinite(totalCost) && qtyValue ? totalCost / (Math.abs(qtyValue) * multiplier) : null);
      const lastKnownPrice = Number.isFinite(currentPrice)
        ? currentPrice
        : (Number.isFinite(marketValue) && qtyValue ? marketValue / (Math.abs(qtyValue) * multiplier) : null);
      mapped.push({
        symbol,
        optionSymbol: pos.symbol || pos.Symbol,
        description: pos.symbolDescription,
        side: callPut.toLowerCase(),
        strike: Number.isFinite(strike) ? strike : null,
        expiry,
        qty: qtyValue,
        entry,
        entry_price: entry,
        marketValue: Number.isFinite(marketValue) ? marketValue : null,
        lastKnownPrice,
        stop: null,
        target: null,
        source: 'etrade',
        accountIdKey: etradeAccount,
        portfolioView: usedView || requestedView,
      });
    }
    if (mapped.length === 0) {
      console.log(`ℹ️  No option positions found in E*TRADE portfolio view (${usedView || requestedView}).`);
    }
    return mapped;
  } catch (err) {
    console.error('❌ Failed to load E*TRADE positions:', err.message);
    return [];
  }
}

async function loadPositions(settings) {
  if ((settings.source || 'file') === 'etrade') {
    return await loadPositionsFromEtrade(settings);
  }
  return loadPositionsFromFile(settings.file);
}

async function getOptionFromChain(cache, { symbol, expiry, strike, side }) {
  if (!symbol || !expiry || !Number.isFinite(strike)) return null;
  const key = `${symbol}:${expiry}`;
  if (!cache.has(key)) {
    try {
      const chainResult = await fetchOptionChain({ symbol, expiry, includeGreeks: true });
      cache.set(key, chainResult);
    } catch (err) {
      console.warn(`⚠️  Failed to fetch option chain for ${symbol} ${expiry}:`, err.message);
      cache.set(key, { options: [] });
    }
  }
  const cached = cache.get(key) || { options: [] };
  const list = Array.isArray(cached.options) ? cached.options : Array.isArray(cached) ? cached : [];
  const candidate = pickNearestStrike(list, side, strike);
  if (candidate) return candidate;

  // Fallback to manual scan if selector could not match type formatting
  const type = side?.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  let best = null;
  let bestDiff = Infinity;
  for (const opt of list) {
    if (!opt || opt.type !== type) continue;
    if (!Number.isFinite(opt.strike)) continue;
    const diff = Math.abs(opt.strike - strike);
    if (diff < bestDiff) {
      best = opt;
      bestDiff = diff;
    }
  }
  return best;
}

async function analyzePosition(position, ctx) {
  const { symbol } = position;
  const side = (position.side || '').toLowerCase() === 'put' ? 'put' : 'call';
  const strike = Number(position.strike || position.strike_price);
  const expiry = position.expiry || position.expiry_date;
  const qty = Number(position.qty || position.quantity || 0);
  const entry = Number(position.entry_price || position.entry || 0);
  const stop = Number(position.stop || position.stop_price || 0);
  const target = Number(position.target || position.take_profit || 0);

  const quote = ctx.quotes[symbol];
  const option = await getOptionFromChain(ctx.chainCache, { symbol, expiry, strike, side });
  const optionMid = option ? midPrice(option) : null;
  const optionBid = option?.bid != null ? Number(option.bid) : null;
  const optionAsk = option?.ask != null ? Number(option.ask) : null;
  const optionLast = option?.last != null ? Number(option.last) : null;
  let optionPrice = optionMid ?? optionLast ?? optionAsk ?? optionBid ?? null;
  let priceSource = 'chain';
  if (optionPrice == null && Number.isFinite(position.lastKnownPrice)) {
    optionPrice = Number(position.lastKnownPrice);
    priceSource = 'portfolio';
  }

  const { bars, indicators } = await ctx.loadBars(symbol);
  const analysis = ctx.strategy === 'swing_trade'
    ? analyzeSwingTradeSignals(bars, indicators, quote?.price ?? bars.at(-1)?.c ?? 0)
    : analyzeDayTradeSignals(bars, indicators, quote?.price ?? bars.at(-1)?.c ?? 0);

  const pnl = optionPrice != null && entry
    ? Number(((optionPrice - entry) * (qty || 1) * 100).toFixed(2))
    : null;
  const gainPct = optionPrice != null && entry ? Number(((optionPrice - entry) / entry).toFixed(2)) : null;

  const recommendation = buildRecommendation({ position, optionPrice, analysis, stop, target, entry });

  let aiNote = null;
  if (ctx.ai && optionPrice != null) {
    aiNote = await buildAiNote({ position, optionPrice, quote, analysis, gainPct, ctx });
  }

  return {
    symbol,
    side,
    strike,
    expiry,
    qty,
    entry,
    stop,
    target,
    option,
    optionPrice,
    optionBid,
    optionAsk,
    optionLast,
    pnl,
    gainPct,
    priceSource,
    analysis,
    recommendation,
    aiNote,
  };
}

function buildRecommendation({ position, optionPrice, analysis, stop, target, entry }) {
  const rec = { action: 'hold', reasons: [] };
  if (optionPrice == null) {
    rec.action = 'monitor';
    rec.reasons.push('No live option quote available (market closed?)');
    return rec;
  }
  const stopLvl = stop || (entry ? entry * (1 - (position.stopLossPct || 0.2)) : null);
  const targetLvl = target || (entry ? entry * (1 + (position.takeProfitMult || 1.5)) : null);

  if (stopLvl && optionPrice <= stopLvl * 0.99) {
    rec.action = 'sell';
    rec.color = 'red';
    rec.reasons.push('Option price breached stop level');
  } else if (targetLvl && optionPrice >= targetLvl) {
    rec.action = 'take-profit';
    rec.reasons.push('Target price reached');
  } else {
    const gainPct = entry ? (optionPrice - entry) / entry : 0;
    const strength = analysis.strength ?? 0;
    if (gainPct >= 0.8) {
      rec.action = 'take-profit';
      rec.reasons.push('Gain exceeds 80% of premium');
    } else if (gainPct >= 0.5 && strength <= 0) {
      rec.action = 'trim';
      rec.reasons.push('Large gain but momentum cooling');
    } else if (gainPct >= 0.3 && strength > 0.3) {
      rec.action = 'hold';
      rec.reasons.push('Healthy gain with positive signals');
    } else if (gainPct <= -0.2) {
      rec.action = 'sell';
      rec.color = 'red';
      rec.reasons.push('Loss exceeds 20% of premium');
    } else if (gainPct <= -0.1 && strength > 0.35) {
      rec.action = 'consider-add';
      rec.reasons.push('Mild pullback with supportive signals');
    } else {
      rec.action = 'hold';
      rec.reasons.push('Within plan; no thresholds met');
    }
  }
  return rec;
}

async function buildAiNote({ position, optionPrice, quote, analysis, gainPct, ctx }) {
  try {
    const system = 'You monitor open options trades and must respond with a JSON object containing "action" and "rationale" keys.';
    const userPayload = {
      instruction: 'Return JSON guidance with keys action, rationale, riskFlags.',
      format: 'json',
      position,
      optionPrice,
      underlyingPrice: quote?.price ?? null,
      gainPct,
      analysis,
    };
    const client = ctx.aiClient || getClient(ctx.aiProvider);
    const res = await client.chatJson({
      model: ctx.aiModel,
      system,
      user: JSON.stringify(userPayload),
      timeout_ms: 10_000,
    });
    if (res && typeof res === 'object') {
      if (res.message) return res.message;
      const action = res.action || res.decision || res.recommendation;
      const rationale = res.rationale || res.reason || res.notes;
      if (action || rationale) {
        return [action, rationale].filter(Boolean).join(' — ');
      }
      if (res.summary) return res.summary;
      return JSON.stringify(res);
    }
    if (typeof res === 'string') return res;
    return null;
  } catch (err) {
    console.warn('⚠️  AI note failed:', err.message);
    return null;
  }
}

function printHeader(runId) {
  console.log('\n==================== POSITION GUARDIAN ====================');
  console.log(`Tick: ${new Date().toISOString()} | Run ${runId}`);
}

function printResult(res) {
  const header = `${res.symbol} ${res.expiry || ''} ${res.strike}${res.side === 'put' ? 'P' : 'C'} x${res.qty || 1}`.trim();
  console.log(`\n${header}`);
  console.log(`Entry $${res.entry || 'N/A'} | Stop $${res.stop || 'N/A'} | Target $${res.target || 'N/A'}`);
  if (res.optionPrice != null) {
    const bid = res.optionBid != null ? res.optionBid.toFixed(2) : '—';
    const ask = res.optionAsk != null ? res.optionAsk.toFixed(2) : '—';
    const last = res.optionLast != null ? res.optionLast.toFixed(2) : '—';
    const pnl = res.pnl != null ? `${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(2)}` : 'N/A';
    const gain = res.gainPct != null ? `${(res.gainPct * 100).toFixed(1)}%` : 'N/A';
    if (res.priceSource === 'portfolio') {
      console.log(`Now ~$${res.optionPrice.toFixed(2)} (portfolio snapshot) | P/L ${pnl} | Δ ${gain}`);
    } else {
      console.log(`Now ~$${res.optionPrice.toFixed(2)} (bid ${bid} / ask ${ask} / last ${last}) | P/L ${pnl} | Δ ${gain}`);
    }
  } else {
    console.log('Now ~$— (no live option data)');
  }
  const signals = res.analysis?.signals?.length ? res.analysis.signals.join(', ') : 'none';
  console.log(`Signals: ${signals} | Strength ${(res.analysis?.strength ?? 0).toFixed(2)}`);
  const actionLabel = res.recommendation.color === 'red'
    ? colorize('red', String(res.recommendation.action).toUpperCase())
    : res.recommendation.action;
  console.log(`Recommendation: ${actionLabel} — ${res.recommendation.reasons.join('; ')}`);
  if (res.recommendation.color === 'red') {
    // Emit terminal bell and flashing alert for urgent sell signals
    process.stdout.write('\x07\x07');
    console.log(blink(colorize('red', '*** STRONG SELL ALERT ***')));
  }
  if (res.aiNote) {
    console.log(`AI note: ${res.aiNote}`);
  }
}

async function createContext(settings, positions) {
  const uniqueSymbols = [...new Set(positions.map(p => p.symbol).filter(Boolean))];
  const quotes = uniqueSymbols.length
    ? await getQuotes(uniqueSymbols, { provider: settings.provider }).catch(err => {
        console.warn('⚠️  Quote fetch failed:', err.message);
        return {};
      })
    : {};

  const barsCache = new Map();
  async function loadBars(symbol) {
    if (barsCache.has(symbol)) return barsCache.get(symbol);
    try {
      const data = await fetchBarsWithFallback(symbol, { range: '1d', interval: '1m' });
      barsCache.set(symbol, data);
      return data;
    } catch (err) {
      console.warn(`⚠️  Failed to fetch bars for ${symbol}:`, err.message);
      const fallback = { bars: [], indicators: {} };
      barsCache.set(symbol, fallback);
      return fallback;
    }
  }

  return {
    quotes,
    strategy: settings.strategy,
    ai: settings.ai,
    aiModel: settings.aiModel,
    aiProvider: settings.aiProvider,
    aiClient: settings.aiClient || getClient(settings.aiProvider),
    chainCache: new Map(),
    loadBars,
  };
}

async function runOnce(settings, runId = 1) {
  const positions = await loadPositions(settings);
  printHeader(runId);
  if (settings.ai) {
    console.log(`AI provider: ${settings.aiProvider} | model: ${settings.aiModel}`);
  }
  if (!positions.length) {
    if ((settings.source || 'file') === 'etrade') {
      console.log('No option positions found via E*TRADE API.');
    } else {
      console.log('No open positions found. Update data/open-positions.json to begin monitoring.');
    }
    return;
  }

  const ctx = await createContext(settings, positions);
  for (const position of positions) {
    try {
      const res = await analyzePosition(position, ctx);
      printResult(res);
    } catch (err) {
      console.error(`❌ Failed to analyze ${position.symbol}:`, err.message);
    }
  }
}

async function main() {
  const settings = parseArgs(process.argv);
  settings.aiClient = getClient(settings.aiProvider);
  settings.aiProvider = settings.aiClient.name;
  if (!settings.aiModel) settings.aiModel = settings.aiClient.defaultModel;
  if (settings.watch) {
    let runId = 1;
    while (true) {
      await runOnce(settings, runId++);
      await sleep(settings.intervalMs);
    }
  } else {
    await runOnce(settings, 1);
  }
}

main().catch(err => {
  console.error('💥 Guardian fatal error:', err);
  process.exit(1);
});
