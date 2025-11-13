function mapSymbols(symbols, provider) {
  const out = [];
  const rev = {};
  for (const s of symbols) {
    const u = s.toUpperCase();
    if (provider === 'yahoo') {
      const fut = { ES: 'ES=F', NQ: 'NQ=F', MES: 'MES=F', MNQ: 'MNQ=F' };
      const mapped = fut[u] || u;
      out.push(mapped);
      rev[mapped] = u;
    } else if (provider === 'stooq') {
      const map = {
        SPY: 'spy.us',
        QQQ: 'qqq.us',
        ES: 'es.f',
        NQ: 'nq.f',
        MES: 'mes.f',
        MNQ: 'mnq.f',
      };
      const mapped = map[u] || `${u.toLowerCase()}.us`;
      out.push(mapped);
      rev[mapped] = u;
    } else {
      out.push(u);
      rev[u] = u;
    }
  }
  return { providerSymbols: out, reverseMap: rev };
}

async function fetchYahooQuotes(symbols, { debug = false } = {}) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&lang=en-US&region=US`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://finance.yahoo.com/',
    },
  });
  if (!res.ok) {
    const err = new Error(`Yahoo quotes HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (debug) {
    console.log(`yahoo url=${url}`);
    console.log(`yahoo count=${data?.quoteResponse?.result?.length || 0}`);
  }
  const out = {};
  const results = data?.quoteResponse?.result || [];
  for (const r of results) {
    if (!r || !r.symbol) continue;
    const price = r.regularMarketPrice ?? r.postMarketPrice ?? r.preMarketPrice;
    if (price !== undefined && price !== null) {
      out[r.symbol.toUpperCase()] = {
        price: Number(price),
        ts: (r.regularMarketTime || r.postMarketTime || r.preMarketTime) ? new Date(((r.regularMarketTime || r.postMarketTime || r.preMarketTime) * 1000)).toISOString() : new Date().toISOString(),
        source: 'yahoo',
      };
    }
  }
  return out;
}

async function fetchStooqQuotes(symbols, { debug = false } = {}) {
  const syms = symbols.map(s => s.toLowerCase());
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(syms.join(','))}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'text/csv,*/*' } });
  if (!res.ok) throw new Error(`Stooq quotes HTTP ${res.status}`);
  const text = await res.text();
  if (debug) {
    console.log(`stooq url=${url}`);
    console.log(`stooq bytes=${text.length}`);
    console.log(text.split(/\r?\n/).slice(0,3).join("\n"));
  }
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return {};
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idxSymbol = header.indexOf('symbol');
  const idxClose = header.indexOf('close');
  const idxDate = header.indexOf('date');
  const idxTime = header.indexOf('time');
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const sym = (cols[idxSymbol] || '').toUpperCase();
    const rawClose = (cols[idxClose] || '').trim();
    if (rawClose === 'N/D' || rawClose === '') continue;
    const price = Number(rawClose);
    const d = cols[idxDate];
    const t = cols[idxTime];
    if (sym && Number.isFinite(price)) {
      const ts = (d && t) ? new Date(`${d}T${t}Z`).toISOString() : new Date().toISOString();
      out[sym] = { price, ts, source: 'stooq' };
    }
  }
  return out;
}

async function fetchAlphaVantageQuotes(symbols, { apiKey, debug = false } = {}) {
  if (!apiKey) return {};
  const out = {};
  for (const symbol of symbols) {
    try {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const quote = data['Global Quote'];
      if (quote && quote['05. price']) {
        const price = Number(quote['05. price']);
        const ts = quote['07. latest trading day'] ? new Date(quote['07. latest trading day']).toISOString() : new Date().toISOString();
        if (Number.isFinite(price)) {
          out[symbol.toUpperCase()] = { price, ts, source: 'alphavantage' };
        }
      }
      // Rate limit: 5 calls/minute free tier
      await new Promise(r => setTimeout(r, 12000)); // 12s delay
    } catch (e) {
      if (debug) console.log(`AlphaVantage ${symbol} error:`, e.message);
    }
  }
  return out;
}

