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
UI_DEFAULT_STRATEGY=day_trade
UI_AGENT_LOG_OUTPUT=true
ETRADE_DEFAULT_ACCOUNT_KEY=optional_preferred_account
RISK_PCT=0.005

# Risk tuning
STOP_LOSS_PCT=0.3
TAKE_PROFIT_MULT=1.5
DEFAULT_IV=0.2
OTM_PCT=0.01

# AI provider (OpenAI default; set AI_PROVIDER=deepseek for DeepSeek)
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
# DEEP_SEEK_API_KEY=sk-your-deepseek-key

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
One-off suggestion for a symbol at a given price and account size.

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

### Option Chain Inspector

Inspect tradable contracts before placing an order:

```
# View first 15 call contracts for TSLA on a specific expiry
node src/cli/show-chain.js --symbol TSLA --expiry 2025-11-14 --side call --limit 15

# Flip to puts and prefer FMP data if E*TRADE chain is unavailable
node src/cli/show-chain.js --symbol NVDA --expiry 2025-11-14 --side put --prefer fmp
```

The script automatically falls back between E*TRADE and FMP and highlights bid/ask spread, mid price, delta, OI, and volume to help validate liquidity.

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
# Add your AI provider credentials to .env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
# Or switch to DeepSeek
# AI_PROVIDER=deepseek
# DEEP_SEEK_API_KEY=sk-your-deepseek-key

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
- `AI_PROVIDER` (`openai` default, set `deepseek` for DeepSeek) plus the matching API key (`OPENAI_API_KEY` or `DEEP_SEEK_API_KEY`)

Files:
- `src/cli/ai-agent.js`: AI agent CLI entry point.
- `src/strategy/indicators.js`: technical indicators calculation.
- `src/strategy/algorithms.js`: trading algorithms and signal detection.

## Web Dashboard 🖥️

User-friendly web interface for the AI trading agent with real-time recommendations and trade execution.

### Integrations at a Glance
- **E*TRADE API** – OAuth 1.0a connection powers account discovery, live balances, positions, and the emergency option exit workflow. Sensitive account numbers and balances render masked by default with an in-app reveal toggle, while the portfolio rail auto-syncs your default account at launch.
- **Financial Modeling Prep (FMP)** – Supplements recommendations with fundamentals (earnings calendar, float, sector stats) that enrich the AI prompt and side-rail insights.
- **AI Providers (OpenAI / DeepSeek)** – Generate narrative playbooks, confidence scoring, and risk commentary surfaced inside each recommendation card. Multiple providers can run per scan when `UI_AI_PROVIDERS` is defined.
- **Quote Providers** – Yahoo Finance remains the default intraday feed, with optional Stooq/IEX/Alpha Vantage fallbacks configured via environment settings.

### Features
- **Live Dashboard**: Real-time AI recommendations with strategy-specific layouts and confluence scoring
- **Trade Scanner**: One-click market scanning with a collapsible configuration panel and strategy selector (day trade vs swing trade)
- **Risk Monitoring**: Visual risk management with position sizing, buy/exit checklists, scaling plans, and enforced confluence/risk rules per card
- **Live Quote Overlay**: Each recommendation card surfaces the underlying’s latest price next to strike/expiry so you can instantly judge how far OTM the contract sits
- **Portfolio Overview**: Auto-synced portfolio rail with account summary tiles, option position cards, and masked sensitive fields
- **E*TRADE Integration**: Live portfolio data, balance polling, and one-click emergency exits
- **Strategy Playbooks**: Momentum, mean-reversion, and breakout diagnostics baked into every scan
- **Idea Tracker**: Pin any option suggestion as a floating tile so buy/wait/ignore cues stay visible even when the scan panel is hidden
- **Auto Exit (optional)**: When armed, the dashboard scales out of winners or fires emergency sells through the E*TRADE API based on live P&L thresholds
- **Cash Entry**: One-click market buys that prefer the AI-suggested contract count, but automatically size down to the max affordable quantity using withdrawable cash
- **Trade Execution**: Direct trade placement (future feature)

#### Tracking Option Ideas
- Click the **Track Idea** button in any recommendation card to pin it to the floating "Tracked Ideas" widget. The tile stores symbol, strike, expiry, entry/stop/target, and AI summary text.
- Tile colors mirror the verdict state: green = buy, amber = wait, red = ignore. Selecting the button again refreshes the tile with the most recent prices.
- The rail supports up to eight active ideas, persists locally via `localStorage`, and includes one-click removal or a `Clear` action to reset the list between sessions.

#### Automated Auto-Exit (Optional)
- Set `UI_AUTO_EXIT_ENABLED=true` to arm the watcher. With the dashboard open, the options rail monitors every refreshed E*TRADE position.
- When unrealized P&L meets `UI_AUTO_EXIT_TAKE_PROFIT_PCT` (default **+40%**), the watcher sells `UI_AUTO_EXIT_SCALE_PCT` of the remaining contracts (default **50%**) but never fewer than `UI_AUTO_EXIT_MIN_CONTRACTS`.
- If P&L falls below `UI_AUTO_EXIT_STOP_LOSS_PCT` (default **-35%**), an emergency sell liquidates the entire position via `/api/portfolio/.../emergency-sell`.
- `UI_AUTO_EXIT_COOLDOWN_MS` (default **300000 ms**) prevents repeated orders; failures drop to a 60s retry. Automation currently skips short positions.

