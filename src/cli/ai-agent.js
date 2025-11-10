#!/usr/bin/env node
// AI Agent for scanning stocks and suggesting options trades
require('dotenv').config();

const util = require('util');
const { buildSuggestion } = require('../strategy/options');
const { computeQty } = require('../risk');
const { getQuotes } = require('../providers/quotes');
const etrade = require('../providers/etrade');
const { getClient } = require('../ai/client');
const { buildSystemPrompt, buildUserPrompt } = require('../ai/prompt');
const { fetchBarsWithFallback } = require('../providers/bars');
const { analyzeDayTradeSignals, analyzeSwingTradeSignals, recommendOptionStrategy } = require('../strategy/algorithms');
const { evaluateStrategies } = require('../strategy/playbooks');
const { selectOptimalOption, midPrice } = require('../strategy/selector');

const sleep = util.promisify(setTimeout);

function buildScalingPlan({ qty, entry, takeProfit, stop }) {
  const plan = { qty, stop, iterations: [] };
  if (!Number.isFinite(qty) || qty <= 0) return plan;

  const entryPrice = Number.isFinite(entry) ? entry : null;
  const baseTarget = Number.isFinite(takeProfit) ? Number(takeProfit.toFixed(2)) : null;
  const diff = entryPrice != null && baseTarget != null ? baseTarget - entryPrice : null;

  const scaledTarget = (factor) => {
    if (diff == null || entryPrice == null) return baseTarget;
    return Number((entryPrice + diff * factor).toFixed(2));
  };

  const addIteration = (sellQty, target, note) => {
    const qtyInt = Math.max(0, Math.round(sellQty));
    if (qtyInt <= 0) return;
    let targetRounded = null;
    if (target != null) {
      const numericTarget = Number(target);
      targetRounded = Number.isFinite(numericTarget) ? Number(numericTarget.toFixed(2)) : null;
    }
    plan.iterations.push({
      sellQty: qtyInt,
      target: targetRounded,
      note,
    });
  };

  if (qty === 1) {
    addIteration(1, baseTarget, 'Exit full position at target or earlier if momentum fades.');
    return plan;
  }

  const firstQty = Math.max(1, Math.ceil(qty * 0.5));
  addIteration(firstQty, baseTarget, 'Scale out half and move stop to breakeven once target prints.');
  let remaining = qty - firstQty;
  if (remaining <= 0) return plan;

  if (remaining === 1) {
    addIteration(1, scaledTarget(1.3), 'Let final runner stretch; trail stop below last higher low.');
    return plan;
  }

  const secondQty = Math.max(1, Math.floor(remaining / 2));
  addIteration(secondQty, scaledTarget(1.3), 'Take additional profits if extension continues; trail stop under VWAP.');
  remaining -= secondQty;

  if (remaining > 0) {
    addIteration(remaining, scaledTarget(1.6), 'Leave final runner for outsized move; ratchet stop up aggressively.');
  }

  return plan;
}

