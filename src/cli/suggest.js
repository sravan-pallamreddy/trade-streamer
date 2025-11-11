#!/usr/bin/env node
require('dotenv').config();

const { buildSuggestion } = require('../strategy/options');
const { computeQty } = require('../risk');
const { fetchOptionChain } = require('../providers/options-chain');
const { selectOptimalOption, pickNearestStrike, midPrice } = require('../strategy/selector');

function parseArgs(argv) {
  const out = {
    symbol: undefined,
    direction: 'long',
    side: undefined,
    price: undefined,
    account: undefined,
    iv: process.env.DEFAULT_IV ? Number(process.env.DEFAULT_IV) : 0.2,
    r: process.env.RISK_FREE ? Number(process.env.RISK_FREE) : 0.01,
    otmPct: process.env.OTM_PCT != null ? Number(process.env.OTM_PCT) : null,
    minBusinessDays: 2,
    expiry: undefined,
    stopLossPct: 0.5,
    takeProfitMult: 2.0,
    riskPct: 0.01,
    both: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--symbol' && args[i + 1]) { out.symbol = args[++i].toUpperCase(); continue; }
    if (a === '--both') { out.both = true; continue; }
    if (a === '--direction' && args[i + 1]) { out.direction = args[++i]; continue; }
    if (a === '--side' && args[i + 1]) { out.side = args[++i]; continue; }
    if (a === '--price' && args[i + 1]) { out.price = Number(args[++i]); continue; }
    if (a === '--account' && args[i + 1]) { out.account = Number(args[++i]); continue; }
    if (a === '--iv' && args[i + 1]) { out.iv = Number(args[++i]); continue; }
    if (a === '--r' && args[i + 1]) { out.r = Number(args[++i]); continue; }
    if (a === '--otm-pct' && args[i + 1]) { out.otmPct = Number(args[++i]); continue; }
    if (a === '--min-days' && args[i + 1]) { out.minBusinessDays = Number(args[++i]); continue; }
    if (a === '--expiry' && args[i + 1]) { out.expiry = args[++i]; continue; }
    if (a === '--sl-pct' && args[i + 1]) { out.stopLossPct = Number(args[++i]); continue; }
    if (a === '--tp-mult' && args[i + 1]) { out.takeProfitMult = Number(args[++i]); continue; }
    if (a === '--risk-pct' && args[i + 1]) { out.riskPct = Number(args[++i]); continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function usage() {
  console.log(`Usage: node src/cli/suggest.js --symbol SPY --side call --price 450 --account 25000 [options]\n\n` +
  `Options:\n` +
  `  --both                       Output for both SPY and QQQ (ignores --symbol)\n` +
  `  --side call|put             Option type to purchase (required)\n` +
  `  --price <num>               Underlying price (required)\n` +
  `  --account <num>             Account size in USD (required)\n` +
  `  --risk-pct <num>            Risk per trade fraction (default 0.01)\n` +
    `  --otm-pct <num>             Target moneyness (omit to auto-select per symbol)\n` +
  `  --min-days <int>            Min business days to expiry (default 2)\n` +
  `  --iv <num>                  Implied volatility (default 0.2)\n` +
  `  --r <num>                   Risk-free rate (default 0.01)\n` +
  `  --sl-pct <num>              Stop loss fraction of premium (default 0.5)\n` +
  `  --tp-mult <num>             Take profit multiple of premium (default 2.0)\n`);
}

async function suggestOne({ symbol, side, price, account, riskPct, otmPct, minBusinessDays, iv, r, stopLossPct, takeProfitMult }) {
  const suggestion = buildSuggestion({
    symbol,
    side,
    underlyingPrice: price,
    iv,
    r,
    otmPct,
    minBusinessDays,
    expiryOverride: (arguments[0] && arguments[0].expiry) || undefined,
    stopLossPct,
    takeProfitMult,
  });
  let chainSource = null;
  let liveOption = null;

  try {
    const chainResult = await fetchOptionChain({ symbol, expiry: suggestion.expiry, includeGreeks: true });
    chainSource = chainResult.source || null;
    const chain = Array.isArray(chainResult.options) ? chainResult.options : [];

    if (!chain.length) {
      console.warn(`⚠️  No option chain data for ${symbol} ${suggestion.expiry}; using theoretical pricing`);
    }

    const targetDelta = side.toLowerCase() === 'put' ? -0.35 : 0.35;
    let candidate = selectOptimalOption(chain, side, {
      targetDelta,
      maxSpreadPct: 0.4,
      minOpenInterest: 75,
    });
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
        suggestion.stop = Number((entry * (1 - stopLossPct)).toFixed(2));
        suggestion.take_profit = Number((entry * (1 + takeProfitMult)).toFixed(2));
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
    console.warn(`⚠️  Option chain fetch failed for ${symbol}:`, err.message);
  }

  if (!liveOption) {
    suggestion.entry_source = 'model';
  }

  const sizing = computeQty({ accountSize: account, riskPct, entry: suggestion.est_entry, stop: suggestion.stop, multiplier: suggestion.multiplier });
  return {
    ...suggestion,
    chain_source: chainSource,
    qty: sizing.qty,
    risk_per_contract: Number(sizing.perContractRisk.toFixed(2)),
    risk_total: Number(sizing.totalRisk.toFixed(2)),
    tp_total: Number((sizing.qty * (suggestion.take_profit - suggestion.est_entry) * suggestion.multiplier).toFixed(2)),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  if (!args.both && (!args.symbol || !args.side || !args.price || !args.account)) {
    console.error('Missing required args.');
    return usage();
  }

  const targets = args.both ? [
    { symbol: 'SPY', side: args.side, price: args.price, account: args.account },
    { symbol: 'QQQ', side: args.side, price: args.price, account: args.account },
  ] : [ { symbol: args.symbol, side: args.side, price: args.price, account: args.account } ];

  const results = await Promise.all(targets.map(t => suggestOne({
    symbol: t.symbol,
    side: t.side,
    price: t.price,
    account: t.account,
    riskPct: args.riskPct,
    otmPct: args.otmPct,
    minBusinessDays: args.minBusinessDays,
    iv: args.iv,
    r: args.r,
    expiry: args.expiry,
    stopLossPct: args.stopLossPct,
    takeProfitMult: args.takeProfitMult,
  })));

  // Print both human-readable and JSON
  for (const r of results) {
    console.log(`${r.symbol} ${r.side.toUpperCase()} | ${r.contract}`);
    console.log(`  Entry ~ $${r.est_entry} | Stop $${r.stop} | TP $${r.take_profit}`);
    console.log(`  Qty ${r.qty} | Risk/ct $${r.risk_per_contract} | Risk total $${r.risk_total} | TP total $${r.tp_total}`);
    const otmDisplay = Number.isFinite(r?.assumptions?.otm_pct_used)
      ? `${(r.assumptions.otm_pct_used * 100).toFixed(1)}%`
      : (args.otmPct != null ? `${(args.otmPct * 100).toFixed(1)}%` : 'auto');
  const sourceLabel = r.entry_source ? `source ${r.entry_source}` : 'source model';
  const chainLabel = r.chain_source ? ` | chain ${r.chain_source}` : '';
  console.log(`  Assumptions: IV ${args.iv}, OTM ${otmDisplay}, minDays ${args.minBusinessDays} (${sourceLabel}${chainLabel})`);
    console.log('');
  }

  console.log(JSON.stringify({ suggestions: results }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