#### Cash-Based Market Orders
- Every recommendation card includes a **Buy w/ Cash** button. It sends the AI’s preferred contract count to the server, which first attempts that exact size; if buying power is insufficient, it automatically falls back to `floor(withdrawCash / (entryPrice * 100))` and calls out the adjustment in the UI.
- If withdrawable cash cannot fund at least one contract, the UI blocks the submission and prompts you to refresh balances.
- Orders run through the same E*TRADE preview/place endpoints and refresh the portfolio rail after execution.

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
- **Header**: Account balance and daily profit target display (mask toggle supported)
- **Scan Controls**: Collapsible scan panel with symbol editor, strategy dropdown, insights rail, and manual scan trigger
- **Auto Portfolio Sync**: Preferred account loads automatically on first scan (configurable via `ETRADE_DEFAULT_ACCOUNT_KEY`) with manual refresh fallback
- **Account Summary**: Tile-based overview of cash, buying power, and account metadata
- **Option Positions**: Card-based layout with P&L, strikes, expiries, and emergency exit controls
- **Recommendations Grid**: Structured cards with verdict badges, provider grid, buy/exit checklists, scaling plan, enforced rules, and sparkline context
- **Stats & Insights**: Summary row plus left-rail insights to highlight provider coverage, signal mix, and risk flags

### "Scan for Trades" Flow
1. **Button Click** – Client posts to `POST /api/scan` with the active symbol list and strategy settings.
2. **Server Guard** – `src/ui/server.js` rejects duplicate in-flight scans, records the request, then invokes `ai-agent` with current environment configuration.
3. **Data Fetching** – Quotes from Yahoo (or configured provider) and FMP fundamentals are pulled, then merged with the stored playbook metadata for context.
4. **AI Synthesis** – `src/cli/ai-agent.js` composes the AI provider prompt, applies rule-based gates, and emits normalized recommendations (`decision`, `confidence`, `playbooks`, `risk` details).
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
- `AI_PROVIDER` (`openai` default, `deepseek` for DeepSeek) plus the corresponding key (`OPENAI_API_KEY` or `DEEP_SEEK_API_KEY`)
- `UI_AI_PROVIDERS`: Comma-separated provider list (e.g., `openai,deepseek`) to override auto-detection and run multiple analyses per scan
- `SCAN_SYMBOLS`: Symbols to analyze (default: SPY,QQQ,AAPL,TSLA,GOOGL,NVDA)
- `UI_AGENT_COMMAND`: Custom command to launch the AI agent (defaults to `npm run day-trade`). Placeholders `{{symbols}}`, `{{strategy}}`, and `{{expiryType}}` are dynamically substituted when present.
- Auto-exit tuning (optional):
  - `UI_AUTO_EXIT_ENABLED=true`
  - `UI_AUTO_EXIT_TAKE_PROFIT_PCT=40`
  - `UI_AUTO_EXIT_STOP_LOSS_PCT=-35`
  - `UI_AUTO_EXIT_SCALE_PCT=0.5`
  - `UI_AUTO_EXIT_MIN_CONTRACTS=1`
  - `UI_AUTO_EXIT_COOLDOWN_MS=300000`

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

## Optional: AI Enrichment (OpenAI / DeepSeek)

You can send each suggestion to your configured AI provider—OpenAI by default, or DeepSeek—to get a short review with decision, confidence, risk flags, and notes.

Setup:
- Add to `.env`: `AI_PROVIDER=openai` and `OPENAI_API_KEY=...` *(or* `AI_PROVIDER=deepseek` with `DEEP_SEEK_API_KEY=...` — default model `deepseek-chat`; override via `DEEP_SEEK_DEFAULT_MODEL` if you need `deepseek-r1` or other variants)*
- Optional envs: `USE_AI=true`, `AI_MODEL=gpt-4o-mini`, `AI_INTERVAL_SEC=60`

Run:
```
AI_PROVIDER=openai OPENAI_API_KEY=sk-... ACCOUNT_SIZE=25000 npm run suggest:stream -- --symbols SPY,QQQ,ES,NQ --provider mix --interval 30 --ai --ai-model gpt-4o-mini
# or with Grok
AI_PROVIDER=deepseek DEEP_SEEK_API_KEY=sk-... ACCOUNT_SIZE=25000 npm run suggest:stream -- --symbols SPY,QQQ --provider mix --interval 30 --ai --ai-provider deepseek
```

#### Sample Prompt (0DTE AAPL call example)

**System prompt**

