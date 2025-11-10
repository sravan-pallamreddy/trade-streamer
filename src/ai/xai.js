require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'xai';
const DEFAULT_MODEL = process.env.XAI_DEFAULT_MODEL || 'grok-beta';

function ensureKeyLoaded() {
  if (process.env.XAI_API_KEY) return;
  const fileFromEnv = process.env.XAI_API_KEY_FILE;
  const candidates = [
    fileFromEnv,
    path.resolve(process.cwd(), 'xai.key'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw) continue;
        const match = raw.match(/XAI_API_KEY\s*=\s*(.+)/i);
        const val = match ? match[1].trim() : raw;
        if (val) {
          process.env.XAI_API_KEY = val;
          break;
        }
      }
    } catch {}
  }
}

function requireKey() {
  ensureKeyLoaded();
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('Missing XAI_API_KEY');
  return key;
}

function baseUrl() {
  return process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
}

async function chatJson({ model = DEFAULT_MODEL, system, user, timeout_ms = 10000 }) {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user },
        ].filter(Boolean),
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`xAI HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    try {
      return JSON.parse(content);
    } catch {
      return { raw: content };
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PROVIDER_ID,
  DEFAULT_MODEL,
  chatJson,
};
