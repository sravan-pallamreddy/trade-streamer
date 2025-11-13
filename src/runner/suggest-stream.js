#!/usr/bin/env node
require('dotenv').config();

const { buildSuggestion } = require('../strategy/options');
const { computeQty } = require('../risk');
const { getQuotes } = require('../providers/quotes');
const etrade = require('../providers/etrade');
const { getClient } = require('../ai/client');
const { buildSystemPrompt, buildUserPrompt } = require('../ai/prompt');
const gates = require('../rules/gates');
const bars = require('../providers/bars');
const { pickByDelta, pickByPremium, pickNearestStrike, selectOptimalOption, midPrice } = require('../strategy/selector');
const { fetchOptionChain } = require('../providers/options-chain');
const { analyzeDayTradeSignals, analyzeSwingTradeSignals, recommendOptionStrategy, detectBreakout, detectReversal } = require('../strategy/algorithms');

function parseArgs(argv) {
  const defaultAiClient = getClient(process.env.STREAM_AI_PROVIDER || process.env.AI_PROVIDER);
  const aiModelEnv = process.env.AI_MODEL;
  const out = {
    symbols: process.env.SCAN_SYMBOLS ? process.env.SCAN_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [],
    side: 'both', // call|put|both
    account: process.env.ACCOUNT_SIZE ? Number(process.env.ACCOUNT_SIZE) : undefined,
    riskPct: process.env.RISK_PCT ? Number(process.env.RISK_PCT) : 0.01,
    iv: process.env.DEFAULT_IV ? Number(process.env.DEFAULT_IV) : 0.2,
    r: process.env.RISK_FREE ? Number(process.env.RISK_FREE) : 0.01,
  otmPct: process.env.OTM_PCT != null ? Number(process.env.OTM_PCT) : null,
    minBusinessDays: process.env.MIN_BUSINESS_DAYS ? Number(process.env.MIN_BUSINESS_DAYS) : 2,
    stopLossPct: process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : 0.5,
    takeProfitMult: process.env.TAKE_PROFIT_MULT ? Number(process.env.TAKE_PROFIT_MULT) : 2.0,
    intervalSec: process.env.STREAM_INTERVAL_SEC ? Number(process.env.STREAM_INTERVAL_SEC) : 30,
    provider: process.env.QUOTE_PROVIDER || 'yahoo',
    debug: !!process.env.DEBUG_QUOTES,
    ai: !!process.env.USE_AI,
  aiProvider: defaultAiClient.name,
  aiModel: aiModelEnv || defaultAiClient.defaultModel,
    aiIntervalSec: process.env.AI_INTERVAL_SEC ? Number(process.env.AI_INTERVAL_SEC) : 60,
    table: !!process.env.TABLE_OUTPUT,
    json: !!process.env.JSON_OUTPUT,
    rules: !!process.env.RULES,
    strict: !!process.env.RULES_STRICT,
    fast: process.env.RULES_FAST ? Number(process.env.RULES_FAST) : 5,
    slow: process.env.RULES_SLOW ? Number(process.env.RULES_SLOW) : 20,
    futConfirm: !!process.env.RULES_FUTURES,
    vwap: !!process.env.RULES_VWAP,
    rvol: process.env.RULES_RVOL ? Number(process.env.RULES_RVOL) : 0,
    expiry: process.env.OPTIONS_EXPIRY || undefined,
    targetDelta: process.env.TARGET_DELTA ? Number(process.env.TARGET_DELTA) : undefined,
    targetPremium: process.env.TARGET_PREMIUM ? Number(process.env.TARGET_PREMIUM) : undefined,
    expiryType: process.env.EXPIRY_TYPE || 'weekly',
  };
  const args = argv.slice(2);
  let aiModelExplicit = Boolean(aiModelEnv);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--symbols' && args[i + 1]) { out.symbols = args[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean); continue; }
    if (a === '--side' && args[i + 1]) { out.side = args[++i]; continue; }
    if (a === '--account' && args[i + 1]) { out.account = Number(args[++i]); continue; }
    if (a === '--risk-pct' && args[i + 1]) { out.riskPct = Number(args[++i]); continue; }
    if (a === '--iv' && args[i + 1]) { out.iv = Number(args[++i]); continue; }
    if (a === '--r' && args[i + 1]) { out.r = Number(args[++i]); continue; }
  if (a === '--otm-pct' && args[i + 1]) { out.otmPct = Number(args[++i]); continue; }
    if (a === '--min-days' && args[i + 1]) { out.minBusinessDays = Number(args[++i]); continue; }
    if (a === '--sl-pct' && args[i + 1]) { out.stopLossPct = Number(args[++i]); continue; }
    if (a === '--tp-mult' && args[i + 1]) { out.takeProfitMult = Number(args[++i]); continue; }
    if (a === '--interval' && args[i + 1]) { out.intervalSec = Number(args[++i]); continue; }
    if (a === '--provider' && args[i + 1]) { out.provider = args[++i]; continue; }
    if (a === '--debug') { out.debug = true; continue; }
    if (a === '--ai') { out.ai = true; continue; }
    if (a === '--ai-provider' && args[i + 1]) {
      const client = getClient(args[++i]);
      out.aiProvider = client.name;
      if (!aiModelExplicit) out.aiModel = client.defaultModel;
      continue;
    }
    if (a === '--ai-model' && args[i + 1]) { out.aiModel = args[++i]; aiModelExplicit = true; continue; }
    if (a === '--ai-interval' && args[i + 1]) { out.aiIntervalSec = Number(args[++i]); continue; }
    if (a === '--table') { out.table = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--rules') { out.rules = true; continue; }
    if (a === '--strict') { out.strict = true; continue; }
    if (a === '--fast' && args[i + 1]) { out.fast = Number(args[++i]); continue; }
    if (a === '--slow' && args[i + 1]) { out.slow = Number(args[++i]); continue; }
    if (a === '--futures-confirm') { out.futConfirm = true; continue; }
    if (a === '--expiry' && args[i + 1]) { out.expiry = args[++i]; continue; }
    if (a === '--odte') {
      // Convenience: force expiry to today (ET) and allow min days 0 + tighten OTM default if not overridden
      const dt = new Date();
      const yyyy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      out.expiry = `${yyyy}-${mm}-${dd}`;
      if (out.minBusinessDays > 0) out.minBusinessDays = 0;
      if (out.otmPct == null) {
        out.otmPct = 0.01;
      } else {
        out.otmPct = Math.min(out.otmPct, 0.01);
      }
      continue;
    }
    if (a === '--target-delta' && args[i + 1]) { out.targetDelta = Number(args[++i]); continue; }
    if (a === '--target-premium' && args[i + 1]) { out.targetPremium = Number(args[++i]); continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function usage() {
  console.log(`Usage: npm run suggest:stream -- --symbols SPY,QQQ,AAPL [--side both|call|put] --account 25000 [--interval 15] [--ai --ai-provider deepseek]\n`+
  `Env: ACCOUNT_SIZE, SCAN_SYMBOLS, RISK_PCT, DEFAULT_IV, RISK_FREE, OTM_PCT, MIN_BUSINESS_DAYS, STOP_LOSS_PCT, TAKE_PROFIT_MULT, STREAM_INTERVAL_SEC, QUOTE_PROVIDER, USE_AI, AI_PROVIDER, AI_MODEL, AI_INTERVAL_SEC`);
}

async function makeSuggestion({ symbol, price, side, params }) {
  const suggestion = buildSuggestion({
    symbol,
    side,
    underlyingPrice: price,
    iv: params.iv,
    r: params.r,
    otmPct: params.otmPct,
    minBusinessDays: params.minBusinessDays,
    expiryOverride: params.expiry,
    expiryType: params.expiryType,
    stopLossPct: params.stopLossPct,
    takeProfitMult: params.takeProfitMult,
  });
  let chainSource = null;
  let liveOption = null;

  try {
    const chainResult = await fetchOptionChain({ symbol, expiry: suggestion.expiry, includeGreeks: true });
    chainSource = chainResult.source || null;
    const chain = Array.isArray(chainResult.options) ? chainResult.options : [];

    if (!chain.length && params.debug) {
      console.warn(`Option chain empty for ${symbol} ${suggestion.expiry}; using theoretical pricing`);
    }

    let candidate = null;
    if (params.targetDelta) candidate = pickByDelta(chain, side, params.targetDelta);
    if (!candidate && params.targetPremium) candidate = pickByPremium(chain, side, params.targetPremium);
    if (!candidate) {
      const defaultDelta = side === 'put' ? -0.35 : 0.35;
      candidate = selectOptimalOption(chain, side, {
        targetDelta: defaultDelta,
        maxSpreadPct: 0.4,
        minOpenInterest: 100,
      });
    }
    if (!candidate) {
      candidate = pickNearestStrike(chain, side, suggestion.strike);
    }

    if (candidate) {
      liveOption = candidate;
      const chosenStrike = Number(candidate.strike);
      if (Number.isFinite(chosenStrike)) {
        suggestion.contract = `${symbol} ${suggestion.expiry} ${chosenStrike}${side.toUpperCase().startsWith('C') ? 'C' : 'P'}`;
        suggestion.strike = chosenStrike;
      }
      const entry = midPrice(candidate) ?? candidate.ask ?? candidate.last ?? candidate.bid;
      if (Number.isFinite(entry)) {
        const spread = candidate.bid != null && candidate.ask != null ? candidate.ask - candidate.bid : null;
        const spreadPct = spread != null && entry > 0 ? (spread / entry) * 100 : null;
        suggestion.est_entry = Number(entry.toFixed(2));
        suggestion.stop = Number((entry * (1 - params.stopLossPct)).toFixed(2));
        suggestion.take_profit = Number((entry * (1 + params.takeProfitMult)).toFixed(2));
        suggestion.bid = Number.isFinite(candidate.bid) ? Number(candidate.bid.toFixed(2)) : null;
        suggestion.ask = Number.isFinite(candidate.ask) ? Number(candidate.ask.toFixed(2)) : null;
        suggestion.last = Number.isFinite(candidate.last) ? Number(candidate.last.toFixed(2)) : null;
        suggestion.delta = candidate.delta ?? null;
        suggestion.oi = Number.isFinite(candidate.oi) ? candidate.oi : null;
        suggestion.volume = Number.isFinite(candidate.vol) ? candidate.vol : null;
        suggestion.entry_source = chainSource ? `${chainSource}_chain` : 'options_chain';
        suggestion.option_symbol = candidate.optionSymbol ?? suggestion.option_symbol ?? null;
        suggestion.liquidity = {
          spread: spread != null ? Number(spread.toFixed(2)) : null,
          spread_pct: spreadPct != null ? Number(spreadPct.toFixed(2)) : null,
          oi: suggestion.oi,
          volume: suggestion.volume,
        };
      } else if (Number.isFinite(suggestion.strike)) {
        suggestion.entry_source = 'model_chain_fallback';
        suggestion.option_symbol = candidate.optionSymbol ?? suggestion.option_symbol ?? null;
      }
    }
  } catch (err) {
    if (params.debug) {
      console.warn(`Option chain fetch failed for ${symbol}: ${err.message}`);
    }
  }

  if (!liveOption) {
    suggestion.entry_source = 'model';
  }

  const sizing = computeQty({ accountSize: params.account, riskPct: params.riskPct, entry: suggestion.est_entry, stop: suggestion.stop, multiplier: suggestion.multiplier });
  return {
    ...suggestion,
    chain_source: chainSource,
    qty: sizing.qty,
    risk_per_contract: Number(sizing.perContractRisk.toFixed(2)),
    risk_total: Number(sizing.totalRisk.toFixed(2)),
    meta: { price, side },
  };
}

function pad(str, len) {
  const s = String(str);
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

function printTable(rows, { includeAI = true } = {}) {
  if (!rows.length) return;
  const headers = [
    { h: 'SYM', w: 5 },
    { h: 'SIDE', w: 5 },
    { h: 'CONTRACT', w: 22 },
    { h: 'UNDER', w: 8 },
    { h: 'ENTRY', w: 7 },
    { h: 'STOP', w: 7 },
    { h: 'TP', w: 7 },
    { h: 'QTY', w: 5 },
    { h: 'RISK/CT', w: 8 },
    { h: 'SRC', w: 6 },
  ];
  if (includeAI) headers.push({ h: 'AI(dec/conf)', w: 14 });
  const headerLine = headers.map(x => pad(x.h, x.w)).join(' | ');
  console.log(headerLine);
  console.log('-'.repeat(headerLine.length));
  for (const r of rows) {
    const base = [
      pad(r.symbol, 5),
      pad(r.side || '-', 5),
      pad(r.contract || r.label || '-', 22),
      pad(r.under != null ? r.under.toFixed(2) : '-', 8),
      pad(r.entry != null ? r.entry.toFixed(2) : '-', 7),
      pad(r.stop != null ? r.stop.toFixed(2) : '-', 7),
      pad(r.tp != null ? r.tp.toFixed(2) : '-', 7),
      pad(r.qty != null ? r.qty : '-', 5),
      pad(r.riskCt != null ? r.riskCt.toFixed(0) : '-', 8),
      pad(r.src || '-', 6),
    ];
    if (includeAI) {
      const a = r.ai ? `${r.ai.decision || ''}/${(r.ai.confidence ?? '').toString().slice(0,4)}` : '';
      base.push(pad(a, 14));
    }
    console.log(base.join(' | '));
  }
}

async function loop(params) {
  if (!params.account) {
    console.error('Missing --account or ACCOUNT_SIZE in env.');
    return usage();
  }
  if (!params.symbols || params.symbols.length === 0) {
    console.error('Missing --symbols or SCAN_SYMBOLS in env. Please specify stocks to scan.');
    return usage();
  }
  params.aiClient = params.aiClient || getClient(params.aiProvider);
  params.aiProvider = params.aiClient.name;
  if (!params.aiModel) params.aiModel = params.aiClient.defaultModel;
  console.log(`Starting suggest stream for [${params.symbols.join(', ')}], side=${params.side}, interval=${params.intervalSec}s, provider=${params.provider}`);
  if (params.ai) {
    console.log(`AI provider: ${params.aiProvider} | model: ${params.aiModel} | cadence: ${params.aiIntervalSec}s`);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const started = Date.now();
    try {
      let quotes = {};
      const futSet = new Set(['ES','NQ','MES','MNQ']);
      if (params.provider === 'etrade' || params.provider === 'mix') {
        const eqSymbols = params.symbols.filter(s => !futSet.has(s.toUpperCase()));
        const fuSymbols = params.symbols.filter(s => futSet.has(s.toUpperCase()));
        if (eqSymbols.length) {
          try {
            const q = await etrade.getEquityQuotes(eqSymbols);
            quotes = { ...quotes, ...q };
          } catch (e) {
            console.error('E*TRADE quote error:', e.message || String(e));
          }
        }
        if (fuSymbols.length) {
          try {
            const qf = await getQuotes(fuSymbols, { provider: 'yahoo', debug: params.debug });
            quotes = { ...quotes, ...qf };
          } catch (e) {
            console.error('Futures (Yahoo) error:', e.message || String(e));
          }
        }
      } else {
        quotes = await getQuotes(params.symbols, { provider: params.provider, debug: params.debug });
      }
      if (params.debug) {
        console.log('quotes keys:', Object.keys(quotes));
      }
      // Update rule buffers with all quotes
      for (const [k, v] of Object.entries(quotes)) {
        gates.pushQuote({ symbol: k, price: v.price, ts: v.ts });
      }
      // Fetch bars for equities for VWAP/RVOL and technical indicators (Yahoo)
      if (params.rules && (params.vwap || (params.rvol && params.rvol > 0)) || params.ai) {
        const eqSyms = params.symbols.filter(s => !['ES','NQ','MES','MNQ'].includes(s.toUpperCase()));
        for (const s of eqSyms) {
          try {
            const symYahoo = s; // SPY/QQQ supported directly
            const { bars: b, indicators } = await bars.fetchYahooBarsWithIndicators(symYahoo, { range: '1d', interval: '1m' });
            if (b && b.length) {
              let sumPV = 0, sumV = 0;
              const n = b.length;
              const tail = b.slice(Math.max(0, n - 20));
              let volSum = 0;
              for (const x of b) { if (x.v) { sumPV += x.c * x.v; sumV += x.v; } }
              for (const x of tail) { volSum += x.v || 0; }
              const lastVol = tail[tail.length - 1]?.v || 0;
              const avgVol = tail.length ? volSum / tail.length : 0;
              const vwap = sumV > 0 ? (sumPV / sumV) : null;
              const rvol = avgVol > 0 ? (lastVol / avgVol) : null;
              gates.setMetrics(s, { vwap, rvol, lastVol, avgVol, indicators });
            }
          } catch (e) {
            if (params.debug) console.log('bars error', s, e.message || String(e));
          }
        }
      }
      const suggestions = [];
      const tableRows = [];
      for (const sym of params.symbols) {
        const q = quotes[sym];
        if (!q) { if (!params.table) console.log(`${sym}: quote unavailable`); continue; }
        // Try options suggestion; if unsupported (e.g., futures), print a simple watch line
        const sides = params.side === 'both' ? ['call', 'put'] : [params.side];
        let anyPrinted = false;
        for (const sd of sides) {
          try {
            const sug = await makeSuggestion({ symbol: sym, price: q.price, side: sd, params: { ...params, expiry: params.expiry } });
            // Apply rules if enabled
            let rule = { pass: true, reasons: [] };
            if (params.rules) {
              rule = gates.evaluate(sym, sd, { fast: params.fast, slow: params.slow, requireTrend: true, requireFutures: params.futConfirm, requireVWAP: params.vwap, minRVOL: params.rvol });
            }
            if (params.strict && !rule.pass) continue;
            suggestions.push(sug);
            if (!params.table) {
              const header = `${sym} ${sd.toUpperCase()} @ ${q.price.toFixed(2)} | ${sug.contract}`;
              const line1 = `  Entry ~$${sug.est_entry} | Stop $${sug.stop} | TP $${sug.take_profit}`;
              const sourceLabel = sug.entry_source ? `source ${sug.entry_source}` : 'source model';
              const chainLabel = sug.chain_source ? ` | chain ${sug.chain_source}` : '';
              const line2 = `  Qty ${sug.qty} | Risk/ct $${sug.risk_per_contract} | Risk total $${sug.risk_total} (${sourceLabel}${chainLabel})`;
              console.log(header); console.log(line1); console.log(line2); console.log('');
              if (params.rules) {
                console.log(`  Rules: ${rule.pass ? 'PASS' : 'FAIL'} ${rule.reasons.join(',')}`);
              }
            }
            if (params.json) {
              process.stdout.write(JSON.stringify({ type: 'option_suggestion', ts: new Date().toISOString(), symbol: sym, price: q.price, suggestion: sug }) + '\n');
            }

            if (params.ai) {
              global.__ai_last = global.__ai_last || {};
              const key = `${sym}:${sd}`;
              const now = Date.now();
              const last = global.__ai_last[key] || 0;
              if ((now - last) / 1000 >= params.aiIntervalSec) {
                global.__ai_last[key] = now;
                const ind = gates.computeIndicators(sym, { fast: params.fast, slow: params.slow });
                const futSym = gates.mapFutures(sym);
                const futInd = futSym ? gates.computeIndicators(futSym, { fast: params.fast, slow: params.slow }) : null;
                const m = gates.getMetrics(sym);

                // Add algorithmic analysis
                const bars = m?.bars || [];
                const indicators = m?.indicators || {};
                const dayAnalysis = analyzeDayTradeSignals(bars, indicators, q.price);
                const swingAnalysis = analyzeSwingTradeSignals(bars, indicators, q.price);
                const breakout = detectBreakout(bars, q.price);
                const reversal = detectReversal(bars, indicators);

                const algorithmic = {
                  dayTrade: dayAnalysis,
                  swingTrade: swingAnalysis,
                  breakout,
                  reversal,
                  recommendedStrategy: recommendOptionStrategy(dayAnalysis.strength, Math.sign(dayAnalysis.strength))
                };

                const context = {
                  price: q.price,
                  source: q.source,
                  ts: q.ts,
                  rules: { enabled: !!params.rules, strict: !!params.strict, pass: rule.pass, reasons: rule.reasons, ind, fut: futInd, metrics: m },
                  algorithmic
                };
                try {
                  const system = buildSystemPrompt();
                  const user = buildUserPrompt({ suggestion: sug, context });
                  const ai = await params.aiClient.chatJson({ model: params.aiModel, system, user, timeout_ms: 15000 });
                  if (!params.table) console.log(`  AI decision=${ai.decision || 'n/a'} conf=${ai.confidence ?? 'n/a'} flags=${Array.isArray(ai.risk_flags)?ai.risk_flags.join('|'):'-'}\n  notes: ${ai.notes || ''}`);
                  if (params.json) {
                    process.stdout.write(JSON.stringify({ type: 'option_suggestion_ai', ts: new Date().toISOString(), symbol: sym, side: sd, ai, suggestion: sug }) + '\n');
                  }
                  global.__ai_cache = global.__ai_cache || {};
                  global.__ai_cache[key] = ai;
                } catch (e) {
                  if (!params.table) console.log(`  AI error: ${e.message || String(e)}`);
                }
              }
            }
            // Add table row
            if (params.table) {
              const key = `${sym}:${sd}`;
              const ai = (global.__ai_cache && global.__ai_cache[key]) || null;
              tableRows.push({
                symbol: sym,
                side: sd.toUpperCase(),
                contract: sug.contract,
                under: q.price,
                entry: sug.est_entry,
                stop: sug.stop,
                tp: sug.take_profit,
                qty: sug.qty,
                riskCt: sug.risk_per_contract,
                src: q.source,
                rules: rule,
                ai,
              });
            }
            anyPrinted = true;
          } catch (e) {
            // Unsupported symbol for options; ignore and fall through to watch line
          }
        }
        if (!anyPrinted) {
          if (!params.table) {
            const line = `${sym} FUTURES WATCH @ ${q.price.toFixed(2)} (src=${q.source})`;
            console.log(line);
          } else {
            tableRows.push({ symbol: sym, side: 'FUT', label: 'FUTURES WATCH', under: q.price, src: q.source });
          }
          if (params.json) {
            process.stdout.write(JSON.stringify({ type: 'futures_watch', ts: new Date().toISOString(), symbol: sym, price: q.price, provider: q.source }) + '\n');
          }
        }
      }
      if (params.table && tableRows.length) {
        printTable(tableRows, { includeAI: params.ai });
        console.log('');
      }
    } catch (e) {
      console.error('Stream error:', e.message || String(e));
    }
    const elapsed = (Date.now() - started) / 1000;
    const sleepSec = Math.max(1, params.intervalSec - elapsed);
    await new Promise(r => setTimeout(r, sleepSec * 1000));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  await loop(args);
}

main().catch(err => { console.error(err); process.exit(1); });
