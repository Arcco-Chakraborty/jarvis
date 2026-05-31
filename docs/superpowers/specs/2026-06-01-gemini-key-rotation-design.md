# Gemini API Key Rotation (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `gemini-key-rotation`

## Motivation

JARVIS now makes Gemini calls from two places — `intent/gemini.js` (intent classification) and `intent/knowledge.js` (knowledge answers) — each using a single `GEMINI_API_KEY`. The `.env` already carries `GEMINI_API_KEYS=key1,key2,key3,key4` for a deferred rotation system. Port the round-robin key rotation from the user's `SUTT_ML_TASK` repo (`services/gemini.py`) so a rate-limited or failing key automatically rolls over to the next one.

**Reference pattern (`services/gemini.py`):** `GEMINI_API_KEYS` is a comma-separated list; a module-global index hands keys out round-robin via `next_key()`; each call loops `len(KEYS)` times, retrying with the next key on any non-OK/exception, and fails only after all keys are exhausted.

**Adaptation:** their Python `raise`s a `RuntimeError` when keys are exhausted; JARVIS's convention is to **return `null`/a graceful fallback** so the voice loop never crashes. We keep that convention.

## Architecture

One new shared client both callers route through; the callers keep their distinct request bodies and response handling.

### `orchestrator/intent/gemini-client.js` (new)
- Module-global rotation index. `nextKey(keys)` → `keys[i++ % keys.length]` (round-robin, shared across all callers so load spreads).
- **`callGemini({ model, body, timeoutMs = 8000, fetchFn = globalThis.fetch, keys = config.geminiApiKeys })`**:
  - If `keys` is empty → return `null` (no fetch).
  - Loop up to `keys.length` times: `key = nextKey(keys)`; `POST` `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=<key>` with `body` (JSON) and an `AbortSignal.timeout(timeoutMs)`. On `!res.ok` → continue (rotate). On a thrown error → continue (rotate). On success → return the parsed response **`data`** object.
  - After the loop (all keys failed) → return `null`. Never throws.
- Returns the raw `data` so each caller extracts `candidates?.[0]?.content?.parts?.[0]?.text` itself (gemini.js parses it as JSON; knowledge.js takes it as plain text).

### `orchestrator/config.js` (modify)
- Add `geminiApiKeys`: parse `process.env.GEMINI_API_KEYS` (split on `,`, trim, drop empties). If the result is empty, fall back to `[geminiApiKey]` filtered to non-empty — so a lone `GEMINI_API_KEY` still works and an entirely-unset config yields `[]`.

### `orchestrator/intent/gemini.js` (modify)
- `geminiClassify(text, vocab, { keys, apiKey, fetchFn, model = 'gemini-2.5-flash', timeoutMs = 8000 } = {})`:
  - Resolve the key list: `const keyList = keys ?? (apiKey ? [apiKey] : config.geminiApiKeys);` (keeps the existing `apiKey:'x'` test injection working as a single-key list).
  - Build the same body as today (`contents`, `generationConfig` with `temperature: 0.1`, `responseMimeType: 'application/json'`).
  - `const data = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });`
  - If `!data` → `null`. Else extract text, `JSON.parse`, `validate(...)` exactly as today (returns intent or `null`). `buildPrompt`/`validate` are unchanged.

### `orchestrator/intent/knowledge.js` (modify)
- `makeKnowledge({ keys, apiKey, fetchFn, model = 'gemini-2.5-flash', timeoutMs = 9000 } = {})`:
  - Resolve `keyList` the same way. If empty → `answer()` returns the OFFLINE line.
  - `answer(query)`: build the same persona body, `const data = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });` If `!data` → FAILED fallback line (`ok:true`). Else extract text → `{ ok:true, speak: text.trim() }`. Persona strings unchanged.

### Models
Keep JARVIS's current `gemini-2.5-flash` for both (do **not** adopt the reference repo's `flash-lite`).

## Error handling
- `callGemini` rotates on non-OK/throw, returns `null` when exhausted — never throws.
- `gemini.js` → `null` on failure (orchestrator falls through to "Sorry, I didn't catch that.").
- `knowledge.js` → in-character fallback (`ok:true`, spoken), as today.
- Rotation is best-effort and stateless beyond the shared index; no per-key health tracking (YAGNI — matches the reference).

## Testing
- **`gemini-client.test.js`:** round-robin (`nextKey` cycles through keys in order, wrapping); retry (key #1 → `{ok:false,503}`, key #2 → `200` ⇒ returns data, and the failing key was tried first); all keys fail → `null`; empty keys → `null` and fetch **not** called; a thrown fetch on one key rotates to the next. Inject `keys` + `fetchFn`.
- **`gemini.test.js`:** existing single-key (`apiKey:'x'`) tests stay green; add a 2-key test where the first key 503s and the second returns a valid intent JSON ⇒ validated intent.
- **`knowledge.test.js`:** existing tests stay green; add a 2-key test where the first key throws and the second returns the answer text.
- **`orchestrator/config.test.js`:** if `config` exposes a pure parser for the key list, test `"a, b ,c"` → `['a','b','c']`, `GEMINI_API_KEYS` unset + `GEMINI_API_KEY='solo'` → `['solo']`, both unset → `[]`. If `config.js` reads `process.env` only at import time (no injectable parser), add a tiny exported `parseGeminiKeys(env)` helper and test that instead.

## Verification (on the box)
With multiple keys in `.env`, knowledge answers and intent fallback keep working; if one key is rate-limited (429), the call transparently rolls to the next. (Hard to force live; the unit retry tests prove the behavior.)
