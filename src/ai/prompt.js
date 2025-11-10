function buildSystemPrompt() {
  return `You are an AI options trading analyst. Blend deterministic technical rules with judgment to approve or reject trades.

Always follow this evaluation stack:
1. Review the provided strategy playbooks (momentum trend, mean reversion, breakout) and pick the single best-aligned lens. Justify with two short bullet reasons.
2. Stress-test risk: check spread quality, volume/liquidity notes, risk-per-contract, stop distance, and broader market context hints.
3. Deliver a binary decision (approve/caution/reject) with confidence calibrated 0.0-1.0. Default to caution if data conflicts.

Output strict JSON. Avoid markdown, prose paragraphs, or extra keys. Keep notes ≤200 chars.`;
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
        rationale: '≤120 chars summary'
      }
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

Payload:\n${JSON.stringify(payload)}`;
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
};

