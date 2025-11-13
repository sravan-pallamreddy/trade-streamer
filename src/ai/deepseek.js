require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'deepseek';
const DEFAULT_MODEL = process.env.DEEP_SEEK_DEFAULT_MODEL || 'deepseek-chat';

function ensureKeyLoaded() {
  if (process.env.DEEP_SEEK_API_KEY) return;
  const fileFromEnv = process.env.DEEP_SEEK_API_KEY_FILE;
  const candidates = [
    fileFromEnv,
    path.resolve(process.cwd(), 'deepseek.key'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8').trim();
      if (!raw) continue;
      const match = raw.match(/DEEP_SEEK_API_KEY\s*=\s*(.+)/i);
      const val = match ? match[1].trim() : raw;
      if (val) {
        process.env.DEEP_SEEK_API_KEY = val;
        break;
      }
    } catch {
      // ignore file access issues
    }
  }
}

function requireKey() {
  ensureKeyLoaded();
  const key = process.env.DEEP_SEEK_API_KEY;
  if (!key) throw new Error('Missing DEEP_SEEK_API_KEY');
  return key;
}

function baseUrl() {
  return process.env.DEEP_SEEK_BASE_URL || 'https://api.deepseek.com';
}

async function chatJson({ model = DEFAULT_MODEL, system, user, timeout_ms = 10000 }) {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
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
      const error = new Error(`DeepSeek HTTP ${res.status}: ${text}`);
      error.status = res.status;
      error.body = text;
      error.model = model;
      throw error;
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
