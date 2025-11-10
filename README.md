# Trade Streamer — Options Recommender

Minimal, local options recommender for SPY/QQQ with a continuous terminal stream.
### Daily Command Cheatsheet
```bash
# 1) Morning scan across configured symbols (AI-powered recommendations)
npm run day-trade

# Optional: keep the AI scan running every 30 seconds
npm run day-trade:watch

# 2) Start live guardian (monitors E*TRADE positions every 30s)
npm run guardian:watch

# Optional: single portfolio check without continuous monitoring
npm run guardian:once

# Stop the watchers with Ctrl+C when you're done trading
```

Notes:
- AI day-trade watcher and guardian both default to 30-second loops; override with `--interval <seconds>` or `.env` (`AGENT_INTERVAL_MS`, `GUARDIAN_INTERVAL_MS`).
- Guardian targets E*TRADE account `gks_erdl0Zw3A5ALvAvXOA` and falls back to portfolio snapshots if option chains are offline.
- Run one-off scans (`npm run day-trade`) or single portfolio checks (`npm run guardian:once`) when you don’t need continuous monitoring.

## Environment Configuration
Copy `.env.example` to `.env` and fill in your credentials. Keep `.env` out of version control (already ignored by `.gitignore`).

```bash
# Account + strategy defaults
ACCOUNT_SIZE=1000
SCAN_SYMBOLS=SPY,QQQ,AAPL,TSLA,GOOGL,NVDA
TRADING_STRATEGY=day_trade
EXPIRY_TYPE=0dte
RISK_PCT=0.005

# Risk tuning
STOP_LOSS_PCT=0.3
TAKE_PROFIT_MULT=1.5
DEFAULT_IV=0.2
OTM_PCT=0.01

# OpenAI (required for AI commentary)
OPENAI_API_KEY=sk-your-key-here

# E*TRADE API (sandbox or production)
ETRADE_BASE_URL=https://api.etrade.com
ETRADE_CONSUMER_KEY=your_consumer_key
ETRADE_CONSUMER_SECRET=your_consumer_secret
ETRADE_ACCESS_TOKEN=your_access_token
ETRADE_ACCESS_TOKEN_SECRET=your_access_token_secret
ETRADE_CALLBACK=oob

# Data providers
FMP_API_KEY=your_fmp_key
ALPHA_VANTAGE_API_KEY=optional_alpha_key

# Monitor cadence (milliseconds)
AGENT_INTERVAL_MS=30000
GUARDIAN_INTERVAL_MS=30000
```

> Tip: regenerate new API tokens before committing or sharing your project—never check real credentials into git.

## What It Does
- Suggests weekly options contracts (nearest expiry with ≥2 business days), ~2% OTM by default.
- Estimates entry price via Black–Scholes (uses IV and risk‑free assumptions).
- Computes stop‑loss, take‑profit, and position sizing by risk budget.
- Streams suggestions to the terminal at a fixed interval with live quotes.

## Install
- Node.js 18+
- Install deps: `npm install`

## Options Recommender CLI (SPY/QQQ)
One‑off suggestion for a symbol at a given price and account size.

Examples:
```
# Single symbol (SPY call), assume underlying ~450
npm run suggest -- --symbol SPY --side call --price 450 --account 25000

# Both SPY and QQQ with same inputs
npm run suggest -- --both --side put --price 390 --account 25000

# Adjust assumptions
npm run suggest -- --symbol QQQ --side call --price 380 --account 50000 --iv 0.25 --otm-pct 0.015 --sl-pct 0.4 --tp-mult 1.5 --risk-pct 0.005

# 0DTE (same-day expiry)
npm run suggest -- --symbol SPY --side call --price 450 --account 1000 --expiry $(date +%F) --otm-pct 0.01 --min-days 0
```

Notes:
- Outputs both a human‑readable summary and a JSON payload with `suggestions`.
- This is a local recommender; no brokerage API calls are made.
- For live chains, connect an options chain provider and replace strike selection with delta‑targeting and real quotes.

