#!/usr/bin/env node
// Simple web UI for trading dashboard
require('dotenv').config();
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

console.log('Starting Trading Dashboard server...');

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

let etradeModule;
const app = express();
const PORT = process.env.UI_PORT || 3001;
console.log(`Using port: ${PORT}`);

// Store latest AI results
let latestResults = null;
let lastScanMeta = null;
let lastScanError = null;
let isScanning = false;
let scanTimer = null;
let nextScanDelayOverride = null;

function parseSymbolList(input) {
  if (!input) return [];
  const source = Array.isArray(input) ? input : String(input).split(/[,\s]+/);
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    if (!raw) continue;
    const symbol = String(raw).trim().toUpperCase();
    if (!symbol) continue;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

const ALLOWED_STRATEGIES = new Set(['day_trade', 'swing_trade']);

function normalizeStrategy(input) {
  if (typeof input !== 'string') return null;
  const token = input.trim().toLowerCase();
  if (ALLOWED_STRATEGIES.has(token)) return token;
  if (token === 'day' || token === 'daytrade') return 'day_trade';
  if (token === 'swing' || token === 'swingtrade') return 'swing_trade';
  return null;
}

const FALLBACK_STRATEGY = 'day_trade';
const DEFAULT_STRATEGY =
  normalizeStrategy(process.env.UI_DEFAULT_STRATEGY)
  || normalizeStrategy(process.env.TRADING_STRATEGY)
  || FALLBACK_STRATEGY;

const STRATEGY_DEFAULT_EXPIRY = {
  day_trade: '0dte',
  swing_trade: 'weekly',
};

function appendArgToCommand(command, flag, value) {
  if (!value) return command;
  const trimmedValue = String(value).trim();
  if (!trimmedValue) return command;
  const isNpmRun = /npm\s+run\s+/i.test(command);
  if (isNpmRun) {
    const hasDoubleDash = /\s--\s/.test(command);
    const separator = hasDoubleDash ? ' ' : ' -- ';
    return `${command}${separator}${flag} ${trimmedValue}`;
  }
  return `${command} ${flag} ${trimmedValue}`;
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value == null) return Boolean(defaultValue);
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(defaultValue);
}

function parseNumberEnv(value, defaultValue) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : defaultValue;
}

function ensureArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function formatDateMMDDYYYY(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function formatDateBareMMDDYYYY(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${month}${day}${year}`;
}

function formatDateYYYYMMDD(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
}

function formatDateMMDDYY(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}

function canonicalOptionKey(instrument = {}, product = {}) {
  const direct =
    instrument.osiKey
    || instrument.optionSymbol
    || product.osiKey
    || product.symbol
    || instrument.symbol;
  if (direct) {
    return String(direct).toUpperCase();
  }
  const parts = [
    product.symbol || instrument.symbol || 'UNKNOWN',
    product.callPut || instrument.callPut || '',
    product.strikePrice ?? instrument.strikePrice ?? '',
    product.expiryYear ?? instrument.expiryYear ?? '',
    product.expiryMonth ?? instrument.expiryMonth ?? '',
    product.expiryDay ?? instrument.expiryDay ?? '',
  ];
  return parts.join('|').toUpperCase();
}

function isOptionInstrument(instrument = {}, product = {}) {
  const securityType = (product.securityType || instrument.securityType || '').toUpperCase();
  if (securityType) {
    return securityType === 'OPTN';
  }
  if (instrument.optionSymbol || instrument.osiKey) return true;
  if (product.callPut || product.osiKey || product.strikePrice != null) return true;
  return false;
}

function buildExpiryLabel(product = {}, instrument = {}) {
  const year = product.expiryYear ?? instrument.expiryYear;
  if (!Number.isFinite(year)) return null;
  const month = product.expiryMonth ?? instrument.expiryMonth;
  const day = product.expiryDay ?? instrument.expiryDay;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toIsoTimestamp(value) {
  if (!value && value !== 0) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    const digits = String(Math.trunc(asNumber)).length;
    if (digits >= 13) return new Date(asNumber).toISOString();
    if (digits === 10) return new Date(asNumber * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeOrderRecords(rawOrders) {
  const root = rawOrders?.OrdersResponse || rawOrders?.ordersResponse || rawOrders;
  if (!root) return [];
  const orderEntries = ensureArray(root.order || root.orders || root.OrderData || root.Orders);
  const records = [];

  for (const entry of orderEntries) {
    const orderId = entry?.orderId || entry?.OrderId || entry?.id || null;
    const details = ensureArray(entry?.orderDetail || entry?.OrderDetail || entry?.details || entry);
    for (const detail of details) {
      const status = String(detail?.status || detail?.orderStatus || entry?.orderStatus || '').toUpperCase();
      if (!status || !(status.includes('EXECUTED') || status.includes('FILLED'))) continue;
      const executedTime =
        detail?.executedTime
        || detail?.orderTime
        || detail?.placedTime
        || entry?.executedTime
        || entry?.placedTime
        || null;
      const instruments = ensureArray(detail?.instrument || detail?.Instrument);
      for (const instrument of instruments) {
        const product = instrument?.product || instrument?.Product || {};
        if (!isOptionInstrument(instrument, product)) continue;
        const action = String(instrument?.orderAction || detail?.orderAction || entry?.orderAction || '').toUpperCase();
        if (!action) continue;
        const quantity = Number(
          instrument?.filledQuantity
          ?? instrument?.quantity
          ?? detail?.filledQuantity
          ?? detail?.quantity
          ?? 0,
        );
        if (!Number.isFinite(quantity) || quantity === 0) continue;
        const price = Number(
          instrument?.averageExecutionPrice
          ?? detail?.averageExecutionPrice
          ?? instrument?.price
          ?? detail?.price
          ?? 0,
        );
        if (!Number.isFinite(price) || price <= 0) continue;
        const multiplierRaw = Number(product?.multiplier ?? instrument?.multiplier ?? 100);
        const multiplier = Number.isFinite(multiplierRaw) && multiplierRaw > 0 ? multiplierRaw : 100;
        const key = canonicalOptionKey(instrument, product);
        const description =
          instrument?.symbolDescription
          || product?.symbolDescription
          || instrument?.optionSymbol
          || product?.osiKey
          || key
          || instrument?.symbol
          || 'Option';
        records.push({
          orderId,
          timestamp: toIsoTimestamp(executedTime),
          action,
          qty: Math.abs(quantity),
          price,
          multiplier,
          optionSymbol: instrument?.optionSymbol || instrument?.osiKey || product?.osiKey || key,
          symbol: product?.symbol || instrument?.symbol || null,
          description,
          callPut: product?.callPut || instrument?.callPut || null,
          strike: product?.strikePrice ?? instrument?.strikePrice ?? null,
          expiry: buildExpiryLabel(product, instrument),
          key,
        });
      }
    }
  }

  return records;
}

function summarizeDayOptionOrders(rawOrders) {
  const records = normalizeOrderRecords(rawOrders);
  if (!records.length) return null;
  records.sort((a, b) => {
    if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    if (a.timestamp) return -1;
    if (b.timestamp) return 1;
    return 0;
  });

  const inventory = new Map();
  const trades = [];
  const totals = { realized: 0, grossBuys: 0, grossSells: 0 };

  for (const record of records) {
    const isSell = record.action.includes('SELL');
    const isBuy = record.action.includes('BUY');
    if (!isSell && !isBuy) continue;

    const cash = Number((record.price * record.qty * record.multiplier * (isSell ? 1 : -1)).toFixed(2));
    if (cash >= 0) totals.grossSells += cash;
    else totals.grossBuys += Math.abs(cash);

    const entry = {
      id: record.orderId || `order-${trades.length + 1}`,
      symbol: record.symbol,
      optionSymbol: record.optionSymbol,
      description: record.description,
      side: record.action,
      qty: record.qty,
      price: record.price,
      multiplier: record.multiplier,
      timestamp: record.timestamp,
      netCash: cash,
      realized: null,
      unmatchedQty: 0,
      callPut: record.callPut,
      strike: record.strike,
      expiry: record.expiry,
    };

    if (isBuy) {
      const queue = inventory.get(record.key) || [];
      queue.push({ qty: record.qty, price: record.price });
      inventory.set(record.key, queue);
    } else {
      let remaining = record.qty;
      let realized = 0;
      const queue = inventory.get(record.key) || [];
      while (remaining > 0 && queue.length) {
        const lot = queue[0];
        const matchedQty = Math.min(remaining, lot.qty);
        realized += (record.price - lot.price) * matchedQty * record.multiplier;
        lot.qty -= matchedQty;
        if (lot.qty <= 1e-6) queue.shift();
        remaining -= matchedQty;
      }
      if (realized !== 0) {
        realized = Number(realized.toFixed(2));
        entry.realized = realized;
        totals.realized += realized;
      }
      if (remaining > 0) {
        entry.unmatchedQty = remaining;
      }
    }

    trades.push(entry);
  }

  totals.realized = Number(totals.realized.toFixed(2));
  totals.grossBuys = Number(totals.grossBuys.toFixed(2));
  totals.grossSells = Number(totals.grossSells.toFixed(2));

  return {
    updatedAt: new Date().toISOString(),
    totals,
    trades,
  };
}

async function fetchDayOrders(accountIdKey) {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const nextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const attempts = [
    { label: 'MMDDYYYY (bare digits)', format: formatDateBareMMDDYYYY }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const params = {
     
      fromDate: attempt.format(startOfDay),
      toDate: attempt.format(nextDay),
      count: 100,
      securityType: 'OPTN',
      marketSession: 'REGULAR',
    };
    console.log('[DayOrders] Fetching option executions', {
      accountIdKey,
      format: attempt.label,
      params,
    });
    try {
      const rawOrders = await getOrders(accountIdKey, params);
      const summary = summarizeDayOptionOrders(rawOrders);
      if (summary?.totals) {
        console.log('[DayOrders] Summary', {
          formatTried: attempt.label,
          trades: summary.trades?.length || 0,
          totals: summary.totals,
        });
      } else {
        console.log('[DayOrders] No executed option orders returned for today (format:', attempt.label, ')');
      }
      return summary;
    } catch (error) {
      lastError = error;
      console.warn('[DayOrders] Fetch failed (format', attempt.label, '):', error.message);
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function buildAgentCommand(symbolsList, strategy, expiryType) {
  let command = AGENT_COMMAND;

  const strategyPlaceholder = command.includes('{{strategy}}');
  const expiryPlaceholderCamel = command.includes('{{expiryType}}');
  const expiryPlaceholderSnake = command.includes('{{expiry_type}}');

  if (strategy && strategyPlaceholder) {
    command = command.replace(/{{strategy}}/g, strategy);
  }

  if (expiryType && expiryPlaceholderCamel) {
    command = command.replace(/{{expiryType}}/g, expiryType);
  }

  if (expiryType && expiryPlaceholderSnake) {
    command = command.replace(/{{expiry_type}}/g, expiryType);
  }

  if (Array.isArray(symbolsList) && symbolsList.length) {
    const symbolArg = symbolsList.join(',');
    if (command.includes('{{symbols}}')) {
      command = command.replace(/{{symbols}}/g, symbolArg);
    } else {
      command = appendArgToCommand(command, '--symbols', symbolArg);
    }
  }

  if (strategy && !strategyPlaceholder) {
    const hasStrategyArg = /--strategy\b/.test(command);
    if (!hasStrategyArg) {
      command = appendArgToCommand(command, '--strategy', strategy);
    }
  }

  if (expiryType && !expiryPlaceholderCamel && !expiryPlaceholderSnake) {
    const hasExpiryArg = /--expiry-type\b/.test(command);
    if (!hasExpiryArg) {
      command = appendArgToCommand(command, '--expiry-type', expiryType);
    }
  }

  return command;
}
const DEFAULT_SYMBOLS = process.env.SCAN_SYMBOLS || 'SPY,QQQ,AAPL,TSLA,GOOGL,NVDA';
const DEFAULT_SYMBOL_LIST = parseSymbolList(DEFAULT_SYMBOLS);

let scanConfig = {
  symbols: DEFAULT_SYMBOL_LIST.length ? Array.from(DEFAULT_SYMBOL_LIST) : ['SPY', 'QQQ'],
  strategy: DEFAULT_STRATEGY,
  updatedAt: new Date().toISOString()
};

const AGENT_COMMAND = process.env.UI_AGENT_COMMAND || 'npm run day-trade';
const AGENT_INTERVAL_MS = Number(process.env.UI_AGENT_INTERVAL_MS || 120000);
const AGENT_TIMEOUT_MS = Number(process.env.UI_AGENT_TIMEOUT_MS || 90000);
const LOG_AGENT_OUTPUT = process.env.UI_AGENT_LOG_OUTPUT
  ? String(process.env.UI_AGENT_LOG_OUTPUT).toLowerCase() !== 'false'
  : true;

async function resolveOptionPrice({ accountIdKey, optionSymbol, symbol, fallbackPrice }) {
  const numericFallback = Number(fallbackPrice);
  if (Number.isFinite(numericFallback) && numericFallback > 0) {
    return numericFallback;
  }

  const normalizeKey = (value) => (value ? String(value).toUpperCase().trim() : '');
  const targetOption = normalizeKey(optionSymbol);
  const targetUnderlying = normalizeKey(symbol);

  try {
    const portfolio = await getPortfolio(accountIdKey, { view: 'OPTIONS' });
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const match = positions.find((position) => {
      const candidateOption = normalizeKey(position?.osiKey || position?.optionSymbol || position?.symbol);
      if (targetOption && candidateOption) {
        return candidateOption === targetOption;
      }
      const candidateUnderlying = normalizeKey(position?.underlyingSymbol || position?.symbol);
      return targetUnderlying && candidateUnderlying === targetUnderlying;
    });

    if (match) {
      const current = Number(match.currentPrice);
      if (Number.isFinite(current) && current > 0) {
        return current;
      }
      const marketValue = Number(match.marketValue);
      const quantity = Number(match.quantity);
      if (Number.isFinite(marketValue) && Number.isFinite(quantity) && quantity !== 0) {
        const perContractValue = marketValue / Math.abs(quantity);
        const inferredPrice = perContractValue / 100; // convert notional value to option premium
        if (Number.isFinite(inferredPrice) && inferredPrice > 0) {
          return Number(inferredPrice.toFixed(2));
        }
      }
    }
  } catch (lookupError) {
    console.warn('Unable to refresh option price for emergency sell:', lookupError.message);
  }

  return null;
}

function parseProviderList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function resolveUiProviders() {
  const fromConfig = parseProviderList(process.env.UI_AI_PROVIDERS);
  if (fromConfig.length) return Array.from(new Set(fromConfig));
  const fromEnv = parseProviderList(process.env.AI_PROVIDER);
  if (fromEnv.length) return Array.from(new Set(fromEnv));
  const autoDetect = [];
  if (process.env.OPENAI_API_KEY) autoDetect.push('openai');
  if (process.env.DEEP_SEEK_API_KEY) autoDetect.push('deepseek');
  if (autoDetect.length) return Array.from(new Set(autoDetect));
  return ['openai'];
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Disable browser caching for API responses to force fresh brokerage data
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
  next();
});

// Load E*TRADE module
try {
  etradeModule = require('../providers/etrade');
  console.log('E*TRADE module loaded successfully');
} catch (error) {
  console.error('Failed to load E*TRADE module:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
}

const { getAccounts, getPortfolio, getAccountBalance, placeOptionMarketOrder } = etradeModule;
const { getOrders } = etradeModule;

// API endpoints
app.get('/api/recommendations', (req, res) => {
  res.json({
    results: latestResults,
    isScanning,
    scanMeta: lastScanMeta,
    lastError: lastScanError,
    config: scanConfig,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/scan', async (req, res) => {
  const manualResult = await triggerScan('manual');
  if (!manualResult.success) {
    return res.status(manualResult.statusCode || 500).json({ success: false, error: manualResult.error });
  }

  res.json({ success: true, results: manualResult.results });
});

app.get('/api/scan/config', (req, res) => {
  res.json({ success: true, config: scanConfig });
});

app.post('/api/scan/config', (req, res) => {
  try {
    const symbolsInput = req.body?.symbols;
    const normalized = parseSymbolList(symbolsInput);

    if (!normalized.length) {
      return res.status(400).json({ success: false, error: 'At least one symbol is required.' });
    }

    if (normalized.length > 24) {
      return res.status(400).json({ success: false, error: 'Please limit the watchlist to 24 symbols.' });
    }

    const strategyInput = req.body?.strategy;
    let strategy = scanConfig.strategy || DEFAULT_STRATEGY;
    if (strategyInput != null) {
      const normalizedStrategy = normalizeStrategy(strategyInput);
      if (!normalizedStrategy) {
        return res.status(400).json({ success: false, error: 'Invalid strategy. Use day_trade or swing_trade.' });
      }
      strategy = normalizedStrategy;
    }

    scanConfig = {
      symbols: normalized,
      strategy,
      updatedAt: new Date().toISOString()
    };

    console.log(`Updated scan config: symbols=${scanConfig.symbols.join(', ')} | strategy=${strategy}`);
    nextScanDelayOverride = null;
    if (isScanning) {
      nextScanDelayOverride = 1500;
    } else {
      scheduleNextScan(1500);
    }

    res.json({ success: true, config: scanConfig });
  } catch (error) {
    console.error('Failed to update scan config:', error);
    res.status(500).json({ success: false, error: 'Failed to update scan configuration.' });
  }
});

// Portfolio endpoints
app.get('/api/portfolio/config', (req, res) => {
  const autoExitConfig = {
    enabled: parseBooleanEnv(process.env.UI_AUTO_EXIT_ENABLED, false),
    takeProfitPct: parseNumberEnv(process.env.UI_AUTO_EXIT_TAKE_PROFIT_PCT, 40),
    stopLossPct: parseNumberEnv(process.env.UI_AUTO_EXIT_STOP_LOSS_PCT, -35),
    scalePct: parseNumberEnv(process.env.UI_AUTO_EXIT_SCALE_PCT, 0.5),
    minContracts: Math.max(1, Math.trunc(parseNumberEnv(process.env.UI_AUTO_EXIT_MIN_CONTRACTS, 1))),
    cooldownMs: Math.max(0, parseNumberEnv(process.env.UI_AUTO_EXIT_COOLDOWN_MS, 300000)),
  };

  res.json({
    success: true,
    defaultAccountIdKey: process.env.ETRADE_DEFAULT_ACCOUNT_KEY || null,
    autoExit: autoExitConfig,
  });
});

app.get('/api/portfolio/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Portfolio accounts error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/:accountIdKey', async (req, res) => {
  try {
    const { accountIdKey } = req.params;
    const view = req.query.view || 'QUICK';

    // Get all accounts to find the numeric accountId from accountIdKey
    const accounts = await getAccounts();
    const account = accounts.find(acc => acc.accountIdKey === accountIdKey);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Use the accountIdKey for portfolio calls (E*TRADE API expects this format)
    const portfolio = await getPortfolio(accountIdKey, { view });
    let dayOrders = null;
    try {
      dayOrders = await fetchDayOrders(accountIdKey);
    } catch (orderErr) {
      console.warn('Day orders fetch failed:', orderErr.message);
    }
    res.json({ success: true, portfolio, dayOrders });
  } catch (error) {
    console.error('Portfolio error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/:accountIdKey/balance', async (req, res) => {
  try {
    const { accountIdKey } = req.params;

    // Get all accounts to find the numeric accountId from accountIdKey
    const accounts = await getAccounts();
    const account = accounts.find(acc => acc.accountIdKey === accountIdKey);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Use the accountIdKey for balance calls (this was working before)
    const balance = await getAccountBalance(accountIdKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/portfolio/:accountIdKey/options/emergency-sell', async (req, res) => {
  try {
    const { accountIdKey } = req.params;
    if (!accountIdKey) {
      return res.status(400).json({ success: false, error: 'Account ID is required.' });
    }

    const {
      optionSymbol,
      symbol,
      quantity,
      positionId,
      orderAction,
      callPut,
      strike,
      expiry,
      price,
    } = req.body || {};

    const chosenSymbol = optionSymbol || symbol;

    if (!chosenSymbol) {
      return res.status(400).json({ success: false, error: 'Option symbol is required.' });
    }

    const numericQty = Number(quantity);
    if (!Number.isFinite(numericQty) || numericQty === 0) {
      return res.status(400).json({ success: false, error: 'Position quantity must be provided.' });
    }

    const resolvedPrice = await resolveOptionPrice({
      accountIdKey,
      optionSymbol: chosenSymbol,
      symbol,
      fallbackPrice: price,
    });
    if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Unable to determine current option price for emergency sell. Refresh positions and try again.' });
    }

    const orderResult = await placeOptionMarketOrder({
      accountIdKey,
      optionSymbol: chosenSymbol,
      underlyingSymbol: symbol,
      quantity: numericQty,
      orderAction,
      callPut,
      strike,
      expiry,
      price: resolvedPrice,
    });

    res.json({
      success: true,
      order: {
        ...orderResult,
        positionId: positionId || null,
        optionSymbol: chosenSymbol,
        quantity: numericQty,
        accountIdKey,
      },
    });
  } catch (error) {
    console.error('Emergency sell error:', error);
    const brokerMessage = error?.payload?.Error?.message
      || error?.payload?.message
      || error?.body
      || error?.message;
    res.status(500).json({
      success: false,
      error: brokerMessage || 'Failed to submit emergency sell order.',
      brokerResponse: error?.payload || null,
    });
  }
});

app.post('/api/portfolio/:accountIdKey/options/market-buy', async (req, res) => {
  try {
    const { accountIdKey } = req.params;
    console.log('[MarketBuy] Request received', {
      accountIdKey,
      body: req.body,
    });
    if (!accountIdKey) {
      return res.status(400).json({ success: false, error: 'Account ID is required.' });
    }

    const {
      optionSymbol,
      symbol,
      price,
      callPut,
      strike,
      expiry,
      allocationPct,
      quantity,
    } = req.body || {};

    const tradeSymbol = optionSymbol || symbol;
    if (!tradeSymbol) {
      return res.status(400).json({ success: false, error: 'Option symbol is required.' });
    }

    const contractPrice = Number(price);
    if (!Number.isFinite(contractPrice) || contractPrice <= 0) {
      return res.status(400).json({ success: false, error: 'A valid contract price is required to size the order.' });
    }

    const normalizedCallPut = typeof callPut === 'string' ? callPut.trim().toUpperCase() : '';
    const numericStrike = Number(strike);
    if (!normalizedCallPut || (normalizedCallPut !== 'CALL' && normalizedCallPut !== 'PUT')) {
      return res.status(400).json({ success: false, error: 'Contract side (call/put) is required for market buy.' });
    }
    if (!Number.isFinite(numericStrike) || numericStrike <= 0) {
      return res.status(400).json({ success: false, error: 'Strike price missing for this contract.' });
    }
    if (!expiry) {
      return res.status(400).json({ success: false, error: 'Expiry date missing for this contract.' });
    }

    const accountBalance = await getAccountBalance(accountIdKey);
    const withdrawCash = Number(
      accountBalance?.totalAvailableForWithdrawal
      ?? accountBalance?.cashAvailableForWithdrawal
      ?? accountBalance?.cashAvailableToWithdraw
      ?? accountBalance?.fundsForWithdrawal
      ?? accountBalance?.cashAvailable
      ?? accountBalance?.cashBalance
      ?? accountBalance?.cash
      ?? 0
    );
    if (!Number.isFinite(withdrawCash) || withdrawCash <= 0) {
      return res.status(400).json({ success: false, error: 'Withdrawable cash is not available for this account.' });
    }

    const pct = Number.isFinite(Number(allocationPct)) ? Math.min(Math.max(Number(allocationPct), 0.05), 1) : 1;
    const budget = withdrawCash * pct;
    const costPerContract = contractPrice * 100;
    const suggestedQty = Number(quantity);
    const normalizedSuggestedQty = Number.isFinite(suggestedQty) && suggestedQty > 0 ? Math.trunc(suggestedQty) : null;
    let finalQty = null;
    let sizingMode = 'budget';
    if (normalizedSuggestedQty) {
      const needed = normalizedSuggestedQty * costPerContract;
      if (needed <= budget) {
        finalQty = normalizedSuggestedQty;
        sizingMode = 'suggested';
      } else {
        sizingMode = 'fallback';
      }
    }
    if (!finalQty) {
      finalQty = Math.floor(budget / costPerContract);
    }

    if (!Number.isFinite(finalQty) || finalQty < 1) {
      return res.status(400).json({ success: false, error: 'Withdrawable cash is insufficient for at least one contract at the provided price.' });
    }

    console.log('[MarketBuy] Sizing decision', {
      withdrawCash,
      allocationPct: pct,
      budget,
      costPerContract,
      quantity: finalQty,
      suggestedQuantity: normalizedSuggestedQty,
      sizingMode,
      contractPrice,
      symbol: tradeSymbol,
      callPut: normalizedCallPut,
      strike: numericStrike,
      expiry,
    });

    const orderResult = await placeOptionMarketOrder({
      accountIdKey,
      optionSymbol: tradeSymbol,
      underlyingSymbol: symbol,
      quantity: finalQty,
      orderAction: 'BUY_OPEN',
      callPut: normalizedCallPut,
      strike: numericStrike,
      expiry,
      price: contractPrice,
    });

    res.json({
      success: true,
      order: orderResult,
      sizing: {
        withdrawCash,
        allocationPct: pct,
        budget,
        contractPrice,
        costPerContract,
        quantity: finalQty,
        suggestedQuantity: normalizedSuggestedQty,
        sizingMode,
      },
    });
  } catch (error) {
    console.error('[MarketBuy] Error placing order', {
      message: error?.message,
      payload: error?.payload,
      stack: error?.stack,
    });
    const brokerMessage = error?.payload?.Error?.message
      || error?.payload?.message
      || error?.body
      || error?.message;
    res.status(500).json({
      success: false,
      error: brokerMessage || 'Failed to place market buy order.',
      brokerResponse: error?.payload || null,
    });
  }
});



function parseAIOutput(output, { provider, model } = {}) {
  if (!output) {
    return { recommendations: [], meta: { provider, model } };
  }

  const lines = output.split('\n');
  const recMap = new Map();
  let currentSymbol = null;
  let summarySymbol = null;
  let collectingPlanFor = null;
  let inSummary = false;
  let activeProvider = provider || null;
  let activeModel = model || null;

  const ensureRec = (symbol) => {
    if (!symbol) return null;
    const key = symbol.trim().toUpperCase();
    if (!key) return null;
    if (!recMap.has(key)) {
      recMap.set(key, {
        symbol: key,
        signals: [],
        ai: {},
        scalingPlan: [],
      });
    }
    return recMap.get(key);
  };

  const parseCurrency = (value) => {
    if (value == null) return null;
    const numeric = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
  };

  const addPlanStep = (rec, step, sellQty, targetLabel, note) => {
    if (!rec) return;
    if (!Array.isArray(rec.scalingPlan)) {
      rec.scalingPlan = [];
    }
    const numericTarget = parseCurrency(targetLabel);
    const stepData = {
      step,
      sellQty,
      target: Number.isFinite(numericTarget) ? numericTarget : null,
      targetLabel: targetLabel.trim(),
      note: note.trim(),
    };
    const existingIdx = rec.scalingPlan.findIndex((s) => s.step === stepData.step);
    if (existingIdx >= 0) {
      rec.scalingPlan[existingIdx] = stepData;
    } else {
      rec.scalingPlan.push(stepData);
    }
  };

  const sanitizeLine = (value) => value.replace(/[^\x20-\x7E]+/g, '').trim();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const asciiLine = sanitizeLine(line);
    const matchLine = asciiLine || line;

    const headerMatch = matchLine.match(/AI:\s*([^|]+)(?:\|\s*Model:\s*(.+))?/i);
    if (headerMatch) {
      activeProvider = headerMatch[1]?.trim() || activeProvider;
      const maybeModel = headerMatch[2]?.trim();
      if (maybeModel) {
        activeModel = maybeModel;
      }
      continue;
    }

    const analyzingMatch = matchLine.match(/Analyzing\s+([A-Z0-9.\-]+)/i);
    if (analyzingMatch) {
      currentSymbol = analyzingMatch[1].replace(/\.+$/, '').toUpperCase();
      summarySymbol = null;
      collectingPlanFor = null;
      inSummary = false;
      ensureRec(currentSymbol);
      continue;
    }

    if (matchLine.includes('RECOMMENDED TRADES:')) {
      inSummary = true;
      summarySymbol = null;
      collectingPlanFor = null;
      currentSymbol = null;
      continue;
    }

    if (inSummary) {
      const summaryMatch = matchLine.match(/^([A-Z0-9]+)\s+(CALL|PUT)\s+-\s+(.+)/);
      if (summaryMatch) {
        summarySymbol = summaryMatch[1].replace(/\.+$/, '').toUpperCase();
        const rec = ensureRec(summarySymbol);
        if (rec) {
          rec.side = summaryMatch[2].toLowerCase();
          rec.contract = summaryMatch[3].trim();
        }
        continue;
      }

      const optionSymbolLine = matchLine.match(/^Option symbol:\s*([^\s(]+)(?:\s*\(([^)]+)\))?/i);
      if (optionSymbolLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        if (rec) {
          const value = optionSymbolLine[1]?.trim();
          if (value && value.toUpperCase() !== 'N/A') {
            rec.optionSymbol = value;
          }
          if (optionSymbolLine[2]) {
            rec.optionSource = optionSymbolLine[2];
          }
        }
        continue;
      }

      const entryLine = matchLine.match(/^Entry:\s*\$?([0-9.]+|N\/A)\s*\|\s*Stop:\s*\$?([0-9.]+|N\/A)\s*\|\s*Target:\s*\$?([0-9.]+|N\/A)/i);
      if (entryLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        if (rec) {
          rec.entry = entryLine[1] !== 'N/A' ? parseCurrency(entryLine[1]) : null;
          rec.stop = entryLine[2] !== 'N/A' ? parseCurrency(entryLine[2]) : null;
          rec.target = entryLine[3] !== 'N/A' ? parseCurrency(entryLine[3]) : null;
        }
        continue;
      }

      const qtyLine = matchLine.match(/^Qty:\s*(\d+)\s*\|\s*Risk:\s*\$?([0-9.]+)/i);
      if (qtyLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        if (rec) {
          rec.qty = Number(qtyLine[1]);
          rec.risk = parseCurrency(qtyLine[2]);
        }
        continue;
      }

      const planLine = matchLine.match(/^Plan:\s*(.+)/i);
      if (planLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        if (rec) {
          rec.planSummary = planLine[1];
        }
        continue;
      }

      const notesLine = matchLine.match(/^AI Notes:\s*(.+)/i);
      if (notesLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        if (rec) {
          rec.ai.notes = notesLine[1];
        }
        continue;
      }

      const stepLine = matchLine.match(/^(\d+)\)\s+Sell\s+(\d+)\s*@\s*([^\s]+)\s+(.*)$/);
      if (stepLine && summarySymbol) {
        const rec = ensureRec(summarySymbol);
        addPlanStep(rec, Number(stepLine[1]), Number(stepLine[2]), stepLine[3], stepLine[4]);
        continue;
      }

      continue;
    }

    const rec = ensureRec(currentSymbol);
    if (!rec) continue;

    if (matchLine.startsWith('AI_SELECTED_STRATEGY ')) {
      const payload = line.slice('AI_SELECTED_STRATEGY '.length).trim();
      try {
        rec.ai.selectedStrategy = JSON.parse(payload);
      } catch (err) {
        console.warn('Failed to parse AI selected strategy payload:', payload, err.message);
      }
      continue;
    }

    if (matchLine.startsWith('AI_RISK_FLAGS ')) {
      const payload = line.slice('AI_RISK_FLAGS '.length).trim();
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) {
          rec.ai.riskFlags = parsed;
        } else if (parsed) {
          rec.ai.riskFlags = [parsed];
        }
      } catch (err) {
        console.warn('Failed to parse AI risk flags payload:', payload, err.message);
      }
      continue;
    }

    if (matchLine.startsWith('AI_ADJUSTMENTS ')) {
      const payload = line.slice('AI_ADJUSTMENTS '.length).trim();
      try {
        rec.ai.adjustments = JSON.parse(payload);
      } catch (err) {
        console.warn('Failed to parse AI adjustments payload:', payload, err.message);
      }
      continue;
    }

    if (matchLine.includes('Option contract:')) {
      const payload = line.replace(/^.*Option contract:/i, '').trim();
      if (payload) {
        const parts = payload.split('|').map((part) => part.trim()).filter(Boolean);
        if (parts.length) {
          rec.contract = parts[0];
        }
        for (let i = 1; i < parts.length; i += 1) {
          const part = parts[i];
          if (part.toLowerCase().startsWith('expiry')) {
            const value = part.slice('expiry'.length).trim().replace(/^:/, '').trim();
            rec.expiry = value || rec.expiry || null;
            continue;
          }
          if (part.toLowerCase().startsWith('strike')) {
            const value = part.slice('strike'.length).trim().replace(/^:/, '').trim();
            const numeric = Number(value.replace(/[^0-9.\-]/g, ''));
            rec.strike = Number.isFinite(numeric) ? numeric : rec.strike ?? null;
            continue;
          }
          if (part.toLowerCase().startsWith('symbol')) {
            const value = part.slice('symbol'.length).trim().replace(/^:/, '').trim();
            if (value && value.toUpperCase() !== 'N/A') {
              rec.optionSymbol = value;
            }
            continue;
          }
          if (part.toLowerCase().startsWith('source')) {
            const value = part.slice('source'.length).trim().replace(/^:/, '').trim();
            rec.optionSource = value || rec.optionSource || null;
          }
        }
      }
      continue;
    }

    const signalsIndex = matchLine.indexOf('Signals:');
    if (signalsIndex >= 0) {
      const lowerLine = line.toLowerCase();
      const originalIndex = lowerLine.indexOf('signals:');
      const rawSignals = originalIndex >= 0
        ? line.slice(originalIndex + 'signals:'.length).trim()
        : matchLine.slice(signalsIndex + 'Signals:'.length).trim();
      rec.signals = rawSignals === 'none'
        ? []
        : rawSignals.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    const priceMatch = matchLine.match(/Current price:\s*\$([0-9.]+)\s*\(([^)]+)\)/i);
    if (priceMatch) {
      rec.price = parseCurrency(priceMatch[1]);
      rec.priceSource = priceMatch[2];
      continue;
    }

    const strengthMatch = matchLine.match(/Strength\s*(-?\d+)%/i);
    if (strengthMatch) {
      const strength = Number(strengthMatch[1]);
      rec.ai.strength = strength;
      if (rec.ai.decision == null) {
        rec.ai.decision = strength > 50 ? 'approve' : strength > 25 ? 'caution' : 'reject';
      }
      continue;
    }

    const selectedMatch = matchLine.match(/Selected\s+(CALL|PUT)?[^@]*@\s*~?\$([0-9.]+)/i);
    if (selectedMatch) {
      if (selectedMatch[1]) {
        rec.side = selectedMatch[1].toLowerCase();
      }
      rec.entry = parseCurrency(selectedMatch[2]);
      continue;
    }

    const suggestedMatch = matchLine.match(/Suggested\s+(CALL|PUT)?[^@]*@\s*~?\$([0-9.]+)/i);
    if (suggestedMatch) {
      if (suggestedMatch[1]) {
        rec.side = suggestedMatch[1].toLowerCase();
      }
      rec.entry = parseCurrency(suggestedMatch[2]);
      continue;
    }

    const stopTargetMatch = matchLine.match(/Stop\s*~?\$([0-9.]+|N\/A)\s*\|\s*Target\s*~?\$([0-9.]+|N\/A)/i);
    if (stopTargetMatch) {
      rec.stop = stopTargetMatch[1] !== 'N/A' ? parseCurrency(stopTargetMatch[1]) : rec.stop ?? null;
      rec.target = stopTargetMatch[2] !== 'N/A' ? parseCurrency(stopTargetMatch[2]) : rec.target ?? null;
      continue;
    }

    const sizingMatch = matchLine.match(/Position sizing:\s*buy\s+(\d+)\s+contract(?:s)?/i);
    if (sizingMatch) {
      rec.qty = Number(sizingMatch[1]);
      const riskMatch = matchLine.match(/Risk\s*~?\$([0-9.]+)/i);
      if (riskMatch) {
        rec.risk = parseCurrency(riskMatch[1]);
      }
      const perContractMatch = matchLine.match(/per contract\s*~?\$([0-9.]+)/i);
      if (perContractMatch) {
        rec.riskPerContract = parseCurrency(perContractMatch[1]);
      }
      continue;
    }

    if (matchLine.toLowerCase().startsWith('risk ') || matchLine.toLowerCase().startsWith('warning')) {
      rec.warning = asciiLine || line;
      continue;
    }

    if (matchLine.startsWith('Profit plan:')) {
      rec.scalingPlan = [];
      collectingPlanFor = rec.symbol;
      continue;
    }

    if (collectingPlanFor === rec.symbol) {
      const planStepMatch = matchLine.match(/^(\d+)\)\s+Sell\s+(\d+)\s*@\s*([^\s]+)\s+(.*)$/);
      if (planStepMatch) {
        addPlanStep(rec, Number(planStepMatch[1]), Number(planStepMatch[2]), planStepMatch[3], planStepMatch[4]);
        continue;
      }
    }

    const aiDecisionMatch = matchLine.match(/AI Decision:\s*(approve|caution|reject)/i);
    if (aiDecisionMatch) {
      rec.ai.decision = aiDecisionMatch[1].toLowerCase();
      const confidenceMatch = matchLine.match(/confidence:\s*([0-9.]+)/i);
      if (confidenceMatch) {
        const confValue = Number(confidenceMatch[1]);
        if (Number.isFinite(confValue)) {
          rec.ai.confidence = String(Math.round(confValue)) + '%';
        }
      }
      continue;
    }

    if (matchLine.toLowerCase().startsWith('skipping')) {
      rec.skipped = true;
      continue;
    }
  }

  const recommendations = Array.from(recMap.values());
  recommendations.sort((a, b) => {
    const aStrength = Number.isFinite(a.ai.strength) ? a.ai.strength : -Infinity;
    const bStrength = Number.isFinite(b.ai.strength) ? b.ai.strength : -Infinity;
    return bStrength - aStrength;
  });

  const providerLabel = activeProvider || provider || null;
  const modelLabel = activeModel || model || null;
  for (const rec of recommendations) {
    const needsQty = !Number.isFinite(rec.qty) || rec.qty <= 0;
    if (needsQty) {
      const planIterations = Array.isArray(rec.scalingPlan) ? rec.scalingPlan : [];
      const tradePlanSteps = Array.isArray(rec.tradePlan?.iterations) ? rec.tradePlan.iterations : [];
      const steps = planIterations.length ? planIterations : tradePlanSteps;
      if (steps.length) {
        const inferredQty = steps.reduce((sum, step) => {
          const sellQty = Number(step?.sellQty ?? step?.quantity ?? step?.qty);
          return Number.isFinite(sellQty) && sellQty > 0 ? sum + sellQty : sum;
        }, 0);
        if (Number.isFinite(inferredQty) && inferredQty > 0) {
          rec.qty = Math.trunc(inferredQty);
          rec.qtySource = 'scaling_plan';
        }
      }
    }

    rec.provider = rec.provider || providerLabel;
    rec.ai = rec.ai || {};
    if (providerLabel && !rec.ai.provider) {
      rec.ai.provider = providerLabel;
    }
    if (modelLabel && !rec.ai.model) {
      rec.ai.model = modelLabel;
    }
  }

  return {
    recommendations,
    meta: {
      provider: providerLabel,
      model: modelLabel,
    },
  };
}
async function triggerScan(source = 'auto') {
  if (isScanning) {
    return { success: false, statusCode: 409, error: 'Scan already in progress' };
  }

  isScanning = true;
  const startedAt = new Date();
  const startedMs = Date.now();
  clearPendingTimer();

  const symbolsList = Array.isArray(scanConfig.symbols) ? scanConfig.symbols : [];
  const strategy = normalizeStrategy(scanConfig.strategy) || DEFAULT_STRATEGY;
  const expiryType = STRATEGY_DEFAULT_EXPIRY[strategy] || STRATEGY_DEFAULT_EXPIRY[FALLBACK_STRATEGY];
  const providers = resolveUiProviders();
  const envBase = { ...process.env };
  if (symbolsList.length) {
    envBase.SCAN_SYMBOLS = symbolsList.join(',');
  }
  envBase.TRADING_STRATEGY = strategy;
  envBase.EXPIRY_TYPE = expiryType;
  envBase.UI_SELECTED_STRATEGY = strategy;
  envBase.UI_SELECTED_EXPIRY_TYPE = expiryType;

  let commandToRun = buildAgentCommand(symbolsList, strategy, expiryType);
  const runSummaries = [];
  const runErrors = [];
  let response;

  try {
    console.log(`Starting ${source} AI scan with command: ${commandToRun} (symbols: ${symbolsList.join(', ') || 'default'}, strategy: ${strategy}, expiry: ${expiryType})`);
    console.log(`Providers: ${providers.join(', ')}`);

    try {
      for (const providerId of providers) {
        const runEnv = {
          ...envBase,
          AI_PROVIDER: providerId,
          AGENT_AI_PROVIDER: providerId,
          STREAM_AI_PROVIDER: providerId,
          GUARDIAN_AI_PROVIDER: providerId,
        };
        const runStartedMs = Date.now();
        const runStartedAt = new Date(runStartedMs).toISOString();
        console.log(`→ Executing provider ${providerId}: ${commandToRun}`);
        try {
          const { stdout, stderr } = await execAsync(commandToRun, {
            cwd: path.join(__dirname, '..'),
            timeout: AGENT_TIMEOUT_MS,
            env: runEnv,
          });
          if (LOG_AGENT_OUTPUT) {
            if (stdout && stdout.trim()) {
              console.log(`[${providerId}] agent stdout:\n${stdout}`);
            } else {
              console.log(`[${providerId}] agent stdout: <empty>`);
            }
            if (stderr && stderr.trim()) {
              console.warn(`[${providerId}] agent stderr:\n${stderr}`);
            }
          }
          const parsed = parseAIOutput(stdout, { provider: providerId, model: runEnv.AI_MODEL });
          runSummaries.push({
            provider: parsed.meta.provider || providerId,
            model: parsed.meta.model || runEnv.AI_MODEL || null,
            rawOutput: stdout,
            stderr,
            parsed: parsed.recommendations,
            startedAt: runStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - runStartedMs,
            command: commandToRun,
            strategy,
            expiryType,
          });
        } catch (providerError) {
          console.error(`Provider ${providerId} scan error:`, providerError.message);
          if (LOG_AGENT_OUTPUT) {
            if (providerError.stdout && providerError.stdout.trim()) {
              console.log(`[${providerId}] agent stdout (error case):\n${providerError.stdout}`);
            }
            if (providerError.stderr && providerError.stderr.trim()) {
              console.warn(`[${providerId}] agent stderr (error case):\n${providerError.stderr}`);
            }
          }
          runErrors.push({
            provider: providerId,
            message: providerError.message,
            stdout: providerError.stdout,
            stderr: providerError.stderr,
            strategy,
            expiryType,
          });
        }
      }
    } catch (error) {
      console.error('Scan orchestration error:', error);
      runErrors.push({
        provider: 'system',
        message: error.message,
        stack: error.stack,
      });
    }

    if (!runSummaries.length) {
      const completedAt = new Date().toISOString();
      lastScanMeta = {
        startedAt: startedAt.toISOString(),
        completedAt,
        durationMs: Date.now() - startedMs,
        source,
        success: false,
        symbols: Array.from(symbolsList),
        providers,
        strategy,
        expiryType,
        errors: runErrors,
      };
      lastScanError = {
        message: 'All AI provider scans failed',
        providers: runErrors,
        command: commandToRun,
        timestamp: completedAt,
      };
      response = { success: false, statusCode: 502, error: lastScanError.message };
    } else {
      const completedAt = new Date().toISOString();
      const flattened = [];
      for (const run of runSummaries) {
        for (const rec of run.parsed) {
          const clone = {
            ...rec,
            ai: { ...(rec.ai || {}) },
          };
          clone.provider = clone.provider || run.provider;
          if (!clone.ai.provider) {
            clone.ai.provider = run.provider;
          }
          if (run.model && !clone.ai.model) {
            clone.ai.model = run.model;
          }
          flattened.push(clone);
        }
      }

      flattened.sort((a, b) => {
        const symA = String(a.symbol || '').toUpperCase();
        const symB = String(b.symbol || '').toUpperCase();
        const symbolCmp = symA.localeCompare(symB);
        if (symbolCmp !== 0) return symbolCmp;
        const providerA = String(a.ai?.provider || a.provider || '');
        const providerB = String(b.ai?.provider || b.provider || '');
        return providerA.localeCompare(providerB);
      });

      latestResults = {
        runs: runSummaries,
        rawOutput: runSummaries.map((run) => `# ${run.provider}\n${run.rawOutput}`).join('\n'),
        parsed: flattened,
        startedAt: startedAt.toISOString(),
        completedAt,
        durationMs: Date.now() - startedMs,
        command: commandToRun,
        source,
        symbols: Array.from(symbolsList),
        providers,
        strategy,
        expiryType,
        errors: runErrors,
      };

      lastScanMeta = {
        startedAt: startedAt.toISOString(),
        completedAt,
        durationMs: Date.now() - startedMs,
        source,
        success: true,
        symbols: Array.from(symbolsList),
        providers: runSummaries.map((run) => ({ provider: run.provider, model: run.model })),
        strategy,
        expiryType,
        errors: runErrors,
      };
      lastScanError = runErrors.length ? { message: 'One or more providers failed', providers: runErrors } : null;
      response = { success: true, results: latestResults };
    }
  } finally {
    isScanning = false;
    const nextDelay = nextScanDelayOverride != null ? nextScanDelayOverride : AGENT_INTERVAL_MS;
    nextScanDelayOverride = null;
    scheduleNextScan(nextDelay);
  }

  return response;
}

function scheduleNextScan(delayMs = AGENT_INTERVAL_MS) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }

  clearPendingTimer();
  scanTimer = setTimeout(() => {
    triggerScan('auto').catch((err) => {
      console.error('Auto scan failed:', err);
    });
  }, delayMs);
}

function clearPendingTimer() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

// Serve the main dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
console.log(`Attempting to start server on port ${PORT}...`);
app.listen(PORT, () => {
  console.log(`Trading Dashboard running at http://localhost:${PORT}`);
  console.log(`Open your browser to view AI recommendations and execute trades`);
  console.log(`Auto-scanning every ${AGENT_INTERVAL_MS}ms with command: ${AGENT_COMMAND}`);
  console.log(`Initial symbol watchlist: ${scanConfig.symbols.join(', ')}`);
  scheduleNextScan(1000);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

// module.exports = app;