async function fetchIEXQuotes(symbols, { apiKey, debug = false } = {}) {
  if (!apiKey) return {};
  try {
    const url = `https://cloud.iexapis.com/stable/stock/market/quote?symbols=${symbols.join(',')}&token=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IEX HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const quote of data) {
      if (quote.symbol && quote.latestPrice) {
        out[quote.symbol.toUpperCase()] = {
          price: Number(quote.latestPrice),
          ts: new Date(quote.latestUpdate).toISOString(),
          source: 'iex'
        };
      }
    }
    return out;
  } catch (e) {
    if (debug) console.log('IEX error:', e.message);
    return {};
  }
}

async function fetchFMPQuotes(symbols, { apiKey, debug = false } = {}) {
  if (!apiKey || !Array.isArray(symbols) || !symbols.length) return {};
  const out = {};
  const chunkSize = 50;

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const joined = chunk.join(',');
    try {
      const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${encodeURIComponent(joined)}&apikey=${apiKey}`;
      if (debug) console.log(`fmp bulk url=${url}`);
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json, text/plain, */*' },
      });
      if (!res.ok) throw new Error(`FMP HTTP ${res.status}`);
      const data = await res.json();
      const records = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : (data && typeof data === 'object' ? Object.values(data) : []);
      for (const quote of records) {
        if (!quote || !quote.symbol) continue;
        const price = quote.price ?? quote.ask ?? quote.bid;
        if (price == null) continue;
        const tsMillis = quote.timestamp ? Number(quote.timestamp) * 1000 : Date.now();
        const payload = {
          price: Number(price),
          ts: new Date(tsMillis).toISOString(),
          source: 'fmp',
        };
        const volume = Number(quote.volume ?? quote.avgVolume ?? Number.NaN);
        if (Number.isFinite(volume) && volume >= 0) {
          payload.volume = volume;
        }
        const prevClose = Number(quote.previousClose);
        if (Number.isFinite(prevClose)) {
          payload.prevClose = prevClose;
        }
        out[quote.symbol.toUpperCase()] = payload;
      }
    } catch (e) {
      if (debug) console.log('FMP bulk error:', e.message);
    }
  }

  return out;
}

async function fetchMockQuotes(symbols, { debug = false } = {}) {
  const mockData = {
    SPY: { price: 450.25, ts: new Date().toISOString(), source: 'mock' },
    QQQ: { price: 380.8, ts: new Date().toISOString(), source: 'mock' },
    AAPL: { price: 175.5, ts: new Date().toISOString(), source: 'mock' },
    TSLA: { price: 245.3, ts: new Date().toISOString(), source: 'mock' },
    GOOGL: { price: 135.75, ts: new Date().toISOString(), source: 'mock' },
    NVDA: { price: 485.2, ts: new Date().toISOString(), source: 'mock' }
  };

  const out = {};
  for (const symbol of symbols) {
    const key = symbol.toUpperCase();
    if (mockData[key]) out[key] = mockData[key];
  }
  if (debug) console.log(`mock quotes returned ${Object.keys(out).length} results`);
  return out;
}

async function getQuotes(symbols, { provider = 'fmp', debug = false } = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};
  const { reverseMap } = mapSymbols(symbols, provider);
  let raw = {};
  let activeReverseMap = reverseMap;
  const providers = ['fmp', 'yahoo', 'stooq', 'alphavantage', 'iex', 'mock'];
  const idx = providers.indexOf(provider);
  const startIndex = idx >= 0 ? idx : 0;

  for (let i = 0; i < providers.length; i++) {
    const currentProvider = providers[(startIndex + i) % providers.length];
    try {
      const { providerSymbols: ps, reverseMap: rm } = mapSymbols(symbols, currentProvider);
      if (debug) console.log(`Trying ${currentProvider} provider...`);

      if (currentProvider === 'stooq') raw = await fetchStooqQuotes(ps, { debug });
      else if (currentProvider === 'fmp') raw = await fetchFMPQuotes(ps, { apiKey: process.env.FMP_API_KEY, debug });
      else if (currentProvider === 'alphavantage') raw = await fetchAlphaVantageQuotes(ps, { apiKey: process.env.ALPHA_VANTAGE_API_KEY, debug });
      else if (currentProvider === 'iex') raw = await fetchIEXQuotes(ps, { apiKey: process.env.IEX_API_KEY, debug });
      else if (currentProvider === 'mock') raw = await fetchMockQuotes(ps, { debug });
      else raw = await fetchYahooQuotes(ps, { debug });

      if (Object.keys(raw).length > 0) {
        if (debug) console.log(`Successfully got quotes from ${currentProvider}`);
        activeReverseMap = rm;
        break;
      }
    } catch (e) {
      if (debug) console.log(`${currentProvider} failed:`, e.message);
      continue;
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const orig = activeReverseMap[k] || k;
    out[orig] = v;
  }
  return out;
}

module.exports = { getQuotes };
