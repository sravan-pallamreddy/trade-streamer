function computeQty({ accountSize, riskPct = 0.01, entry, stop, multiplier = 100, maxContracts = 100, strategy = 'default' }) {
  const perContractRisk = Math.max(0, (entry - stop)) * multiplier;
  if (perContractRisk <= 0) return { qty: 0, perContractRisk: 0, totalRisk: 0 };

  // Adjust risk percentage based on strategy
  let adjustedRiskPct = riskPct;
  let adjustedMaxContracts = maxContracts;

  switch (strategy) {
    case 'day_trade':
      // Day trading: tighter risk control, smaller positions (capped at 1% unless user opts lower)
      adjustedRiskPct = Math.min(riskPct, 0.01); // Max 1% per trade
      adjustedMaxContracts = Math.min(maxContracts, 5); // Smaller max positions
      break;
    case 'swing_trade':
      // Swing trading: can take more risk per trade since holding longer
      adjustedRiskPct = Math.min(riskPct * 1.5, 0.02); // Up to 2% per trade
      adjustedMaxContracts = Math.min(maxContracts, 10); // Medium positions
      break;
    case 'scalping':
      // Very short-term: minimal risk per trade
      adjustedRiskPct = Math.min(riskPct, 0.002); // Max 0.2% per trade
      adjustedMaxContracts = Math.min(maxContracts, 2); // Very small positions
      break;
  }

  const riskBudget = accountSize * adjustedRiskPct;
  let qty = Math.floor(riskBudget / perContractRisk);
  if (!isFinite(qty) || qty < 0) qty = 0;
  qty = Math.min(qty, adjustedMaxContracts);

  return {
    qty,
    perContractRisk,
    totalRisk: qty * perContractRisk,
    adjustedRiskPct,
    riskBudget,
    strategy
  };
}

function getRiskProfile(strategy = 'default') {
  const profiles = {
    day_trade: {
      maxRiskPerTrade: 0.005, // 0.5%
      maxContracts: 5,
      recommendedStopLoss: 0.3, // 30% of premium
      recommendedTakeProfit: 1.5, // 1.5x premium
      holdingPeriod: 'intraday'
    },
    swing_trade: {
      maxRiskPerTrade: 0.015, // 1.5%
      maxContracts: 10,
      recommendedStopLoss: 0.5, // 50% of premium
      recommendedTakeProfit: 2.0, // 2x premium
      holdingPeriod: '1-5 days'
    },
    scalping: {
      maxRiskPerTrade: 0.002, // 0.2%
      maxContracts: 2,
      recommendedStopLoss: 0.2, // 20% of premium
      recommendedTakeProfit: 1.2, // 1.2x premium
      holdingPeriod: 'minutes'
    },
    default: {
      maxRiskPerTrade: 0.01, // 1%
      maxContracts: 100,
      recommendedStopLoss: 0.5,
      recommendedTakeProfit: 2.0,
      holdingPeriod: 'flexible'
    }
  };

  return profiles[strategy] || profiles.default;
}

function validateRiskParameters({ accountSize, riskPct, entry, stop, strategy }) {
  const profile = getRiskProfile(strategy);
  const warnings = [];

  if (riskPct > profile.maxRiskPerTrade) {
    warnings.push(`Risk per trade (${(riskPct * 100).toFixed(1)}%) exceeds recommended maximum (${(profile.maxRiskPerTrade * 100).toFixed(1)}%) for ${strategy}`);
  }

  const perContractRisk = Math.max(0, (entry - stop)) * 100; // Assuming 100 multiplier
  const totalRisk = (accountSize * riskPct);

  if (perContractRisk > totalRisk * 0.1) { // Risk more than 10% of total risk budget
    warnings.push('Stop loss is too wide for the risk budget');
  }

  return { valid: warnings.length === 0, warnings, profile };
}

module.exports = {
  computeQty,
  getRiskProfile,
  validateRiskParameters,
};

