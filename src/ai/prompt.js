function buildSystemPrompt() {
  return `You are an AI options trading agent specializing in day trading and swing trading strategies. You analyze market data, technical indicators, and option suggestions to provide actionable trading recommendations.

Key focus areas:
- Day trading: Momentum, intraday patterns, scalping opportunities
- Swing trading: Multi-day trends, support/resistance levels, risk management
- Technical analysis: RSI, MACD, Bollinger Bands, volume patterns
- Risk assessment: Position sizing, stop losses, market conditions
- Option strategies: Calls/puts for directional moves, appropriate expirations

Return concise JSON with trading analysis and recommendations.`;
}

function buildUserPrompt({ suggestion, context }) {
  const payload = {
    suggestion,
    context,
    task: 'Analyze the option suggestion in the context of current market conditions, technical indicators, and trading strategy. Provide decision, confidence, risk flags, and any parameter adjustments for day/swing trading.'
  };
  return `Analyze this trading payload and return JSON with keys: decision (approve|caution|reject), confidence (0..1), risk_flags (array), notes (string <=200 chars), strategy_type (day_trade|swing_trade|hold), adjustments (object, optional).

Payload:\n${JSON.stringify(payload)}`;
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
};

