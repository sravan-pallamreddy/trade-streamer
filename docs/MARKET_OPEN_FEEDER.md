# Market Open Feeder

Live market data feeder that fetches intraday stock + options data from FMP and E*TRADE, computes derived metrics, and emits timestamped JSON snapshots.

## Quick Start

### 1. Set Environment Variables

Add to your `.env` file:

```bash
# Required: Data sources
FMP_API_KEY=your_fmp_key_here
ETRADE_CONSUMER_KEY=your_etrade_key
ETRADE_CONSUMER_SECRET=your_etrade_secret
ETRADE_ACCESS_TOKEN=your_access_token
ETRADE_ACCESS_TOKEN_SECRET=your_token_secret

# Required: Tickers to watch
FEEDER_TICKERS=TSLA,AAPL,NVDA

# Optional: Option contracts (format: SYMBOL:STRIKE:EXPIRY:SIDE)
# Example: TSLA:450:2025-11-14:CALL
FEEDER_CONTRACTS=TSLA:450:2025-11-14:CALL,AAPL:175:2025-11-14:PUT
```

### 2. Run the Feeder

```bash
npm run feeder
```

## How It Works

### Scheduling
- **08:30:00 CT**: Warmup phase (initial data fetch)
- **08:30:15 CT**: First snapshot emission (prints "READY_FOR_SNAPSHOTS")
- **08:30:15–08:33:00 CT**: Emits every **5 seconds**
- **08:33:00–09:30:00 CT**: Emits every **15 seconds**
- **09:30:00 CT**: Stops automatically

### Data Sources

**From FMP (Financial Modeling Prep):**
- 1-minute candles (last 60 bars)
- Computed: RSI(14), MACD(12,26,9), VWAP, volume metrics

**From E*TRADE:**
- Real-time stock price
- Option chain data (bid, ask, delta, open interest)

### Snapshot Format

Each ticker emits:

```json
BEGIN SNAPSHOT
{
  "time_ct": "08:31:05",
  "ticker": "TSLA",
  "price": 445.23,
  "vwap": 444.80,
  "rsi": 51.7,
  "macd_hist": 0.012,
  "macd_signal": 0.009,
  "volume_1m": 468000,
  "volume_20ma": 310000,
  "bid": 8.00,
  "ask": 8.10,
  "mid": 8.05,
  "oi": 15600,
  "iv": null,
  "delta": 0.48
}
END SNAPSHOT
```

## Configuration Examples

### Watch Multiple Stocks (No Options)
```bash
FEEDER_TICKERS=SPY,QQQ,AAPL,TSLA,NVDA
npm run feeder
```

### Watch Stocks + Options
```bash
FEEDER_TICKERS=TSLA,AAPL
FEEDER_CONTRACTS=TSLA:450:2025-11-14:CALL,AAPL:175:2025-11-15:PUT
npm run feeder
```

### Override Via Command Line
```bash
FEEDER_TICKERS=TSLA npm run feeder
```

## Output

- **STDOUT**: Snapshot JSON (BEGIN/END markers)
- **STDERR**: Logs, errors, status messages

### Redirect Output
```bash
# Save snapshots to file
npm run feeder > snapshots.txt 2>feeder.log

# Pipe to evaluator
npm run feeder | node evaluator.js
```

## Data Quality & Fallbacks

- Missing fields are set to `null` (keys are never omitted)
- FMP indicators computed locally if API unavailable
- E*TRADE option legs searched ±1 strike if exact match fails
- Retries transient errors up to 2 times with backoff
- Never blocks on partial data—emits with available fields

## Timezone Notes

- All times are **Central Time (CT)**
- `time_ct` field format: `HH:MM:SS`
- Script uses UTC-6 offset (CST); adjust if needed for CDT

## Troubleshooting

### "No tickers specified"
- Set `FEEDER_TICKERS` or `SCAN_SYMBOLS` in `.env`

### "E*TRADE HTTP 401"
- Re-authenticate: `npm run etrade:auth`
- Ensure tokens are not URL-encoded in `.env`

### "FMP returned no bars"
- Check `FMP_API_KEY` is valid
- Verify market is open (pre-market data may be limited)

### Option leg not found
- Confirm expiry format is `YYYY-MM-DD`
- Check if strike exists in the chain
- Script will search ±1 strike automatically

## Next Steps

Create an **evaluator playbook** that reads these snapshots and applies your market-open entry rules. The evaluator can parse `BEGIN SNAPSHOT` / `END SNAPSHOT` blocks from STDIN and make ENTER/WAIT/REJECT decisions.

## API Keys

- **FMP**: Get free tier at https://financialmodelingprep.com/
- **E*TRADE**: Developer portal at https://developer.etrade.com/
