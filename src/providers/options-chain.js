const etrade = require('./etrade');

function hasEtradeCredentials() {
  return Boolean(
    process.env.ETRADE_CONSUMER_KEY &&
    process.env.ETRADE_CONSUMER_SECRET &&
    process.env.ETRADE_ACCESS_TOKEN &&
    process.env.ETRADE_ACCESS_TOKEN_SECRET
  );
}

function normalizeOptionRecord(raw, { source } = {}) {
  if (!raw) return null;
  const strike = Number(raw.strike ?? raw.StrikePrice ?? raw.strikePrice);
  if (!Number.isFinite(strike)) return null;
  const typeRaw = raw.type ?? raw.optionType ?? raw.callPut ?? raw.callOrPut ?? raw.contractType ?? raw.putCall;
  let type = typeof typeRaw === 'string' ? typeRaw.toUpperCase() : null;
  if (type === 'C') type = 'CALL';
  if (type === 'P') type = 'PUT';
  const bid = Number(raw.bid ?? raw.Bid ?? raw.bidPrice ?? raw.bidPriceInDouble ?? raw.all?.bid);
  const ask = Number(raw.ask ?? raw.Ask ?? raw.askPrice ?? raw.askPriceInDouble ?? raw.all?.ask);
  const last = Number(raw.last ?? raw.lastPrice ?? raw.Last ?? raw.lastPriceInDouble ?? raw.all?.lastTrade ?? raw.quote?.last);
  const delta = raw.delta != null ? Number(raw.delta) : (raw.OptionGreeks?.delta != null ? Number(raw.OptionGreeks.delta) : undefined);
  const oi = Number(raw.oi ?? raw.openInterest ?? raw.openint ?? raw.openinterest);
  const vol = Number(raw.vol ?? raw.volume ?? raw.totalVolume);
  const optionSymbol = raw.contractSymbol || raw.optionSymbol || raw.symbol || raw.OptionSymbol || raw.osiKey || raw.displaySymbol || null;
  return {
    source,
    strike,
    type,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    last: Number.isFinite(last) ? last : null,
    delta: Number.isFinite(delta) ? delta : null,
    oi: Number.isFinite(oi) ? oi : null,
    vol: Number.isFinite(vol) ? vol : null,
    optionSymbol,
    raw,
  };
}

async function fetchEtradeChain({ symbol, expiry, includeGreeks = true }) {
  if (!hasEtradeCredentials()) throw new Error('E*TRADE credentials are not configured');
  const options = await etrade.getOptionChain({ symbol, expiry, includeGreeks });
  const normalized = Array.isArray(options)
    ? options.map((o) => normalizeOptionRecord(o, { source: 'etrade' })).filter(Boolean)
    : [];
  normalized.sort((a, b) => a.strike - b.strike);
  return {
    source: 'etrade',
    options: normalized,
  };
}

async function fetchFmpChain({ symbol, expiry, includeGreeks = true }) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not configured');
  const upperSymbol = symbol.toUpperCase();
  const baseUrl = `https://financialmodelingprep.com/api/v3/options/${encodeURIComponent(upperSymbol)}`;
  const search = new URLSearchParams({ apikey: apiKey, limit: '1000' });
  if (expiry) search.set('expiration', expiry);
  const res = await fetch(`${baseUrl}?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`FMP options HTTP ${res.status}`);
  }
  const data = await res.json();
  const buckets = Array.isArray(data) ? data : [];
  let target = null;
  if (expiry) {
    target = buckets.find((b) => b?.expirationDate === expiry || b?.expiration === expiry);
  }
  if (!target && buckets.length) {
    target = buckets[0];
  }
  const entries = Array.isArray(target?.data) ? target.data : [];
  const normalized = entries.map((o) => normalizeOptionRecord(o, { source: 'fmp' })).filter(Boolean);
  normalized.sort((a, b) => a.strike - b.strike);
  return {
    source: 'fmp',
    options: normalized,
  };
}

async function fetchOptionChain({ symbol, expiry, includeGreeks = true, prefer = 'etrade', minContracts = 4 } = {}) {
  const attempts = [];
  const errors = [];

  const order = prefer === 'fmp' ? ['fmp', 'etrade'] : ['etrade', 'fmp'];
  for (const provider of order) {
    try {
      if (provider === 'etrade') {
        const result = await fetchEtradeChain({ symbol, expiry, includeGreeks });
        attempts.push(result.source);
        if (result.options.length >= minContracts) {
          return { ...result, attempts, errors };
        }
      } else if (provider === 'fmp') {
        const result = await fetchFmpChain({ symbol, expiry, includeGreeks });
        attempts.push(result.source);
        if (result.options.length >= minContracts) {
          return { ...result, attempts, errors };
        }
      }
    } catch (err) {
      errors.push({ provider, message: err.message });
    }
  }

  return {
    source: attempts[0] || null,
    options: [],
    attempts,
    errors,
  };
}

module.exports = {
  fetchOptionChain,
  fetchEtradeChain,
  fetchFmpChain,
  hasEtradeCredentials,
};
