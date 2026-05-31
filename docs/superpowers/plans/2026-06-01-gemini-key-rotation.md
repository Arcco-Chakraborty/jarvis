# Gemini Key Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port SUTT_ML_TASK's round-robin Gemini key rotation into JARVIS so both Gemini call sites cycle through `GEMINI_API_KEYS` and retry on failure.

**Architecture:** A new shared `intent/gemini-client.js` (`callGemini` + `nextKey`) does the rotation/retry and returns the response `data` or `null`. `config.js` parses the key list. `intent/gemini.js` and `intent/knowledge.js` route through `callGemini`, keeping their own bodies + response handling.

**Tech Stack:** Node ESM, `node:test`, injected `fetchFn`/`keys` (no real API in tests).

**Spec:** `docs/superpowers/specs/2026-06-01-gemini-key-rotation-design.md`
**Branch:** `gemini-key-rotation` (already created).

**Test command:** `npm test` / `node --test <file>`.

---

## File Structure
- `orchestrator/config.js` (modify) — `parseGeminiKeys` + `geminiApiKeys`.
- `orchestrator/config.test.js` (modify) — parser tests.
- `.env.example` (modify) — document `GEMINI_API_KEYS`.
- `orchestrator/intent/gemini-client.js` (create) — `nextKey` + `callGemini`.
- `orchestrator/intent/gemini-client.test.js` (create).
- `orchestrator/intent/gemini.js` (modify) — use `callGemini`.
- `orchestrator/intent/gemini.test.js` (modify) — add a 2-key retry test.
- `orchestrator/intent/knowledge.js` (modify) — use `callGemini`.
- `orchestrator/intent/knowledge.test.js` (modify) — add a 2-key retry test.

---

## Task 1: config — parse the key list

**Files:** `orchestrator/config.js`, `orchestrator/config.test.js`, `.env.example`.

- [ ] **Step 1: Failing test** — in `orchestrator/config.test.js`, add (and add `parseGeminiKeys` to the import from `./config.js`):
```js
test('parseGeminiKeys splits and trims GEMINI_API_KEYS', () => {
  assert.deepEqual(parseGeminiKeys({ GEMINI_API_KEYS: 'a, b ,c' }), ['a', 'b', 'c']);
});
test('parseGeminiKeys falls back to a lone GEMINI_API_KEY', () => {
  assert.deepEqual(parseGeminiKeys({ GEMINI_API_KEY: 'solo' }), ['solo']);
});
test('parseGeminiKeys returns [] when nothing is set', () => {
  assert.deepEqual(parseGeminiKeys({}), []);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/config.test.js`. FAIL (no `parseGeminiKeys`).

- [ ] **Step 3: Implement** — in `orchestrator/config.js`:
(a) Add the exported helper (above the `config` object):
```js
// GEMINI_API_KEYS is a comma-separated list; falls back to a lone GEMINI_API_KEY.
export function parseGeminiKeys(env = process.env) {
  const list = String(env.GEMINI_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (list.length) return list;
  const single = String(env.GEMINI_API_KEY ?? '').trim();
  return single ? [single] : [];
}
```
(b) Add `geminiApiKeys` to the `config` object (after `geminiApiKey`):
```js
  geminiApiKeys: parseGeminiKeys(),
```

- [ ] **Step 4:** Update `.env.example` — under the Gemini line, add:
```
# Optional: comma-separated keys for round-robin rotation (overrides GEMINI_API_KEY)
GEMINI_API_KEYS=
```

- [ ] **Step 5: Run** — `node --test orchestrator/config.test.js` (pass) and `npm test`.

- [ ] **Step 6: Commit**
```bash
git add orchestrator/config.js orchestrator/config.test.js .env.example
git commit -m "config: parseGeminiKeys + geminiApiKeys (comma-separated, GEMINI_API_KEY fallback)"
```

---

## Task 2: `gemini-client.js` — rotation + retry

**Files:** Create `orchestrator/intent/gemini-client.js`, `orchestrator/intent/gemini-client.test.js`.

- [ ] **Step 1: Failing test** — create `orchestrator/intent/gemini-client.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextKey, callGemini } from './gemini-client.js';

test('nextKey hands out keys round-robin', () => {
  const keys = ['a', 'b', 'c'];
  const seq = [nextKey(keys), nextKey(keys), nextKey(keys)];
  const i0 = keys.indexOf(seq[0]);
  assert.deepEqual(seq, [keys[i0 % 3], keys[(i0 + 1) % 3], keys[(i0 + 2) % 3]]); // consecutive, wrapping
});

function jsonResp(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj };
}

test('callGemini returns data on the first OK response', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return jsonResp({ hello: 'world' }); },
  });
  assert.deepEqual(data, { hello: 'world' });
  assert.equal(n, 1);
});

test('callGemini rotates to the next key on a non-OK response', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return n === 1 ? jsonResp({}, { ok: false, status: 503 }) : jsonResp({ ok: 1 }); },
  });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(n, 2); // first key failed, second succeeded
});

test('callGemini rotates on a thrown error', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; if (n === 1) throw new Error('network'); return jsonResp({ done: true }); },
  });
  assert.deepEqual(data, { done: true });
  assert.equal(n, 2);
});

test('callGemini returns null when all keys fail', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return jsonResp({}, { ok: false, status: 500 }); },
  });
  assert.equal(data, null);
  assert.equal(n, 2); // tried both keys, no more
});

test('callGemini returns null with no keys and does not fetch', async () => {
  let called = false;
  const data = await callGemini({ model: 'm', body: {}, keys: [], fetchFn: async () => { called = true; return jsonResp({}); } });
  assert.equal(data, null);
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/gemini-client.test.js`. FAIL (no `./gemini-client.js`).

