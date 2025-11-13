const etrade = require('./etrade');

function hasEtradeCredentials() {
  return Boolean(
    process.env.ETRADE_CONSUMER_KEY &&
    process.env.ETRADE_CONSUMER_SECRET &&
    process.env.ETRADE_ACCESS_TOKEN &&
    process.env.ETRADE_ACCESS_TOKEN_SECRET
  );
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function toIsoDate(year, month, day) {
  if (![year, month, day].every((n) => Number.isFinite(n))) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function normalizeExpiryValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const isoMatch = trimmed.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return toIsoDate(Number(y), Number(m), Number(d));
    }
    const shortMatch = trimmed.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
    if (shortMatch) {
      const [, m, d, y] = shortMatch;
      return toIsoDate(2000 + Number(y), Number(m), Number(d));
    }
  }
  return null;
}

function parseOptionSymbolMeta(optionSymbol) {
  if (!optionSymbol || typeof optionSymbol !== 'string') return null;
  const trimmed = optionSymbol.trim();
  const match = trimmed.match(/(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
  if (!match) return null;
  const [, yy, mm, dd, cp, strikeRaw] = match;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const strike = Number(strikeRaw) / 1000;
  const type = cp.toUpperCase() === 'C' ? 'CALL' : 'PUT';
  return {
    expiry: toIsoDate(year, month, day),
    strike: Number.isFinite(strike) ? strike : null,
    type,
  };
}

function normalizeOptionRecord(raw, { source } = {}) {
  if (!raw) return null;
  let strike = Number(raw.strike ?? raw.StrikePrice ?? raw.strikePrice);
  const optionSymbol = raw.contractSymbol || raw.optionSymbol || raw.symbol || raw.OptionSymbol || raw.osiKey || raw.displaySymbol || null;
  const occMeta = parseOptionSymbolMeta(optionSymbol);
  if (!Number.isFinite(strike) && Number.isFinite(occMeta?.strike)) {
    strike = occMeta.strike;
  }
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
  if (!type && occMeta?.type) {
    type = occMeta.type;
  }
  let expiry =
    normalizeExpiryValue(raw.expiryDate || raw.expirationDate || raw.expiration || raw.expiry) ||
    (Number.isFinite(raw.expiryYear) && Number.isFinite(raw.expiryMonth) && Number.isFinite(raw.expiryDay)
      ? toIsoDate(
          raw.expiryYear < 100 ? raw.expiryYear + 2000 : Number(raw.expiryYear),
          Number(raw.expiryMonth),
          Number(raw.expiryDay),
        )
      : null) ||
    occMeta?.expiry ||
    null;
  return {
    source,
    strike,
    type,
    expiry,
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
  parseOptionSymbolMeta,
};