Files:
- `src/strategy/options.js`: contract selection and pricing.
- `src/risk.js`: position sizing utilities.
- `src/cli/suggest.js`: CLI entry point.

## Continuous Suggestions (Streaming to Terminal)
Runs a loop that fetches live prices (Yahoo Finance) and prints suggestions at a fixed interval.

Examples:
```
# Stream both SPY and QQQ, both call and put, every 30s
ACCOUNT_SIZE=25000 npm run suggest:stream

# Custom interval and side
ACCOUNT_SIZE=40000 npm run suggest:stream -- --interval 15 --side call

# Custom symbols and parameters
ACCOUNT_SIZE=30000 npm run suggest:stream -- --symbols SPY,QQQ --otm-pct 0.015 --iv 0.25

# 0DTE streaming (today's expiry)
ACCOUNT_SIZE=1000 npm run suggest:stream -- --symbols SPY,QQQ --provider mix --interval 15 --side both --odte --otm-pct 0.01 --min-days 0
```

Environment variables:
- `ACCOUNT_SIZE` (required or pass `--account`)
- `RISK_PCT` (default 0.01)
- `DEFAULT_IV` (default 0.2), `RISK_FREE` (default 0.01)
- `OTM_PCT` (default 0.02), `MIN_BUSINESS_DAYS` (default 2)
- `STOP_LOSS_PCT` (default 0.5), `TAKE_PROFIT_MULT` (default 2.0)
- `STREAM_INTERVAL_SEC` (default 30), `QUOTE_PROVIDER` (default yahoo)

Implementation:
- `src/providers/quotes.js`: live price fetcher (Yahoo Finance).
- `src/runner/suggest-stream.js`: main loop with NDJSON output for downstream piping.

## Quick Start for Small Account Day Trading 🚀

**Perfect for $300-500 daily profit goals with conservative risk management.**

### 1. Setup (5 minutes)
```bash
# Add your OpenAI API key to .env
OPENAI_API_KEY=sk-your-key-here

# Run daily scan
npm run day-trade
```

### 2. Your Configuration
- **Account Size**: $1,000 (conservative)
- **Risk per Trade**: 0.5% ($5 max loss)
- **Strategy**: Day trading with 0DTE options
- **Target**: $300-500 profit per day
- **Symbols**: SPY, QQQ, AAPL, TSLA, GOOGL, NVDA

### 3. Expected Results
```
✅ AAPL: Strong momentum, day trade recommended
   Entry: $2.50 | Stop: $1.75 | Target: $3.75
   Risk: $1.75 | Potential: $3.75

❌ TSLA: High volatility, caution advised
   AI Notes: Market conditions unfavorable

📊 Summary: 2 approved, 1 caution, 3 rejected
```

### 4. Risk Management
- **Max Loss per Trade**: $5 (0.5% of account)
- **Position Sizing**: Conservative (1-2 contracts max)
- **Stop Loss**: 30% of premium (tight protection)
- **Take Profit**: 1.5x premium (realistic targets)

### 5. Daily Routine
```bash
# Morning scan (9:30 AM ET)
npm run day-trade

# Launch live guardian to monitor open positions
npm run guardian:watch

# Review AI recommendations
# Execute 1 trade maximum
# Monitor throughout day (guardian flags stop-loss breaches)
# Close by 4:00 PM ET (Ctrl+C to stop guardian)
```

### Realistic Expectations 📈

**With $1,000 account and $300-500 daily goals:**
- **Monthly Target**: $6,000-10,000 profit
- **Win Rate Needed**: 60-70% (conservative estimates)
- **Average Win**: $15-25 per trade
- **Average Loss**: $3-5 per trade (stops)

**Scaling Strategy:**
1. **$1K-$5K**: Day trade 0DTE options (current setup)
2. **$5K-$25K**: Add swing trades with weekly options
3. **$25K+**: Upgrade to paid data (IEX/E*TRADE premium)
4. **$100K+**: Consider institutional data feeds

**Risk Warning**: Options trading involves substantial risk. Never risk more than you can afford to lose. Past performance doesn't guarantee future results.