- [ ] **Step 3: Implement** — create `orchestrator/intent/gemini-client.js`:
```js
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
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/gemini-client.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/gemini-client.js orchestrator/intent/gemini-client.test.js
git commit -m "intent: gemini-client — round-robin key rotation + retry (ported from SUTT_ML_TASK)"
```

---

## Task 3: `gemini.js` uses `callGemini`

**Files:** `orchestrator/intent/gemini.js`, `orchestrator/intent/gemini.test.js`.

- [ ] **Step 1: Add a failing test** — in `orchestrator/intent/gemini.test.js`, add (the existing single-key `apiKey:'x'` tests must keep passing):
```js
test('rotates to the second key when the first one fails', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"domain":"switch","action":"off","target":"tubelight"}' }] } }] }) };
  };
  const r = await geminiClassify('kill the light', VOCAB, { keys: ['k1', 'k2'], fetchFn });
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
  assert.equal(n, 2);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/gemini.test.js`. FAIL (no `keys` support / no rotation yet).

- [ ] **Step 3: Implement** — in `orchestrator/intent/gemini.js`:
(a) Add the import at the top (keep the `config` import):
```js
import { callGemini } from './gemini-client.js';
```
(b) Replace the `geminiClassify` function (keep `buildPrompt` and `validate` exactly as they are) with:
```js
// Classify a command with Gemini. Returns a validated intent or null, never throws.
export async function geminiClassify(text, vocab, {
  keys,
  apiKey,
  fetchFn,
  model = 'gemini-2.5-flash',
  timeoutMs = 8000,
} = {}) {
  const keyList = keys ?? (apiKey ? [apiKey] : config.geminiApiKeys);
  if (!keyList || keyList.length === 0) return null;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(text, vocab) }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  const data = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });
  if (!data) return null;
  try {
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    return validate(JSON.parse(raw), vocab);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/gemini.test.js` then `npm test`. ALL pass. (The existing tests pass `apiKey:'x'` ⇒ `keyList=['x']`; `apiKey:''` ⇒ falls back to `config.geminiApiKeys` which is `[]` in the test env ⇒ returns null without fetch, so "no apiKey -> fetch not called" still holds.)

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/gemini.js orchestrator/intent/gemini.test.js
git commit -m "intent: geminiClassify routes through callGemini (key rotation)"
```

---

## Task 4: `knowledge.js` uses `callGemini`

**Files:** `orchestrator/intent/knowledge.js`, `orchestrator/intent/knowledge.test.js`.

- [ ] **Step 1: Add a failing test** — in `orchestrator/intent/knowledge.test.js`, add:
```js
test('rotates to the second key when the first throws', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) throw new Error('rate limited');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Mars is the fourth planet.' }] } }] }) };
  };
  const r = await makeKnowledge({ keys: ['k1', 'k2'], fetchFn }).answer('mars');
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'Mars is the fourth planet.');
  assert.equal(n, 2);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/knowledge.test.js`. FAIL (no `keys`/rotation).

- [ ] **Step 3: Implement** — in `orchestrator/intent/knowledge.js`:
(a) Add the import (keep the `config` import + PERSONA/OFFLINE/FAILED constants):
```js
import { callGemini } from './gemini-client.js';
```
(b) Replace `makeKnowledge` with (PERSONA/OFFLINE/FAILED unchanged above it):
```js
export function makeKnowledge({
  keys,
  apiKey,
  fetchFn,
  model = 'gemini-2.5-flash',
  timeoutMs = 9000,
} = {}) {
  const keyList = keys ?? (apiKey ? [apiKey] : config.geminiApiKeys);
  return {
    async answer(query) {
      const q = String(query ?? '').trim();
      if (!keyList || keyList.length === 0) return { ok: true, speak: OFFLINE };
      const body = {
        systemInstruction: { parts: [{ text: PERSONA }] },
        contents: [{ parts: [{ text: q }] }],
        generationConfig: { temperature: 0.7 },
      };
      const data = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });
      if (!data) return { ok: true, speak: FAILED };
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) return { ok: true, speak: FAILED };
      return { ok: true, speak: String(raw).trim() };
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/knowledge.test.js` then `npm test`. ALL pass. (Existing tests: `apiKey:'x'` ⇒ `['x']`; `apiKey:''` ⇒ `config.geminiApiKeys` = `[]` in test env ⇒ OFFLINE without fetch; HTTP-error/non-JSON/throw ⇒ `callGemini` returns null ⇒ FAILED.)

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/knowledge.js orchestrator/intent/knowledge.test.js
git commit -m "intent: knowledge answers route through callGemini (key rotation)"
```

---

## Task 5: full suite, checkpoint, finish

**Files:** none code (verification); `CHECKPOINT.md`.

- [ ] **Step 1: Full suite** — `npm test`. All pass. Also boot-import check: `node -e "import('./orchestrator/config.js').then(m=>console.log('keys', JSON.stringify(m.config.geminiApiKeys)))"` (should be `[]` with no env, or the `.env` keys if run with `--env-file=.env`).

- [ ] **Step 2: Update CHECKPOINT.md** — dated bullet: Gemini calls (intent classification + knowledge answers) now rotate round-robin through `GEMINI_API_KEYS` via shared `intent/gemini-client.js` (`callGemini`), retrying the next key on any non-OK/throw and returning null when exhausted; falls back to a lone `GEMINI_API_KEY`; ported from `SUTT_ML_TASK`. Commit:
```bash
git add CHECKPOINT.md && git commit -m "checkpoint: Gemini key rotation across both call sites"
```

- [ ] **Step 3: Clean up the cloned repo** — `rm -rf /tmp/SUTT_ML_TASK`.

- [ ] **Step 4: Finish the branch** — use superpowers:finishing-a-development-branch to merge `gemini-key-rotation` into `main`.
