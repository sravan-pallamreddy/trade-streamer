# Trade Streamer Strategy Overview

This note explains the layered approach Trade Streamer uses so other traders can understand what happens before an option idea appears in the UI.

## 1. Playbook Selection

- `day_trade`: 0DTE focus, faster cadence, momentum‑driven signals. The AI prompt emphasizes intraday RSI/MACD alignment, VWAP control, tape strength, and stop discipline.
- `swing_trade`: Weekly expirations, broader trend context, tolerance for overnight risk.
- Strategy choice flows from `TRADING_STRATEGY` (CLI) or the dashboard selector; each scan embeds the corresponding rules into the AI prompt.

## 2. Gatekeeping Rules

Before an idea hits the AI, it must pass numeric gates defined in `src/rules/gates.js`:

| Gate | Purpose |
| --- | --- |
| Fast vs. slow SMA alignment | Confirms short-term momentum agrees with the dominant trend. |
| VWAP check | Avoids chasing when price is extended under/over VWAP (optional). |
| Relative volume | Filters out sleepy tape; default min RVOL 1.2+. |
| Futures confirmation | When enabled, checks ES/NQ direction for beta names. |

Ideas that fail a gate are either dropped or pre‑tagged “caution” so the AI focuses on higher-quality tape.

## 3. Technical Context Sent to AI

For each surviving symbol, the scanner feeds the model:

- Latest OHLC data plus RSI(14), MACD(12‑26‑9), Bollinger posture, VWAP distance, and volume metrics.
- Support/resistance snippets, float/sector info, and headline risk markers.
- Recent option liquidity stats (spread %, OI, IV snapshot).

The AI returns a normalized record with decision, confidence, buy/exit checklist, scaling plan, and risk flags. Multiple providers (OpenAI + DeepSeek) can run per scan; the UI merges them into a comparison grid.

## 4. Option Contract Selection

`src/strategy/options.js` chooses the contract once a symbol is approved:

- Default target: ~1% OTM, nearest expiry (0DTE for day trade, weekly for swing).
- Falls back to delta or premium targeting if the default strike is illiquid.
- Rejects contracts with wide spreads, thin OI, or missing quotes.

Position size derives from `RISK_PCT`: risk per trade = account size × `RISK_PCT`, converted into contract count using the stop level and premium.

## 5. Risk Framework in Every Card

Each recommendation includes:

- Verdict badge (approve/caution/reject) + confluence score.
- Provider grid showing entry/stop/target and confidence from each AI provider.
- Buy conditions (e.g., “RSI reclaim 55 and hold above VWAP”) and exit rules (stop, time stop, scaling plan).
- Hard rules: auto‑downgrade to caution if confluence < 70, reject if reward/risk < 2.5, flag wide spreads, etc.

## 6. Execution Safeguards

- **Tracked Ideas**: Pin an approved setup; tiles persist in `localStorage` and update when you re‑scan.
- **Auto Exit** (optional): Enable with `UI_AUTO_EXIT_ENABLED=true`. The dashboard watches live positions and:
  - Trims (`UI_AUTO_EXIT_TAKE_PROFIT_PCT`, default +40%) by selling `UI_AUTO_EXIT_SCALE_PCT` (default 50%).
  - Fires an emergency sell if P&L < `UI_AUTO_EXIT_STOP_LOSS_PCT` (default ‑35%).
- **Buy w/ Cash**: A button on each card sizes a market `BUY_OPEN` using the broker’s “cash available to withdraw” (no margin). Quantity = floor(withdrawable cash / (entry price × 100)).
- **Cash + Withdraw Display**: Header shows total balance, cash available, and cash you can withdraw so you know liquidity before ordering.

## 7. Suggested Workflow

1. Set `.env` values (account size, symbols, strategy) and start the dashboard (`npm run ui`).
2. Run a scan (or use auto‑polling). Review summary stats and individual cards.
3. Pin interesting ideas; wait for confluence score ≥ 70 and clean signals.
4. Use **Buy w/ Cash** if you want the platform to size a market order automatically based on withdrawable cash; otherwise, trade manually per the plan.
5. Let the auto‑exit watcher handle stop/scale automation, or place your own exits.
6. Rerun scans as conditions change; tracked tiles plus the portfolio rail keep everything visible in one screen.

Sharing this document with other traders should clarify that signals aren’t random—they reflect a layered process combining rule-based filters, AI analysis, disciplined option selection, and automated risk management.