## AI Trading Agent

Intelligent stock scanner that analyzes technical indicators and provides AI-powered options recommendations for day trading or swing trading.

Examples:
```
# Day trading scan with AI analysis
ACCOUNT_SIZE=25000 npm run ai-agent -- --symbols AAPL,TSLA,GOOGL --strategy day_trade --expiry-type 0dte

# Swing trading with monthly options
ACCOUNT_SIZE=50000 npm run ai-agent -- --symbols SPY,QQQ --strategy swing_trade --expiry-type monthly

# Custom risk and AI model
ACCOUNT_SIZE=30000 npm run ai-agent -- --symbols NVDA,AMD --risk-pct 0.005 --ai-model gpt-4o
```

Features:
- Technical analysis (RSI, MACD, Bollinger Bands, volume patterns)
- Day trading algorithms (momentum, breakout detection)
- Swing trading patterns (trend analysis, support/resistance)
- AI-powered decision making with risk assessment
- Automatic position sizing and risk management
- Strategy playbooks (momentum, mean reversion, breakout) surfaced in every recommendation

⚠️ **Data Quality Note**: Uses Yahoo Finance for technical indicators. For production trading, consider paid data providers (Alpha Vantage, IEX) for higher accuracy.

Environment variables:
- `SCAN_SYMBOLS` (comma-separated list of symbols)
- `ACCOUNT_SIZE` (required)
- `TRADING_STRATEGY` (day_trade or swing_trade, default: day_trade)
- `EXPIRY_TYPE` (weekly, monthly, 0dte, default: weekly)
- `OPENAI_API_KEY` (required for AI analysis)

Files:
- `src/cli/ai-agent.js`: AI agent CLI entry point.
- `src/strategy/indicators.js`: technical indicators calculation.
- `src/strategy/algorithms.js`: trading algorithms and signal detection.

## Web Dashboard 🖥️

User-friendly web interface for the AI trading agent with real-time recommendations and trade execution.

### Integrations at a Glance
- **E*TRADE API** – OAuth 1.0a connection powers account discovery, live balances, positions, and the emergency option exit workflow. Sensitive account numbers and balances now render masked by default with an in-app reveal toggle.
- **Financial Modeling Prep (FMP)** – Supplements recommendations with fundamentals (earnings calendar, float, sector stats) that enrich the AI prompt and upcoming UI sidebars.
- **OpenAI** – Generates narrative playbooks, confidence scoring, and risk commentary surfaced inside each recommendation card.
- **Quote Providers** – Yahoo Finance remains the default intraday feed, with optional Stooq/IEX/Alpha Vantage fallbacks configured via environment settings.

### Features
- **Live Dashboard**: Real-time AI recommendations with confidence scores
- **Trade Scanner**: One-click market scanning for trade opportunities
- **Risk Monitoring**: Visual risk management with position sizing
- **Portfolio Overview**: Account balance and P&L tracking
- **E*TRADE Integration**: Live portfolio data and account balances
- **Strategy Playbooks**: Momentum, mean-reversion, and breakout diagnostics baked into every scan
- **Trade Execution**: Direct trade placement (future feature)

### E*TRADE Setup
To enable portfolio tracking, configure E*TRADE API access:

1. **Get E*TRADE API Keys**:
   - Visit https://developer.etrade.com/
   - Sign up for API access (free for developers)

2. **Configure Environment**:
   ```bash
   # Add to .env file
   ETRADE_BASE_URL=https://api.etrade.com  # Production API
   ETRADE_CONSUMER_KEY=your_consumer_key
   ETRADE_CONSUMER_SECRET=your_consumer_secret
   ETRADE_ACCESS_TOKEN=your_access_token
   ETRADE_ACCESS_TOKEN_SECRET=your_access_token_secret
   ETRADE_CALLBACK=oob
   ```

3. **Authenticate & Get Tokens**:
   ```bash
   npm run etrade:auth
   ```