function parseArgs(argv) {
  const defaultAiClient = getClient(process.env.AGENT_AI_PROVIDER || process.env.AI_PROVIDER);
  const aiModelEnv = process.env.AI_MODEL;
  const out = {
    symbols: process.env.SCAN_SYMBOLS ? process.env.SCAN_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [],
    account: process.env.ACCOUNT_SIZE ? Number(process.env.ACCOUNT_SIZE) : undefined,
    riskPct: process.env.RISK_PCT ? Number(process.env.RISK_PCT) : 0.01,
    iv: process.env.DEFAULT_IV ? Number(process.env.DEFAULT_IV) : 0.2,
    r: process.env.RISK_FREE ? Number(process.env.RISK_FREE) : 0.01,
    otmPct: process.env.OTM_PCT ? Number(process.env.OTM_PCT) : 0.02,
    minBusinessDays: process.env.MIN_BUSINESS_DAYS ? Number(process.env.MIN_BUSINESS_DAYS) : 2,
    stopLossPct: process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : 0.5,
    takeProfitMult: process.env.TAKE_PROFIT_MULT ? Number(process.env.TAKE_PROFIT_MULT) : 2.0,
    provider: process.env.QUOTE_PROVIDER || 'yahoo',
    aiProvider: defaultAiClient.name,
    aiModel: aiModelEnv || defaultAiClient.defaultModel,
    expiryType: process.env.EXPIRY_TYPE || 'weekly',
    expiryOverride: process.env.OPTIONS_EXPIRY || process.env.EXPIRY_OVERRIDE || undefined,
    strategy: process.env.TRADING_STRATEGY || 'day_trade', // day_trade | swing_trade
    debug: !!process.env.DEBUG,
    watch: process.env.AGENT_WATCH?.toLowerCase() === 'true',
    intervalMs: Number(process.env.AGENT_INTERVAL_MS) || 30_000,
  };
  const args = argv.slice(2);
  let aiModelExplicit = Boolean(aiModelEnv);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--symbols' && args[i + 1]) { out.symbols = args[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean); continue; }
    if (a === '--account' && args[i + 1]) { out.account = Number(args[++i]); continue; }
    if (a === '--risk-pct' && args[i + 1]) { out.riskPct = Number(args[++i]); continue; }
    if (a === '--strategy' && args[i + 1]) { out.strategy = args[++i]; continue; }
    if (a === '--expiry-type' && args[i + 1]) { out.expiryType = args[++i]; continue; }
    if ((a === '--expiry' || a === '--expiry-date') && args[i + 1]) { out.expiryOverride = args[++i]; continue; }
    if (a === '--ai-provider' && args[i + 1]) {
      const client = getClient(args[++i]);
      out.aiProvider = client.name;
      if (!aiModelExplicit) out.aiModel = client.defaultModel;
      continue;
    }
    if (a === '--ai-model' && args[i + 1]) { out.aiModel = args[++i]; aiModelExplicit = true; continue; }
    if (a === '--debug') { out.debug = true; continue; }
    if (a === '--watch' || a === '-w') { out.watch = true; continue; }
    if (a === '--no-watch' || a === '--once') { out.watch = false; continue; }
    if ((a === '--interval' || a === '-i') && args[i + 1]) { out.intervalMs = Number(args[++i]) * 1000; continue; }
    if (a === '--interval-ms' && args[i + 1]) { out.intervalMs = Number(args[++i]); continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function usage() {
  console.log(`Usage: npm run ai-agent -- --symbols AAPL,TSLA,GOOGL [--account 25000] [--strategy day_trade|swing_trade] [--expiry-type weekly|monthly|0dte]\n`+
  `AI Agent for scanning stocks and suggesting options trades using technical analysis and AI.\n\n`+
  `Options:\n`+
  `  --symbols <list>         Comma-separated list of symbols to scan (required)\n`+
  `  --account <num>          Account size in USD (required)\n`+
  `  --strategy <type>        Trading strategy: day_trade or swing_trade (default: day_trade)\n`+
  `  --expiry-type <type>     Options expiry: weekly, monthly, or 0dte (default: weekly)\n`+
  `  --risk-pct <num>         Risk per trade fraction (default: 0.01)\n`+
  `  --ai-provider <name>     AI provider (openai|xai)\n`+
  `  --ai-model <model>       AI model to use (default depends on provider)\n`+
  `  --watch                  Continuously rerun at the configured interval\n`+
  `  --once / --no-watch      Run a single scan and exit\n`+
  `  --interval <sec>         Interval between scans in seconds (default: 30)\n`+
  `  --debug                  Enable debug output\n\n`+
  `Environment variables: SCAN_SYMBOLS, ACCOUNT_SIZE, TRADING_STRATEGY, EXPIRY_TYPE, etc.`);
}

  function computeTargetDelta(strategyType, strength, side) {
    const abs = Math.min(1, Math.abs(strength));
    const base = side === 'call' ? 0.35 : -0.35;
    const aggressiveness = strategyType === 'day_trade' ? 0.08 : 0.12;
    const adjust = abs * aggressiveness + (abs > 0.6 ? 0.05 : 0);
    let target = base + (side === 'call' ? adjust : -adjust);
    const min = side === 'call' ? 0.2 : -0.75;
    const max = side === 'call' ? 0.75 : -0.2;
    if (target < min) target = min;
    if (target > max) target = max;
    return target;
  }

async function analyzeSymbol(symbol, params) {
  try {
    console.log(`\n🔍 Analyzing ${symbol}...`);

    const aiClient = params.aiClient || getClient(params.aiProvider);

    // Get current quote
    const quotes = await getQuotes([symbol], { provider: params.provider, debug: params.debug });
    const quote = quotes[symbol];
    if (!quote) {
      console.log(`❌ No quote available for ${symbol}`);
      return null;
    }

    console.log(`📊 Current price: $${quote.price.toFixed(2)} (${quote.source})`);

    // Get technical indicators
    const { bars, indicators } = await fetchBarsWithFallback(symbol, { range: '1d', interval: '1m' });
    if (params.debug) {
      console.log(`📈 Indicators: RSI=${indicators.rsi?.toFixed(2) || 'N/A'}, MACD=${indicators.macd?.macd?.toFixed(4) || 'N/A'}`);
    }

    // Analyze signals
    const dayAnalysis = analyzeDayTradeSignals(bars, indicators, quote.price);
    const swingAnalysis = analyzeSwingTradeSignals(bars, indicators, quote.price);

    const analysis = params.strategy === 'swing_trade' ? swingAnalysis : dayAnalysis;
    const strategyType = params.strategy;

    const strategyInsights = evaluateStrategies({
      bars,
      indicators,
      price: quote.price,
      volume: indicators.volume,
      avgVolume: indicators.avgVolume,
    });

    if (strategyInsights?.primary) {
      const primary = strategyInsights.primary;
      const directionLabel = primary.bias === 'neutral' ? 'neutral bias' : `${primary.bias} bias`;
      const scoreLabel = Number.isFinite(primary.score) ? (primary.score * 100).toFixed(1) : '0.0';
      console.log(`🧭 Primary playbook: ${primary.label} (${directionLabel}, score ${scoreLabel}pts)`);
    }

    console.log(`🎯 ${strategyType.toUpperCase()} Analysis: Strength ${(analysis.strength * 100).toFixed(0)}%`);
    console.log(`📋 Signals: ${analysis.signals.join(', ') || 'none'}`);

    if (Math.abs(analysis.strength) < 0.2) {
      console.log(`⏭️  Skipping ${symbol} - insufficient signal strength`);
      return null;
    }

    // Determine option type based on signal strength (will reconcile with playbook bias later)
    let side = analysis.strength > 0 ? 'call' : 'put';

    // Adjust parameters based on strategy
    let adjustedParams = { ...params };
    if (strategyType === 'day_trade') {
      adjustedParams.otmPct = 0.01; // Closer to money for day trades
  adjustedParams.stopLossPct = 0.2; // Tighter stops
      adjustedParams.takeProfitMult = 1.5; // Lower target
    }

    let directionSign = analysis.strength > 0 ? 1 : -1;
    if (strategyInsights?.primary && strategyInsights.primary.bias !== 'neutral') {
      directionSign = strategyInsights.primary.bias === 'bullish' ? 1 : -1;
    }

    side = directionSign >= 0 ? 'call' : 'put';

    const playbookStrength = strategyInsights?.primary?.magnitude ?? Math.min(Math.abs(strategyInsights?.primary?.score ?? 0), 1);
    const combinedStrength = Math.max(Math.min(Math.abs(analysis.strength), 1), playbookStrength);

  const targetDelta = computeTargetDelta(strategyType, directionSign > 0 ? combinedStrength : -combinedStrength, side);
  const optionTimeFrame = strategyType === 'swing_trade' ? 'swing' : 'day';

    // Build initial option suggestion (model-based fallback)
    const suggestion = buildSuggestion({
      symbol,
      side,
      underlyingPrice: quote.price,
      iv: params.iv,
      r: params.r,
  otmPct: adjustedParams.otmPct,
      minBusinessDays: params.minBusinessDays,
  expiryType: params.expiryType,
  expiryOverride: params.expiryOverride,
      stopLossPct: adjustedParams.stopLossPct,
      takeProfitMult: adjustedParams.takeProfitMult,
    });

    // Enrich with live option chain when available
    let liveOption = null;
    try {
      const chain = await etrade.getOptionChain({
        symbol,
        expiry: suggestion.expiry,
        includeGreeks: true,
      });

      const candidate = selectOptimalOption(chain, side, {
        targetDelta,
        maxSpreadPct: strategyType === 'day_trade' ? 0.3 : 0.4,
        minOpenInterest: strategyType === 'day_trade' ? 150 : 75,
      });

      if (candidate) {
        liveOption = candidate;
        const chosenStrike = Number(candidate.strike);
        const mid = midPrice(candidate);
        const entryPrice = mid ?? candidate.ask ?? candidate.last ?? candidate.bid;
        if (Number.isFinite(chosenStrike) && Number.isFinite(entryPrice)) {
          const spread = candidate.bid != null && candidate.ask != null ? candidate.ask - candidate.bid : null;
          const spreadPct = spread != null && mid ? (spread / mid) * 100 : null;
          suggestion.contract = `${symbol} ${suggestion.expiry} ${chosenStrike}${side === 'call' ? 'C' : 'P'}`;
          suggestion.strike = chosenStrike;
          suggestion.est_entry = Number(entryPrice.toFixed(2));
          suggestion.stop = Number((entryPrice * (1 - adjustedParams.stopLossPct)).toFixed(2));
          suggestion.take_profit = Number((entryPrice * (1 + adjustedParams.takeProfitMult)).toFixed(2));
          suggestion.bid = Number.isFinite(candidate.bid) ? Number(candidate.bid.toFixed(2)) : null;
          suggestion.ask = Number.isFinite(candidate.ask) ? Number(candidate.ask.toFixed(2)) : null;
          suggestion.last = Number.isFinite(candidate.last) ? Number(candidate.last.toFixed(2)) : null;
          suggestion.delta = candidate.delta ?? null;
          suggestion.oi = Number.isFinite(candidate.oi) ? candidate.oi : null;
          suggestion.volume = Number.isFinite(candidate.vol) ? candidate.vol : null;
          suggestion.entry_source = 'etrade_live';
          suggestion.liquidity = {
            spread: spread != null ? Number(spread.toFixed(2)) : null,
            spread_pct: spreadPct != null ? Number(spreadPct.toFixed(2)) : null,
            oi: suggestion.oi,
            volume: suggestion.volume,
            score: candidate._metrics?.totalScore ?? null,
          };
          console.log(`🟢 Selected ${side.toUpperCase()} ${chosenStrike} @ ~$${suggestion.est_entry} (Δ ${suggestion.delta ?? 'N/A'}, OI ${suggestion.oi ?? 'N/A'})`);
          console.log(`   Stop ~$${suggestion.stop} | Target ~$${suggestion.take_profit}`);
          console.log(`📄 Option contract: ${suggestion.contract} | Expiry ${suggestion.expiry} | Strike ${suggestion.strike} | Source ${suggestion.entry_source}`);
        }
      }
    } catch (chainErr) {
      console.warn(`⚠️  Option chain unavailable for ${symbol}:`, chainErr.message);
    }

    if (!liveOption) {
      suggestion.entry_source = 'model';
      console.log('ℹ️  Using theoretical pricing (no live chain data)');
      console.log(`🧮 Suggested ${side.toUpperCase()} baseline -> Strike ${suggestion.strike} @ ~$${suggestion.est_entry}`);
      console.log(`   Stop ~$${suggestion.stop} | Target ~$${suggestion.take_profit}`);
      console.log(`📄 Option contract: ${suggestion.contract} | Expiry ${suggestion.expiry} | Strike ${suggestion.strike} | Source ${suggestion.entry_source}`);
    }

    // Calculate position sizing
    const sizing = computeQty({
      accountSize: params.account,
      riskPct: params.riskPct,
      entry: suggestion.est_entry,
      stop: suggestion.stop,
      multiplier: suggestion.multiplier,
      strategy: params.strategy
    });

    const tradePlan = buildScalingPlan({
      qty: sizing.qty,
      entry: suggestion.est_entry,
      takeProfit: suggestion.take_profit,
      stop: suggestion.stop,
    });

    const enrichedSuggestion = {
      ...suggestion,
      qty: sizing.qty,
      risk_per_contract: Number(sizing.perContractRisk.toFixed(2)),
      risk_total: Number(sizing.totalRisk.toFixed(2)),
      analysis,
      strategyType,
      option_source: suggestion.entry_source,
      option_details: liveOption ? {
        strike: suggestion.strike,
        delta: suggestion.delta,
        oi: suggestion.oi,
        volume: suggestion.volume,
        spread_pct: suggestion.liquidity?.spread_pct ?? null,
        score: liveOption._metrics?.totalScore ?? null,
      } : null,
      tradePlan,
    };

    const stopLabel = Number.isFinite(suggestion.stop) ? `$${suggestion.stop.toFixed(2)}` : 'N/A';
    const tpLabel = Number.isFinite(suggestion.take_profit) ? `$${suggestion.take_profit.toFixed(2)}` : 'N/A';
    const perContractRisk = sizing.perContractRisk.toFixed(2);
    const riskBudgetValue = sizing.riskBudget != null
      ? sizing.riskBudget
      : (params.account && sizing.adjustedRiskPct != null ? params.account * sizing.adjustedRiskPct : null);
    const riskBudgetLabel = riskBudgetValue != null ? `~$${riskBudgetValue.toFixed(2)}` : 'N/A';
    console.log(`📦 Position sizing: buy ${tradePlan.qty} contract(s) | Stop ${stopLabel} | Target ${tpLabel} | Risk ~$${enrichedSuggestion.risk_total.toFixed(2)} (per contract ~$${perContractRisk})`);
    if (tradePlan.qty === 0) {
      console.log(`⚠️  Risk budget (${riskBudgetLabel}) is smaller than the per-contract risk ($${perContractRisk}). Increase account size, tighten the stop, or raise RISK_PCT to afford a starter contract.`);
    }
    if (tradePlan.iterations.length) {
      console.log('📈 Profit plan:');
      tradePlan.iterations.forEach((step, idx) => {
        const targetLabel = step.target != null ? `$${step.target.toFixed(2)}` : 'market strength';
        console.log(`   ${idx + 1}) Sell ${step.sellQty} @ ${targetLabel} — ${step.note}`);
      });
    }

    // AI analysis
    console.log(`🤖 Getting AI analysis...`);
    const context = {
      price: quote.price,
      source: quote.source,
      indicators,
       option: {
        contract: enrichedSuggestion.contract,
        entry: enrichedSuggestion.est_entry,
        stop: enrichedSuggestion.stop,
        take_profit: enrichedSuggestion.take_profit,
        delta: enrichedSuggestion.delta,
        oi: enrichedSuggestion.oi,
        volume: enrichedSuggestion.volume,
        spread_pct: enrichedSuggestion.liquidity?.spread_pct ?? null,
        target_delta: targetDelta,
        source: enrichedSuggestion.option_source,
      },
      algorithmic: {
        [strategyType]: analysis,
        strategyInsights,
        recommendedStrategy: recommendOptionStrategy(combinedStrength, directionSign, optionTimeFrame),
        optionTimeFrame
      },
      strategy_playbook: {
        primary: strategyInsights?.primary ?? null,
        ranked: strategyInsights?.ranked?.slice(0, 3) ?? [],
      }
    };

    const system = buildSystemPrompt();
    const user = buildUserPrompt({ suggestion: enrichedSuggestion, context });
  const ai = await aiClient.chatJson({ model: params.aiModel, system, user, timeout_ms: 20000 });

    console.log(`🧠 AI Decision: ${ai.decision || 'N/A'} (confidence: ${(ai.confidence ?? 0) * 100}%)`);
    if (ai.selected_strategy) {
      try {
        console.log(`AI_SELECTED_STRATEGY ${JSON.stringify(ai.selected_strategy)}`);
      } catch (err) {
        if (params.debug) console.warn('Failed to log selected strategy JSON:', err);
      }
    }
    if (Array.isArray(ai.risk_flags) && ai.risk_flags.length) {
      try {
        console.log(`AI_RISK_FLAGS ${JSON.stringify(ai.risk_flags)}`);
      } catch (err) {
        if (params.debug) console.warn('Failed to log risk flags JSON:', err);
      }
    }
    if (ai.adjustments && typeof ai.adjustments === 'object') {
      try {
        console.log(`AI_ADJUSTMENTS ${JSON.stringify(ai.adjustments)}`);
      } catch (err) {
        if (params.debug) console.warn('Failed to log adjustments JSON:', err);
      }
    }

    return {
      symbol,
      quote,
      suggestion: {
        ...enrichedSuggestion,
        strategyInsights,
      },
      ai,
      analysis
    };

  } catch (error) {
    console.error(`❌ Error analyzing ${symbol}:`, error.message);
    return null;
  }
}

async function runScan(args, runId = 1) {
  console.log(`\n==================== AI TRADING AGENT ====================`);
  console.log(`Tick: ${new Date().toISOString()} | Run ${runId}`);
  console.log(`📈 Strategy: ${args.strategy.toUpperCase()} | Expiry: ${args.expiryType.toUpperCase()}`);
  console.log(`💰 Account: $${args.account.toLocaleString()} | Symbols: ${args.symbols.join(', ')}`);
  console.log(`🤖 AI: ${args.aiProvider} | Model: ${args.aiModel}`);

  const results = [];

  for (const symbol of args.symbols) {
    const result = await analyzeSymbol(symbol, args);
    if (result) {
      results.push(result);
    }
    await sleep(1000); // spacing out API calls slightly
  }

  console.log(`\n📊 SUMMARY`);
  console.log(`==========`);

  const approved = results.filter(r => r.ai.decision === 'approve');
  const cautioned = results.filter(r => r.ai.decision === 'caution');
  const rejected = results.filter(r => r.ai.decision === 'reject');

  console.log(`✅ Approved: ${approved.length}`);
  console.log(`⚠️  Caution: ${cautioned.length}`);
  console.log(`❌ Rejected: ${rejected.length}`);

  if (approved.length > 0) {
    console.log(`\n🎉 RECOMMENDED TRADES:`);
    approved.forEach(r => {
      const s = r.suggestion;
      console.log(`\n${r.symbol} ${s.side.toUpperCase()} - ${s.contract}`);
      console.log(`  Entry: $${s.est_entry} | Stop: $${s.stop} | Target: $${s.take_profit}`);
      console.log(`  Qty: ${s.qty} | Risk: $${s.risk_total}`);
      if (s.strategyInsights?.primary) {
        const primary = s.strategyInsights.primary;
        const magnitude = (primary.magnitude ?? Math.abs(primary.score ?? 0));
        console.log(`  Strategy: ${primary.label} (${primary.bias} bias, strength ${(magnitude * 100).toFixed(0)}%)`);
      }
      if (s.tradePlan?.iterations?.length) {
        const stopSummary = Number.isFinite(s.stop) ? `$${s.stop.toFixed(2)}` : 'N/A';
        console.log(`  Plan: stop at ${stopSummary} and scale out over ${s.tradePlan.iterations.length} step(s)`);
        s.tradePlan.iterations.forEach((step, idx) => {
          const tgt = step.target != null ? `$${step.target.toFixed(2)}` : 'market strength';
          console.log(`    ${idx + 1}) Sell ${step.sellQty} @ ${tgt} — ${step.note}`);
        });
      }
      console.log(`  AI Notes: ${r.ai.notes || 'N/A'}`);
    });
  }

  console.log(`\n✨ Analysis complete!`);
}

async function main() {
  const args = parseArgs(process.argv);
  args.aiClient = getClient(args.aiProvider);
  args.aiProvider = args.aiClient.name;
  if (!args.aiModel) args.aiModel = args.aiClient.defaultModel;
  if (args.help) return usage();

  if (!args.symbols || args.symbols.length === 0) {
    console.error('❌ No symbols specified. Use --symbols or set SCAN_SYMBOLS env var.');
    return usage();
  }

  if (!args.account) {
    console.error('❌ Account size required. Use --account or set ACCOUNT_SIZE env var.');
    return usage();
  }

  let runId = 1;
  if (args.watch) {
    console.log(`🚀 AI Trading Agent watching every ${(args.intervalMs / 1000).toFixed(0)} seconds... (Ctrl+C to stop)`);
    while (true) {
      await runScan(args, runId++);
      await sleep(args.intervalMs);
    }
  } else {
    await runScan(args, runId++);
  }
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});