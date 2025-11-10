// Load .env by default; allow fallback to a custom file (e.g., 'en')
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';

function ensureKeyLoaded() {
  if (process.env.OPENAI_API_KEY) return;
  // Optional explicit file path via env
  const fileFromEnv = process.env.OPENAI_API_KEY_FILE;
  const candidates = [
    fileFromEnv,
    path.resolve(process.cwd(), 'en'), // user-requested fallback filename
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw) continue;
        // Accept either a bare key or KEY=VALUE format
        const m = raw.match(/OPENAI_API_KEY\s*=\s*(.+)/i);
        const val = m ? m[1].trim() : raw;
        if (val) {
          process.env.OPENAI_API_KEY = val;
          break;
        }
      }
    } catch {}
  }
}

function requireKey() {
  ensureKeyLoaded();
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('Missing OPENAI_API_KEY');
  return k;
}

function baseUrl() {
  return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
}

async function chatJson({ model = DEFAULT_MODEL, system, user, timeout_ms = 10000 }) {
  const key = requireKey();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user },
        ].filter(Boolean),
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
  throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    try {
      return JSON.parse(content);
    } catch {
      return { raw: content };
    }
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  PROVIDER_ID,
  chatJson,
  DEFAULT_MODEL,
};