**Note**: E*TRADE production API may have limitations on portfolio data access. Some accounts may show "Portfolio Unavailable" if the API endpoints are restricted or the account has no positions. The dashboard will gracefully handle these cases and display available account information (account type, status, mode) with clear explanations.

### Dashboard Features
- **Header**: Account balance and daily profit target display
- **Scan Button**: Triggers AI analysis across configured symbols
- **Portfolio Button**: Loads E*TRADE account data and positions
- **Auto Refresh**: Manual refresh button plus automatic portfolio polling every 60 seconds
- **Account Selector**: Choose which account to view
- **Account Summary**: Total value, cash balance, buying power, unrealized P&L
- **Positions Table**: Detailed view of all holdings with P&L
- **Recommendations Grid**: Color-coded cards showing AI decisions and trade details
- **Stats Cards**: Key metrics for monitoring performance
- **Action Buttons**: Manage notes plus a one-tap **Emergency Sell** for options that submits a market exit through E*TRADE

### "Scan for Trades" Flow
1. **Button Click** – Client posts to `POST /api/scan` with the active symbol list and strategy settings.
2. **Server Guard** – `src/ui/server.js` rejects duplicate in-flight scans, records the request, then invokes `ai-agent` with current environment configuration.
3. **Data Fetching** – Quotes from Yahoo (or configured provider) and FMP fundamentals are pulled, then merged with the stored playbook metadata for context.
4. **AI Synthesis** – `src/cli/ai-agent.js` composes the OpenAI prompt, applies rule-based gates, and emits normalized recommendations (`decision`, `confidence`, `playbooks`, `risk` details).
5. **Persist & Broadcast** – Results cache in memory and hydrate `GET /api/recommendations`, while scan metadata drives the “last scan” header chip.
6. **UI Refresh** – The front-end poller (15s cadence) swaps in the new cards, re-renders symbol badges, and keeps status icons in sync.

### Quick Start
```bash
# Install dependencies
npm install

# Start the web server
node src/ui/server.js

# Open dashboard in browser
# http://localhost:3001
```

### Dashboard Features
- **Header**: Account balance and daily profit target display
- **Scan Button**: Triggers AI analysis across configured symbols
- **Recommendations Grid**: Color-coded cards showing:
  - ✅ **Approve**: Strong trade setup (green)
  - ⚠️ **Caution**: Moderate risk (yellow)
  - ❌ **Reject**: High risk or unfavorable conditions (red)
- **Stats Cards**: Key metrics (P&L, active trades, risk limits, AI confidence)
- **Trade Cards**: Entry price, stop loss, target, and action buttons

### API Endpoints
- `GET /api/recommendations`: Get current AI recommendations
- `POST /api/scan`: Trigger new market scan and AI analysis
- `GET /api/portfolio/accounts`: Get list of E*TRADE accounts
- `GET /api/portfolio/:accountIdKey`: Get portfolio for specific account
- `GET /api/portfolio/:accountIdKey/balance`: Get account balance details
- `POST /api/portfolio/:accountIdKey/options/emergency-sell`: Submit a market exit for an option contract (uses E*TRADE preview/place flow)
- `GET /`: Serve the main dashboard interface

### Configuration
The dashboard uses the same environment variables as the CLI agent:
- `ACCOUNT_SIZE`: Account balance for position sizing
- `OPENAI_API_KEY`: Required for AI analysis
- `SCAN_SYMBOLS`: Symbols to analyze (default: SPY,QQQ,AAPL,TSLA,GOOGL,NVDA)

### Files
- `src/ui/server.js`: Express server with API endpoints
- `src/ui/public/index.html`: Main dashboard interface
- `src/cli/ai-agent.js`: Backend AI analysis (shared with CLI)

## Next Steps / TODO
- Add left-rail watchlist with live quote streaming and quick scan actions.
- Surface right-rail market pulse (SPY/QQQ/VIX, sector breadth, FMP events) for context.
- Implement scheduled auto-scan cadence plus user-configurable polling interval.
- Persist recommendation history for backtesting playbook performance.
- Introduce alert hooks for key events (earnings, large price moves) that auto-trigger scans.

## Data Sources & Reliability

