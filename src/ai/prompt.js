function buildSystemPrompt() {
  return `You are an AI options trading analyst. Blend deterministic technical rules with judgment to approve or reject trades.

Always follow this evaluation stack:
1. Review the strategy playbook summary and select the single best lens. Cite two terse bullet-style fragments referencing the supplied reasons.
2. Interpret the confluence metrics (reward_to_risk, spread_pct, volume_oi_ratio, delta_gap, signal_strength, playbook_alignment.score, time_to_expiry_days). Call out any metric outside healthy ranges (e.g. reward_to_risk < 1.2, spread_pct > 35 for day trades, volume_oi_ratio < 0.3, |delta_gap| > 0.15, insufficient expiry runway) and recommend targeted adjustments only when they materially improve the setup.
3. Stress-test risk budget, scaling plan, and liquidity before deferring to broader market context. Respect hard guardrails and flag any violations explicitly.
4. When context.supplemental_signals is present, incorporate its volatility (IV/ATR/relative volume), liquidity, price_levels, and risk snapshots to catch IV crush, thin markets, or proximity to key levels.
5. Deliver a decision (approve/caution/reject) with confidence calibrated 0.0-1.0. Default to caution if signals conflict or liquidity is suspect.

Output strict JSON. Avoid markdown, prose paragraphs, or extra keys. Keep notes 200 chars.`;
}

function buildUserPrompt({ suggestion, context }) {
  const payload = {
    suggestion,
    context,
    instructions: {
      objective: 'Validate the option plan using provided technical diagnostics and strategy playbooks.',
      required_keys: ['decision', 'confidence', 'selected_strategy', 'risk_flags', 'notes', 'strategy_type', 'adjustments'],
      adjustments_schema: {
        entry: 'null or float adjustment in dollars',
        stop: 'null or float adjustment in dollars',
        target: 'null or float adjustment in dollars'
      },
      selected_strategy_schema: {
        name: 'one of momentum|mean_reversion|breakout',
        bias: 'bullish|bearish|neutral',
        score: '0..1 absolute conviction',
        rationale: 'â‰¤120 chars summary'
      },
      confluence_guidance: {
        reward_to_risk: 'Prefer >= 1.5. Flag if < 1.0 or tightening stops could lift ratio.',
        spread_pct: 'Day trades need <= 35%, swing trades <= 45%.',
        volume_oi_ratio: 'Healthy >= 0.30. Warn if < 0.15.',
        delta_gap: 'Aim for |delta_gap| <= 0.15. Large gaps imply wrong strike.',
        time_to_expiry_days: 'Swing plans need at least ~3 trading days unless 0DTE explicitly chosen.'
      },
      supplemental_signals: 'context.supplemental_signals (volatility, liquidity, price_levels, risk) highlights IV context, liquidity stress, proximity to support/resistance, and risk budget usage. Reference these when justifying the decision.'
    }
  };

  return `Review the payload and reply with compact JSON:
{
  "decision": "approve|caution|reject",
  "confidence": 0-1,
  "selected_strategy": {"name": "...", "bias": "...", "score": 0-1, "rationale": ""},
  "risk_flags": [..],
  "notes": "<=200 chars",
  "strategy_type": "day_trade|swing_trade|hold",
  "adjustments": {"entry": number|null, "stop": number|null, "target": number|null}
}

Payload:\n${JSON.stringify(payload, null, 2)}`;
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
};



