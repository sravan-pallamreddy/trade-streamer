require('dotenv').config();

const openai = require('./openai');
const deepseek = require('./deepseek');

const registry = {};
for (const mod of [openai, deepseek]) {
  if (!mod || !mod.PROVIDER_ID) continue;
  const id = String(mod.PROVIDER_ID).toLowerCase();
  registry[id] = mod;
}

let defaultProvider = 'openai';
if (!registry[defaultProvider]) {
  const keys = Object.keys(registry);
  if (keys.length) {
    defaultProvider = keys[0];
  }
}

const DEFAULT_PROVIDER = defaultProvider;
const ALIASES = {
  deepseek: 'deepseek',
  'deep-seek': 'deepseek',
  ds: 'deepseek',
  xai: 'deepseek', // legacy flag
  grok: 'deepseek',
  'grok-beta': 'deepseek',
  'grok-1': 'deepseek',
  'grok-3': 'deepseek',
  'x.ai': 'deepseek',
  x: 'deepseek',
};

function resolveProviderId(preferred) {
  const raw = typeof preferred === 'string' ? preferred.trim().toLowerCase() : '';
  if (raw) {
    if (registry[raw]) return raw;
    const alias = ALIASES[raw];
    if (alias && registry[alias]) return alias;
  }
  return registry[DEFAULT_PROVIDER] ? DEFAULT_PROVIDER : Object.keys(registry)[0];
}

function getClient(preferred) {
  const envFallback = process.env.AI_PROVIDER;
  const id = resolveProviderId(preferred || envFallback);
  const mod = registry[id];
  if (!mod) {
    throw new Error('No AI providers registered.');
  }
  return {
    name: id,
    chatJson: mod.chatJson,
    defaultModel: mod.DEFAULT_MODEL,
  };
}

function listProviders() {
  return Object.keys(registry);
}

module.exports = {
  DEFAULT_PROVIDER,
  getClient,
  listProviders,
};
