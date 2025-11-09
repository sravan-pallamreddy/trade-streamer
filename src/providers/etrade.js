require('dotenv').config();
const { buildOAuthHeader } = require('./oauth1');

function getEnv(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`Missing env ${name}`);
  return v;
}

function baseUrl() {
  return process.env.ETRADE_BASE_URL || 'https://apisb.etrade.com';
}

async function etFetch(path, { method = 'GET', query = {}, body } = {}) {
  const url = `${baseUrl()}${path}`;
  const consumerKey = getEnv('ETRADE_CONSUMER_KEY');
  const consumerSecret = getEnv('ETRADE_CONSUMER_SECRET');
  // Some users paste URL-encoded tokens (with %2F, %3D). Decode repeatedly until stable.
  const safeDecode = (v) => {
    if (!v) return v;
    let cur = v;
    for (let i = 0; i < 3; i++) {
      try {
        if (/%[0-9A-Fa-f]{2}/.test(cur)) {
          const next = decodeURIComponent(cur);
          if (next === cur) break;
          cur = next;
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    return cur;
  };
  const token = getEnv('ETRADE_ACCESS_TOKEN'); // safeDecode(getEnv('ETRADE_ACCESS_TOKEN'));
  const tokenSecret = getEnv('ETRADE_ACCESS_TOKEN_SECRET'); // safeDecode(getEnv('ETRADE_ACCESS_TOKEN_SECRET'));
  const debug = !!process.env.DEBUG_OAUTH;
  const { buildOAuthParts } = require('./oauth1');
  const parts = buildOAuthParts({ method, url, query, consumerKey, consumerSecret, token, tokenSecret });
  const authHeader = parts.header;
  if (debug) {
    console.log('etrade token present:', !!token, 'length:', token?.length);
    console.log('etrade tokenSecret present:', !!tokenSecret, 'length:', tokenSecret?.length);
    console.log('etrade baseString:', parts.baseString);
    console.log('etrade header:', authHeader);
    console.log('etrade headerParams:', JSON.stringify(parts.headerParams, null, 2));
  }
  const fullUrl = Object.keys(query).length ? `${url}?${new URLSearchParams(query).toString()}` : url;
  const res = await fetch(fullUrl, {
    method,
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`E*TRADE HTTP ${res.status}: ${text}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function getEquityQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const joined = symbols.join(',');
  // Do NOT pre-encode path segments; OAuth base string must encode once
  const data = await etFetch(`/v1/market/quote/${joined}.json`, { query: { detailFlag: 'ALL' } });
  const out = {};
  const items = data?.QuoteResponse?.QuoteData || [];
  for (const qd of items) {
    const s = (qd?.Product?.symbol || '').toUpperCase();
    let price = undefined;
    if (qd?.All && qd.All.lastTrade != null) price = Number(qd.All.lastTrade);
    else if (qd?.Intraday && qd.Intraday.lastTrade != null) price = Number(qd.Intraday.lastTrade);
    else if (qd?.All && qd.All.close != null) price = Number(qd.All.close);
    const tsMillis = qd?.dateTimeUTC != null ? Number(qd.dateTimeUTC) : Date.now();
    if (s && Number.isFinite(price)) {
      out[s] = { price, ts: new Date(tsMillis).toISOString(), source: 'etrade' };
    }
  }
  return out;
}

// Options chain (E*TRADE). Tries to be resilient to response shape.
// params: { symbol, expiry (YYYY-MM-DD), includeGreeks=true }
async function getOptionChain({ symbol, expiry, includeGreeks = true }) {
  if (!symbol) throw new Error('getOptionChain: symbol required');
  const query = { symbol, expiryDate: expiry, includeGreeks: includeGreeks ? 'true' : 'false' };
  // API path per E*TRADE docs
  const data = await etFetch(`/v1/market/optionchains.json`, { query });
  const root = data?.OptionChainResponse || data?.OptionChain || data;
  const list = [];
  function pushOpt(x) {
    if (!x) return;
    const strike = Number(x.strikePrice ?? x.strike ?? x.StrikePrice);
    const type = (x.optionType ?? x.callPut ?? x.type ?? x.callOrPut ?? '').toString().toUpperCase();
    const bid = Number(x.bid ?? x.Bid ?? x.all?.bid ?? x.quote?.bid ?? x.BidPrice);
    const ask = Number(x.ask ?? x.Ask ?? x.all?.ask ?? x.quote?.ask ?? x.AskPrice);
    const last = Number(x.lastPrice ?? x.LastPrice ?? x.all?.lastTrade ?? x.quote?.last);
    const greeks = x.OptionGreeks || x.greeks || {};
    const delta = greeks.delta != null ? Number(greeks.delta) : (x.delta != null ? Number(x.delta) : undefined);
    const oi = Number(x.openInterest ?? x.OI ?? x.openint ?? 0);
    const vol = Number(x.totalVolume ?? x.volume ?? 0);
    if (!Number.isFinite(strike)) return;
    list.push({ strike, type, bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null, last: Number.isFinite(last) ? last : null, delta, oi, vol });
  }
  // Common structures: OptionPair array containing call and put, or flat arrays
  const pairs = root?.OptionPair || root?.optionPairs || root?.Pairs;
  if (Array.isArray(pairs)) {
    for (const p of pairs) {
      if (p?.Call) pushOpt({ ...(p.Call || {}), optionType: 'CALL', strikePrice: p?.strikePrice ?? p?.StrikePrice });
      if (p?.Put) pushOpt({ ...(p.Put || {}), optionType: 'PUT', strikePrice: p?.strikePrice ?? p?.StrikePrice });
      if (!p?.Call && !p?.Put) {
        // Some variants
        pushOpt(p?.call);
        pushOpt(p?.put);
      }
    }
  }
  const calls = root?.Calls || root?.Call || root?.call;
  const puts = root?.Puts || root?.Put || root?.put;
  if (Array.isArray(calls)) for (const c of calls) pushOpt({ ...c, optionType: 'CALL' });
  if (Array.isArray(puts)) for (const p of puts) pushOpt({ ...p, optionType: 'PUT' });
  // Fallback: flat options array
  const flat = root?.Options || root?.options;
  if (Array.isArray(flat)) for (const o of flat) pushOpt(o);
  return list;
}

async function getHistoricalData({ symbol, startDate, endDate, interval = 'DAY' }) {
  // E*TRADE historical data endpoint
  // Note: This is a placeholder - E*TRADE may not have comprehensive historical data
  const query = {
    symbol,
    start: startDate,
    end: endDate,
    interval,
    e: 'product' // E*TRADE specific parameter
  };

  try {
    const data = await etFetch(`/v1/market/quote/${symbol}/history.json`, { query });
    const history = data?.history || data?.History || [];

    return history.map(item => ({
      date: item.date,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume || 0)
    }));
  } catch (e) {
    console.warn(`E*TRADE historical data not available for ${symbol}:`, e.message);
    return [];
  }
}

// Get list of accounts
async function getAccounts() {
  const data = await etFetch('/v1/accounts/list.json');
  const accounts = data?.AccountListResponse?.Accounts?.Account || [];

  return accounts.map(account => ({
    accountId: account.accountId,
    accountIdKey: account.accountIdKey,
    accountDesc: account.accountDesc,
    accountType: account.accountType,
    institutionType: account.institutionType,
    accountStatus: account.accountStatus,
    accountMode: account.accountMode
  }));
}

// Get portfolio for a specific account
async function getPortfolio(accountIdKey, { view = 'QUICK' } = {}) {
  try {
    const query = { view }; // QUICK, PERFORMANCE, FUNDAMENTAL, OPTIONS, COMPLETE
    const data = await etFetch(`/v1/accounts/${accountIdKey}/portfolio`, { query });

    const positions = data?.PortfolioResponse?.AccountPortfolio?.[0]?.Position || [];
    const accountInfo = data?.PortfolioResponse?.AccountPortfolio?.[0] || {};

    // Handle case where portfolio might be empty or have different structure
    return {
      account: {
        accountId: accountInfo.accountId || accountIdKey,
        accountIdKey: accountInfo.accountIdKey || accountIdKey,
        accountDesc: accountInfo.accountDesc || 'Unknown Account',
        accountType: accountInfo.accountType || 'UNKNOWN',
        buyingPower: Number(accountInfo.buyingPower || 0),
        cashAvailableForWithdrawal: Number(accountInfo.cashAvailableForWithdrawal || 0),
        cashBalance: Number(accountInfo.cashBalance || 0),
        totalValue: Number(accountInfo.totalValue || 0),
        marginBuyingPower: Number(accountInfo.marginBuyingPower || 0),
        settledCash: Number(accountInfo.settledCash || 0)
      },
      positions: Array.isArray(positions) ? positions.map(position => ({
        symbol: position?.Product?.symbol || 'UNKNOWN',
        symbolDescription: position?.symbolDescription || '',
        quantity: Number(position.quantity || 0),
        pricePaid: Number(position.pricePaid || 0),
        totalCost: Number(position.totalCost || 0),
        marketValue: Number(position.marketValue || 0),
        unrealizedGainLoss: Number(position.totalGain || 0),
        unrealizedGainLossPercent: Number(position.totalGainPct || 0),
        currentPrice: Number(position?.Quick?.lastTrade || 0),
        positionType: position.positionType || 'UNKNOWN',
        positionId: position.positionId || '',
        // Options specific fields
        expiry: position?.Product?.expiryYear ? `${position.Product.expiryYear}-${String(position.Product.expiryMonth).padStart(2, '0')}-${String(position.Product.expiryDay).padStart(2, '0')}` : null,
        strike: position?.Product?.strikePrice ? Number(position.Product.strikePrice) : null,
        callPut: position?.Product?.callPut || null
      })) : []
    };
  } catch (error) {
    // If portfolio endpoint fails, return empty portfolio with basic account info
    console.warn(`Portfolio endpoint failed for account ${accountIdKey}:`, error.message);
    return {
      account: {
        accountId: accountIdKey,
        accountIdKey: accountIdKey,
        accountDesc: 'Account (Portfolio Unavailable)',
        accountType: 'UNKNOWN',
        buyingPower: 0,
        cashAvailableForWithdrawal: 0,
        cashBalance: 0,
        totalValue: 0,
        marginBuyingPower: 0,
        settledCash: 0
      },
      positions: []
    };
  }
}

// Get account balance summary
async function getAccountBalance(accountIdKey) {
  try {
    const query = { 
      instType: 'BROKERAGE',
      realTimeNAV: 'true'
    };
    const data = await etFetch(`/v1/accounts/${accountIdKey}/balance.json`, { query });
    const balance = data?.BalanceResponse || {};

    return {
      accountId: balance.accountId,
      accountIdKey: balance.accountId,
      accountType: balance.accountType,
      optionLevel: balance.optionLevel,
      accountDescription: balance.accountDescription,
      dayTraderStatus: balance.dayTraderStatus,
      accountMode: balance.accountMode,
      // Cash information
      fundsForOpenOrdersCash: Number(balance.Cash?.fundsForOpenOrdersCash || 0),
      moneyMktBalance: Number(balance.Cash?.moneyMktBalance || 0),
      // Computed balances
      cashAvailableForInvestment: Number(balance.Computed?.cashAvailableForInvestment || 0),
      cashAvailableForWithdrawal: Number(balance.Computed?.cashAvailableForWithdrawal || 0),
      totalAvailableForWithdrawal: Number(balance.Computed?.totalAvailableForWithdrawal || 0),
      netCash: Number(balance.Computed?.netCash || 0),
      cashBalance: Number(balance.Computed?.cashBalance || 0),
      settledCashForInvestment: Number(balance.Computed?.settledCashForInvestment || 0),
      unSettledCashForInvestment: Number(balance.Computed?.unSettledCashForInvestment || 0),
      marginBuyingPower: Number(balance.Computed?.marginBuyingPower || 0),
      cashBuyingPower: Number(balance.Computed?.cashBuyingPower || 0),
      dtMarginBuyingPower: Number(balance.Computed?.dtMarginBuyingPower || 0),
      dtCashBuyingPower: Number(balance.Computed?.dtCashBuyingPower || 0),
      marginBalance: Number(balance.Computed?.marginBalance || 0),
      accountBalance: Number(balance.Computed?.accountBalance || 0),
      // Real-time values
      totalAccountValue: Number(balance.Computed?.RealTimeValues?.totalAccountValue || 0),
      netMv: Number(balance.Computed?.netMv || 0),
      netMvLong: Number(balance.Computed?.RealTimeValues?.netMvLong || 0),
      netMvShort: Number(balance.Computed?.RealTimeValues?.netMvShort || 0)
    };
  } catch (error) {
    console.warn(`Balance endpoint failed for account ${accountIdKey}:`, error.message);
    return {
      accountId: accountIdKey,
      accountIdKey: accountIdKey,
      accountType: 'UNKNOWN',
      error: 'Balance data unavailable',
      // Default zero values
      cashBalance: 0,
      cashAvailableForWithdrawal: 0,
      totalAccountValue: 0,
      marginBuyingPower: 0,
      netCash: 0
    };
  }
}

function collectOrderMessages(root) {
  if (!root) return [];
  const buckets = [];
  const candidates = [
    root?.Messages?.Message,
    root?.messages,
    root?.messageList,
    root?.message,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!item) continue;
        const values = [item.description, item.MessageDetail, item.message, item.text];
        for (const val of values) {
          if (val) buckets.push(String(val));
        }
      }
    } else if (typeof candidate === 'object') {
      const values = [candidate.description, candidate.MessageDetail, candidate.message, candidate.text];
      for (const val of values) {
        if (val) buckets.push(String(val));
      }
    } else if (typeof candidate === 'string') {
      buckets.push(candidate);
    }
  }
  return Array.from(new Set(buckets.filter(Boolean)));
}

function buildOptionProduct({ optionSymbol, callPut, strike, expiry }) {
  const product = {
    securityType: 'OPTION',
  };

  if (optionSymbol) {
    product.symbol = optionSymbol;
  }
  if (callPut) {
    product.callPut = callPut.toUpperCase();
  }
  if (strike != null && strike !== '') {
    const numericStrike = Number(strike);
    if (Number.isFinite(numericStrike)) {
      product.strikePrice = numericStrike;
    }
  }
  if (expiry) {
    const parts = String(expiry).split('-').map((p) => Number(p));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      const [year, month, day] = parts;
      product.expiryYear = year;
      product.expiryMonth = month;
      product.expiryDay = day;
    }
  }
  return product;
}

function buildClientOrderId(prefix = 'SOS') {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${random}`.slice(0, 32);
}

async function placeOptionMarketOrder({
  accountIdKey,
  optionSymbol,
  quantity,
  orderAction,
  callPut,
  strike,
  expiry,
}) {
  if (!accountIdKey) throw new Error('Account ID (accountIdKey) is required');
  const symbol = optionSymbol;
  if (!symbol) throw new Error('Option symbol is required for emergency sell');

  const rawQty = Number(quantity);
  if (!Number.isFinite(rawQty) || rawQty === 0) {
    throw new Error('Quantity must be a non-zero number');
  }

  const absQty = Math.abs(rawQty);
  const action = orderAction || (rawQty > 0 ? 'SELL_TO_CLOSE' : 'BUY_TO_COVER');

  const product = buildOptionProduct({ optionSymbol: symbol, callPut, strike, expiry });
  const clientOrderId = buildClientOrderId();

  const baseRequest = {
    PlaceOrderRequest: {
      orderType: 'OPTION',
      clientOrderId,
      orderTerm: 'GOOD_FOR_DAY',
      marketSession: 'REGULAR',
      priceType: 'MARKET',
      orderStrategyType: 'SINGLE',
      Instrument: [
        {
          Product: product,
          orderAction: action,
          quantityType: 'QUANTITY',
          quantity: absQty,
        },
      ],
    },
  };

  const previewPath = `/v1/accounts/${accountIdKey}/orders/preview.json`;
  const previewResponse = await etFetch(previewPath, { method: 'POST', body: baseRequest });
  const previewRoot = previewResponse?.PreviewOrderResponse || previewResponse;
  const previewIds = previewRoot?.PreviewIds?.previewId
    || previewRoot?.PreviewIds?.PreviewId
    || previewRoot?.previewId;
  const previewId = Array.isArray(previewIds) ? previewIds[0] : previewIds;

  if (!previewId) {
    const messages = collectOrderMessages(previewRoot);
    const hint = messages.length ? ` (${messages.join('; ')})` : '';
    throw new Error(`Order preview failed${hint}`);
  }

  const placeRequest = {
    PlaceOrderRequest: {
      ...baseRequest.PlaceOrderRequest,
      PreviewIds: { PreviewId: [previewId] },
    },
  };

  const placePath = `/v1/accounts/${accountIdKey}/orders/place.json`;
  const placeResponse = await etFetch(placePath, { method: 'POST', body: placeRequest });
  const placeRoot = placeResponse?.PlaceOrderResponse || placeResponse;
  const orderIds = placeRoot?.OrderIds?.orderId
    || placeRoot?.OrderIds?.OrderId
    || placeRoot?.orderId;
  const orderId = Array.isArray(orderIds) ? orderIds[0] : orderIds;

  const messages = collectOrderMessages(placeRoot);

  return {
    previewId,
    orderId: orderId || null,
    messages,
    rawPreview: previewRoot,
    rawPlace: placeRoot,
  };
}

module.exports = {
  getEquityQuotes,
  getOptionChain,
  getHistoricalData,
  getAccounts,
  getPortfolio,
  getAccountBalance,
  placeOptionMarketOrder,
};
