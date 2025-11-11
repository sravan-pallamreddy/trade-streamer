#!/usr/bin/env node
require('dotenv').config();

const { fetchOptionChain } = require('../providers/options-chain');
const { getQuotes } = require('../providers/quotes');

function parseArgs(argv) {
  const out = {
    symbol: undefined,
    expiry: undefined,
    side: 'both',
    limit: 20,
    prefer: process.env.CHAIN_PREFER || 'etrade',
    includeGreeks: true,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if ((token === '--symbol' || token === '-s') && args[i + 1]) { out.symbol = args[++i].toUpperCase(); continue; }
    if ((token === '--expiry' || token === '-e') && args[i + 1]) { out.expiry = args[++i]; continue; }
    if (token === '--side' && args[i + 1]) { out.side = args[++i].toLowerCase(); continue; }
    if (token === '--limit' && args[i + 1]) { out.limit = Number(args[++i]); continue; }
    if (token === '--prefer' && args[i + 1]) { out.prefer = args[++i].toLowerCase(); continue; }
    if (token === '--no-greeks') { out.includeGreeks = false; continue; }
    if (token === '--help' || token === '-h') { out.help = true; continue; }
  }

  return out;
}

function usage() {
  console.log('Usage: node src/cli/show-chain.js --symbol TSLA --expiry 2025-11-14 [--side call|put|both] [--limit 15]');
  console.log('Environment: set E*TRADE or FMP keys as needed. Optional CHAIN_PREFER=etrade|fmp');
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function filterBySide(options, side) {
  if (!options || !options.length) return [];
  const normalizedSide = side?.toLowerCase() || 'both';
  if (normalizedSide === 'both' || normalizedSide === 'all') return options;
  const target = normalizedSide === 'put' ? 'PUT' : 'CALL';
  return options.filter((opt) => (opt.type || '').toUpperCase() === target);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  if (!args.symbol) {
    console.error('❌ --symbol is required');
    return usage();
  }
  if (!args.expiry) {
    console.error('❌ --expiry is required (e.g., 2025-11-14)');
    return usage();
  }

  const prefer = args.prefer === 'fmp' ? 'fmp' : 'etrade';

  console.log(`Fetching option chain for ${args.symbol} ${args.expiry} (prefer ${prefer})...`);
  const [quoteMap, chain] = await Promise.all([
    getQuotes([args.symbol]).catch((err) => {
      console.warn('⚠️  Quote fetch failed:', err.message);
      return {};
    }),
    fetchOptionChain({
      symbol: args.symbol,
      expiry: args.expiry,
      includeGreeks: args.includeGreeks,
      prefer,
      minContracts: 0,
    }),
  ]);

  const quote = quoteMap?.[args.symbol];
  if (quote?.price != null) {
    console.log(`Underlying price: $${quote.price.toFixed(2)} (${quote.source || 'unknown'})`);
  }

  console.log('Chain metadata:', {
    source: chain.source,
    attempts: chain.attempts,
    errors: chain.errors,
    total: chain.options.length,
  });

  if (!chain.options.length) {
    console.log('No contracts returned.');
    return;
  }

  const filtered = filterBySide(chain.options, args.side);
  const limited = args.limit && args.limit > 0 ? filtered.slice(0, args.limit) : filtered;

  const rows = limited.map((opt) => {
    const spread = (Number.isFinite(opt.ask) && Number.isFinite(opt.bid)) ? opt.ask - opt.bid : null;
    const mid = (Number.isFinite(opt.ask) && Number.isFinite(opt.bid)) ? (opt.ask + opt.bid) / 2 : null;
    return {
      type: opt.type || 'N/A',
      strike: formatNumber(opt.strike, 2),
      bid: formatNumber(opt.bid, 2),
      ask: formatNumber(opt.ask, 2),
      mid: formatNumber(mid, 2),
      last: formatNumber(opt.last, 2),
      delta: formatNumber(opt.delta, 3),
      oi: opt.oi ?? null,
      volume: opt.vol ?? null,
      spread: formatNumber(spread, 2),
      optionSymbol: opt.optionSymbol || null,
    };
  });

  console.table(rows);

  if (filtered.length > limited.length) {
    console.log(`Displayed ${limited.length} of ${filtered.length} ${args.side} contracts.`);
  } else {
    console.log(`Displayed all ${filtered.length} ${args.side} contracts.`);
  }
}

main().catch((err) => {
  console.error('💥 Failed to fetch option chain:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