```text
You are an AI options trading analyst. Blend deterministic technical rules with judgment to approve or reject trades.

Always follow this evaluation stack:
1. Review the provided strategy playbooks (momentum trend, mean reversion, breakout) and pick the single best-aligned lens. Justify with two short bullet reasons.
2. Stress-test risk: check spread quality, volume/liquidity notes, risk-per-contract, stop distance, and broader market context hints.
3. Deliver a binary decision (approve/caution/reject) with confidence calibrated 0.0-1.0. Default to caution if data conflicts.

Output strict JSON. Avoid markdown, prose paragraphs, or extra keys. Keep notes ≤200 chars.
```

**User prompt**

```text
Review the payload and reply with compact JSON:
{
   "decision": "approve|caution|reject",
   "confidence": 0-1,
   "selected_strategy": {"name": "...", "bias": "...", "score": 0-1, "rationale": ""},
   "risk_flags": [..],
   "notes": "<=200 chars",
   "strategy_type": "day_trade|swing_trade|hold",
   "adjustments": {"entry": number|null, "stop": number|null, "target": number|null}
}

Payload:
{"suggestion":{"symbol":"AAPL","direction":"long","side":"call","underlying_price":189.42,"contract":"AAPL 2025-11-15 190C","expiry":"2025-11-15","strike":190,"multiplier":100,"est_entry":2.45,"stop":1.7,"take_profit":3.8,"assumptions":{"iv":0.28,"r":0.015,"otm_pct":0.01,"min_business_days":0,"stop_loss_pct":0.3,"take_profit_mult":1.55,"expiry_type":"0dte"},"rationale":"0DTE CALL ~1% OTM with TP 1.55x and SL 30%","qty":2,"risk_per_contract":75,"risk_total":150,"delta":0.36,"oi":6120,"volume":8344,"entry_source":"etrade_live","option_source":"etrade_live","liquidity":{"spread":0.04,"spread_pct":1.6,"oi":6120,"volume":8344,"score":0.78},"tradePlan":{"qty":2,"stop":1.7,"iterations":[{"sellQty":1,"target":3.8,"note":"Scale half at target; shift stop to breakeven."},{"sellQty":1,"target":4.2,"note":"Let runner extend; trail stop below VWAP."}]}},"context":{"price":189.42,"source":"yahoo","indicators":{"rsi":64.1,"macd":{"macd":0.62,"signal":0.48,"histogram":0.14},"bbands":{"upper":190.8,"middle":188.6,"lower":186.4},"vwap":188.95,"volume":8200000,"avgVolume":7600000,"trend_bias":"bullish"},"option":{"contract":"AAPL 2025-11-15 190C","entry":2.45,"stop":1.7,"take_profit":3.8,"delta":0.36,"oi":6120,"volume":8344,"spread_pct":1.6,"target_delta":0.35,"source":"etrade_live"},"algorithmic":{"day_trade":{"strength":0.74,"signals":["bullish_vwap_break","macd_cross_up","volume_surge"],"caution_flags":["extended_from_vwap"]},"strategyInsights":{"primary":{"id":"momentum_trend","label":"Momentum Trend","bias":"bullish","score":0.82,"notes":"Price riding upper band with positive volume delta."},"ranked":[{"id":"momentum_trend","label":"Momentum Trend","bias":"bullish","score":0.82,"notes":"VWAP reclaim with MACD confirmation."},{"id":"breakout_retest","label":"Breakout Retest","bias":"bullish","score":0.71,"notes":"Holding above prior day high after retest."}]},"recommendedStrategy":{"id":"momentum_trend","label":"Momentum Trend","bias":"bullish","conviction":0.8},"optionTimeFrame":"0dte"},"strategy_playbook":{"primary":{"id":"momentum_trend","label":"Momentum Trend","bias":"bullish","score":0.82,"notes":"VWAP reclaim with stacked moving averages."},"ranked":[{"id":"momentum_trend","label":"Momentum Trend","bias":"bullish","score":0.82,"notes":"VWAP reclaim with stacked moving averages."},{"id":"breakout_retest","label":"Breakout Retest","bias":"bullish","score":0.71,"notes":"Holding above prior day high after retest."},{"id":"mean_reversion","label":"Mean Reversion","bias":"bearish","score":0.31,"notes":"Upper band tag with declining RSI momentum."}]}},"instructions":{"objective":"Validate the option plan using provided technical diagnostics and strategy playbooks.","required_keys":["decision","confidence","selected_strategy","risk_flags","notes","strategy_type","adjustments"],"adjustments_schema":{"entry":"null or float adjustment in dollars","stop":"null or float adjustment in dollars","target":"null or float adjustment in dollars"},"selected_strategy_schema":{"name":"one of momentum|mean_reversion|breakout","bias":"bullish|bearish|neutral","score":"0..1 absolute conviction","rationale":"≤120 chars summary"}}}
```

Files:
- `src/ai/client.js`: provider registry and selection helper.
- `src/ai/openai.js`: minimal client wrapper returning JSON.
- `src/ai/deepseek.js`: DeepSeek chat completion wrapper.
- `src/ai/prompt.js`: system/user prompts and schema.
- `src/runner/suggest-stream.js`: `--ai` flag wiring and output.
- `src/ui/server.js`: runs the agent against each provider listed in `UI_AI_PROVIDERS` and merges results for the dashboard.
