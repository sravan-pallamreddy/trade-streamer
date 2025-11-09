#!/usr/bin/env node
// Simple web UI for trading dashboard
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

console.log('Starting Trading Dashboard server...');

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

let etradeModule;
const app = express();
const PORT = process.env.UI_PORT || 3001;
console.log(`Using port: ${PORT}`);

// Store latest AI results
let latestResults = null;
let isScanning = false;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load E*TRADE module
try {
  etradeModule = require('../providers/etrade');
  console.log('E*TRADE module loaded successfully');
} catch (error) {
  console.error('Failed to load E*TRADE module:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
}

const { getAccounts, getPortfolio, getAccountBalance } = etradeModule;

// API endpoints
app.get('/api/recommendations', (req, res) => {
  res.json({
    results: latestResults,
    isScanning,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/scan', async (req, res) => {
  if (isScanning) {
    return res.status(409).json({ error: 'Scan already in progress' });
  }

  isScanning = true;
  try {
    console.log('Starting AI scan...');
    const { stdout, stderr } = await execAsync('npm run ai-agent', {
      cwd: path.join(__dirname, '..'),
      timeout: 60000 // 1 minute timeout
    });

    // Parse the output (this is a simple implementation)
    // In a real app, you'd modify ai-agent.js to return structured data
    latestResults = {
      rawOutput: stdout,
      timestamp: new Date().toISOString(),
      parsed: parseAIOutput(stdout)
    };

    res.json({ success: true, results: latestResults });
  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    isScanning = false;
  }
});

// Portfolio endpoints
app.get('/api/portfolio/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Portfolio accounts error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/:accountIdKey', async (req, res) => {
  try {
    const { accountIdKey } = req.params;
    const view = req.query.view || 'QUICK';

    // Get all accounts to find the numeric accountId from accountIdKey
    const accounts = await getAccounts();
    const account = accounts.find(acc => acc.accountIdKey === accountIdKey);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Use the accountIdKey for portfolio calls (E*TRADE API expects this format)
    const portfolio = await getPortfolio(accountIdKey, { view });
    res.json({ success: true, portfolio });
  } catch (error) {
    console.error('Portfolio error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/:accountIdKey/balance', async (req, res) => {
  try {
    const { accountIdKey } = req.params;

    // Get all accounts to find the numeric accountId from accountIdKey
    const accounts = await getAccounts();
    const account = accounts.find(acc => acc.accountIdKey === accountIdKey);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Use the accountIdKey for balance calls (this was working before)
    const balance = await getAccountBalance(accountIdKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

function parseAIOutput(output) {
  // Simple parser for AI agent output
  const lines = output.split('\n');
  const recommendations = [];
  let currentRec = null;

  console.log('Parsing AI output, lines:', lines.length);

  for (const line of lines) {
    console.log('Processing line:', JSON.stringify(line));
    if (line.includes('🔍 Analyzing')) {
      if (currentRec) recommendations.push(currentRec);
      // Extract symbol from "🔍 Analyzing SPY..." format
      const symbolMatch = line.match(/🔍 Analyzing (\w+)/);
      const symbol = symbolMatch ? symbolMatch[1] : 'unknown';
      console.log('Found symbol:', symbol, 'from line:', line);
      currentRec = { symbol, signals: [], ai: {} };
    } else if (line.includes('📋 Signals:')) {
      if (currentRec) {
        const signalsText = line.split('📋 Signals:')[1]?.trim() || 'none';
        currentRec.signals = signalsText === 'none' ? [] : signalsText.split(', ');
        console.log('Found signals:', currentRec.signals);
      }
    } else if (line.includes('🎯 DAY_TRADE Analysis:')) {
      if (currentRec) {
        // Extract strength percentage
        const strengthMatch = line.match(/Strength (-?\d+)%/);
        if (strengthMatch) {
          currentRec.ai.strength = parseInt(strengthMatch[1]);
          currentRec.ai.decision = currentRec.ai.strength > 50 ? 'approve' : currentRec.ai.strength > 25 ? 'caution' : 'reject';
          currentRec.ai.confidence = Math.abs(currentRec.ai.strength) > 75 ? 'High' : Math.abs(currentRec.ai.strength) > 50 ? 'Medium' : 'Low';
          console.log('Found strength:', currentRec.ai.strength, 'decision:', currentRec.ai.decision);
        }
      }
    }
  }

  if (currentRec) recommendations.push(currentRec);
  console.log('Final recommendations:', recommendations.length);
  return recommendations;
}

// Serve the main dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
console.log(`Attempting to start server on port ${PORT}...`);
app.listen(PORT, () => {
  console.log(`Trading Dashboard running at http://localhost:${PORT}`);
  console.log(`Open your browser to view AI recommendations and execute trades`);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

// module.exports = app;