### Primary Data Sources
- **Yahoo Finance**: Free, real-time quotes and historical bars
- **Stooq**: Backup data source (automatically used if Yahoo fails)
- **E*TRADE API**: Live quotes and option chains (requires authentication)

### Data Quality Considerations ⚠️

**Yahoo Finance Limitations:**
- Free tier may have occasional data gaps
- Historical accuracy varies by symbol/period
- Rate limits apply (automatic fallback to Stooq)
- Not recommended for high-frequency trading

**Recommended for Production:**
```bash
# Use paid data providers for better reliability
ALPHA_VANTAGE_API_KEY=your_key
IEX_API_KEY=your_key

# Set provider in environment
QUOTE_PROVIDER=alphavantage  # or iex
```

**Available Providers:**
- `yahoo` (default, free)
- `stooq` (free backup)
- `alphavantage` (paid, high quality)
- `iex` (paid, real-time)

### Data Validation
Check data quality across multiple sources:

```bash
# Validate data consistency for specific symbols
npm run validate-data AAPL TSLA GOOGL

# Example output:
📊 Data Quality Report
======================

AAPL:
  ✅ yahoo: $150.25 (2:30:15 PM)
  ✅ stooq: $150.22 (2:30:10 PM)
  📈 Consistency: EXCELLENT (CV: 0.02%)
```

**Quality Metrics:**
- **CV (Coefficient of Variation)**: Measures price dispersion across sources
- **< 0.1%**: Excellent (prices match closely)
- **< 0.5%**: Good (minor differences acceptable)
- **< 1.0%**: Fair (acceptable for analysis)
- **> 1.0%**: Poor (consider paid data sources)

You can stream SPY/QQQ from E*TRADE and use Yahoo for ES/NQ snapshots in one process.

Setup E*TRADE env (sandbox by default):
- Add to `.env`:
  - `ETRADE_BASE_URL=https://apisb.etrade.com`
  - `ETRADE_CONSUMER_KEY=...`
  - `ETRADE_CONSUMER_SECRET=...`
  - `ETRADE_CALLBACK=oob` (PIN-based OAuth)
  - `ETRADE_ACCESS_TOKEN=...` (OAuth 1.0a)
  - `ETRADE_ACCESS_TOKEN_SECRET=...`

Run mixed provider:
```
ACCOUNT_SIZE=25000 npm run suggest:stream -- --symbols SPY,QQQ,ES,NQ --provider mix --interval 15
```

Notes:
- E*TRADE requires OAuth 1.0a access tokens. Generate them in your app (PIN flow) and paste into `.env`.
- Futures (ES/NQ) are fetched via Yahoo snapshots; use for context only, not execution.

### Get E*TRADE sandbox access tokens (PIN flow)

1) Set consumer key/secret and base URL in `.env` (see above).
2) Run the helper:
```
npm run etrade:auth
```
3) Open the printed URL, log in to E*TRADE sandbox, approve, and copy the verification code (PIN).
4) Paste the PIN back into the CLI. It will print:
```
ETRADE_ACCESS_TOKEN=...
ETRADE_ACCESS_TOKEN_SECRET=...
```
5) Add those to your `.env` and restart the stream with `--provider mix`.

## Optional: AI Enrichment (ChatGPT)

You can send each suggestion to OpenAI to get a short review with decision, confidence, risk flags, and notes.

Setup:
- Add to `.env`: `OPENAI_API_KEY=...`
- Optional envs: `USE_AI=true`, `AI_MODEL=gpt-4o-mini`, `AI_INTERVAL_SEC=60`

Run:
```
OPENAI_API_KEY=sk-... ACCOUNT_SIZE=25000 npm run suggest:stream -- --symbols SPY,QQQ,ES,NQ --provider mix --interval 30 --ai --ai-model gpt-4o-mini
```

Files:
- `src/ai/openai.js`: minimal client wrapper returning JSON.
- `src/ai/prompt.js`: system/user prompts and schema.
- `src/runner/suggest-stream.js`: `--ai` flag wiring and output.
