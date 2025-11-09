// Data quality validation utilities
const { getQuotes } = require('../providers/quotes');

async function validateDataConsistency(symbols, options = {}) {
  const results = {};
  const providers = ['yahoo', 'stooq'];

  for (const symbol of symbols) {
    results[symbol] = {};
    const prices = {};

    // Fetch from multiple providers
    for (const provider of providers) {
      try {
        const quotes = await getQuotes([symbol], { provider, debug: false });
        if (quotes[symbol]) {
          prices[provider] = quotes[symbol].price;
          results[symbol][provider] = {
            price: quotes[symbol].price,
            timestamp: quotes[symbol].ts,
            source: quotes[symbol].source
          };
        }
      } catch (e) {
        results[symbol][provider] = { error: e.message };
      }
    }

    // Calculate consistency metrics
    const validPrices = Object.values(prices).filter(p => typeof p === 'number');
    if (validPrices.length > 1) {
      const avg = validPrices.reduce((a, b) => a + b, 0) / validPrices.length;
      const variance = validPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / validPrices.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / avg; // Coefficient of variation

      results[symbol].consistency = {
        average: avg.toFixed(2),
        stdDev: stdDev.toFixed(4),
        coefficientOfVariation: (cv * 100).toFixed(2) + '%',
        quality: cv < 0.001 ? 'excellent' : cv < 0.005 ? 'good' : cv < 0.01 ? 'fair' : 'poor'
      };
    }
  }

  return results;
}

function generateDataQualityReport(validationResults) {
  console.log('\n📊 Data Quality Report');
  console.log('======================');

  for (const [symbol, data] of Object.entries(validationResults)) {
    console.log(`\n${symbol}:`);
    const providers = Object.keys(data).filter(k => k !== 'consistency');

    for (const provider of providers) {
      const info = data[provider];
      if (info.error) {
        console.log(`  ❌ ${provider}: Error - ${info.error}`);
      } else {
        console.log(`  ✅ ${provider}: $${info.price} (${new Date(info.timestamp).toLocaleTimeString()})`);
      }
    }

    if (data.consistency) {
      const c = data.consistency;
      console.log(`  📈 Consistency: ${c.quality.toUpperCase()} (CV: ${c.coefficientOfVariation})`);
    }
  }

  console.log('\n💡 Quality Guidelines:');
  console.log('  CV < 0.1%: Excellent (prices match closely)');
  console.log('  CV < 0.5%: Good (minor differences)');
  console.log('  CV < 1.0%: Fair (acceptable for analysis)');
  console.log('  CV > 1.0%: Poor (consider alternative data sources)');
}

module.exports = {
  validateDataConsistency,
  generateDataQualityReport
};