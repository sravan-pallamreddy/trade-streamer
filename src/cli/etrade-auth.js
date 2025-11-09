#!/usr/bin/env node
// Simple OAuth 1.0a helper for E*TRADE (sandbox or live)
require('dotenv').config();
const readline = require('node:readline');
const { buildOAuthHeader, buildOAuthParts } = require('../providers/oauth1');

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v;
}

function baseUrl() {
  return env('ETRADE_BASE_URL', 'https://apisb.etrade.com');
}

function parseForm(body) {
  const out = {};
  for (const kv of String(body).split('&')) {
    const [k, v] = kv.split('=');
    if (!k) continue;
    out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return out;
}

function parseArgs(argv) {
  const args = { debug: !!process.env.DEBUG_OAUTH, callback: process.env.ETRADE_CALLBACK };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--debug') { args.debug = true; continue; }
    if (a[i] === '--callback' && a[i + 1]) { args.callback = a[++i]; continue; }
  }
  return args;
}

async function requestToken({ debug, callback }) {
  const consumerKey = process.env.ETRADE_CONSUMER_KEY;
  const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) throw new Error('Set ETRADE_CONSUMER_KEY and ETRADE_CONSUMER_SECRET in .env');

  const url = `${baseUrl()}/oauth/request_token`;
  const oauth_callback = callback || env('ETRADE_CALLBACK', 'oob');
  // E*TRADE expects oauth_callback in the Authorization header (not query)
  const method = 'POST';
  const parts = buildOAuthParts({ method, url, consumerKey, consumerSecret, extra: { oauth_callback } });
  if (debug) {
    console.log('request_token baseString:', parts.baseString);
    console.log('request_token header:', parts.header);
  }
  const res = await fetch(url, { method, headers: { Authorization: parts.header, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  const txt = await res.text();
  if (!res.ok) throw new Error(`request_token HTTP ${res.status}: ${txt}`);
  const obj = parseForm(txt);
  if (!obj.oauth_token || !obj.oauth_token_secret) throw new Error(`Unexpected response: ${txt}`);
  return obj; // {oauth_token, oauth_token_secret, oauth_callback_confirmed}
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function accessToken({ oauth_token, oauth_token_secret, verifier, debug }) {
  const consumerKey = process.env.ETRADE_CONSUMER_KEY;
  const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
  const url = `${baseUrl()}/oauth/access_token`;
  // E*TRADE expects oauth_verifier in the Authorization header
  const method = 'POST';
  const parts = buildOAuthParts({ method, url, consumerKey, consumerSecret, token: oauth_token, tokenSecret: oauth_token_secret, extra: { oauth_verifier: verifier } });
  if (debug) {
    console.log('access_token baseString:', parts.baseString);
    console.log('access_token header:', parts.header);
  }
  const res = await fetch(url, { method, headers: { Authorization: parts.header, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  const txt = await res.text();
  if (!res.ok) throw new Error(`access_token HTTP ${res.status}: ${txt}`);
  const obj = parseForm(txt);
  if (!obj.oauth_token || !obj.oauth_token_secret) throw new Error(`Unexpected response: ${txt}`);
  return obj; // access token + secret
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`E*TRADE OAuth helper (base=${baseUrl()})`);
  const req = await requestToken({ debug: args.debug, callback: args.callback });
  const authorizeUrl = `https://us.etrade.com/e/t/etws/authorize?key=${encodeURIComponent(process.env.ETRADE_CONSUMER_KEY)}&token=${encodeURIComponent(req.oauth_token)}`;
  console.log('\n1) Open this URL in your browser (sandbox login):');
  console.log(authorizeUrl);
  console.log('\n2) After authorizing, you will receive a verification code (PIN).');
  const pin = await ask('\nEnter verification code (PIN): ');
  const acc = await accessToken({ oauth_token: req.oauth_token, oauth_token_secret: req.oauth_token_secret, verifier: pin, debug: args.debug });
  console.log('\nSuccess! Add these to your .env:');
  console.log(`ETRADE_ACCESS_TOKEN=${acc.oauth_token}`);
  console.log(`ETRADE_ACCESS_TOKEN_SECRET=${acc.oauth_token_secret}`);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
