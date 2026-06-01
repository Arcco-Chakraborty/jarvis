// Shared Gemini caller with round-robin API-key rotation (ported from
// SUTT_ML_TASK services/gemini.py). A module-global index spreads load across
// keys; each call retries with the next key on any non-OK/throw and returns the
// parsed response data, or null once all keys are exhausted. Never throws.
import { config } from '../config.js';

let _i = 0;

export function nextKey(keys) {
  const key = keys[_i % keys.length];
  _i += 1;
  return key;
}

export async function callGemini({
  model,
  body,
  timeoutMs = 8000,
  fetchFn = globalThis.fetch,
  keys = config.geminiApiKeys,
} = {}) {
  if (!keys || keys.length === 0) return null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = nextKey(keys);
    try {
      const res = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) continue;
      return await res.json();
    } catch {
      continue;
    }
  }
  return null;
}
