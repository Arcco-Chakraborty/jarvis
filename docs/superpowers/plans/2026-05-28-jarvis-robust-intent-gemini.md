# JARVIS Robust Intent + Gemini Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `parse()` typo/STT-tolerant (fuzzy device matching) and add a Gemini 2.5 Flash fallback, so garbled commands still resolve to the right `{domain,action,target}` intent.

**Architecture:** `matchSwitchCommand` gains a pure `levenshtein` helper and fuzzy device-name resolution (groups stay exact); `intent/gemini.js` adds an injectable `geminiClassify` (built-in `fetch`, JSON mode, vocab-validated, graceful `null`); `intent/index.js` `parse` becomes async and cascades rules → Gemini. Single key from `GEMINI_API_KEY`; no rotation.

**Tech Stack:** Node 22 (ESM), built-in `fetch` + `AbortSignal.timeout`, `node:test`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-robust-intent-gemini-design.md`

**Baseline:** 38 tests pass (config 2, registry 8, rules 12, index 2, router 7, server 7).

---

## Task 1: Fuzzy rule matcher (TDD)

**Files:**
- Modify: `orchestrator/intent/rules.js`
- Test: `orchestrator/intent/rules.test.js`

- [ ] **Step 1: Append failing tests** to `orchestrator/intent/rules.test.js`:

```js
import { levenshtein } from './rules.js';

test('levenshtein computes edit distance', () => {
  assert.equal(levenshtein('tublight', 'tubelight'), 1);
  assert.equal(levenshtein('soket', 'socket'), 1);
  assert.equal(levenshtein('spotligt', 'spotlight'), 1);
  assert.equal(levenshtein('lites', 'lights'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('fuzzy: small device typo with "turn of" -> off', () => {
  assert.deepEqual(m('turn of the tublight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('fuzzy: soket -> socket', () => {
  assert.deepEqual(m('soket on'), { domain: 'switch', action: 'on', target: 'socket' });
});
test('fuzzy: spotligt -> spotlight', () => {
  assert.deepEqual(m('spotligt off'), { domain: 'switch', action: 'off', target: 'spotlight' });
});
test('synonym: kill the lights -> group off', () => {
  assert.deepEqual(m('kill the lights'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('rules miss (beyond threshold) -> null: lites off', () => {
  assert.equal(m('lites off'), null);
});
test('rules miss -> null: toob light on (groups are exact-only)', () => {
  assert.equal(m('toob light on'), null);
});
test('rules miss -> null: ambiguous "turn on fan"', () => {
  assert.equal(m('turn on fan'), null);
});
```

> The file already imports `test`, `assert`, and defines `m`/`VOCAB`; add only the new `import { levenshtein }` line at the top with the other imports, and append the tests.

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/intent/rules.test.js`
Expected: FAIL — `levenshtein` is not exported; fuzzy cases fail (current matcher is exact-only).

- [ ] **Step 3: Replace `orchestrator/intent/rules.js`** with:

```js
// Pure rule-based matcher for the switch domain. No I/O.
// vocab = { deviceNames: string[], groupNames: string[] }.

// Standard two-row Levenshtein edit distance.
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Max edit distance for a fuzzy DEVICE match by joined-name length.
// <=4 requires exact (avoids ambiguous flips like fan 1/fan 2); longer tolerate 1-2.
function maxDist(len) {
  return len <= 4 ? 0 : Math.min(2, Math.floor(len / 4));
}

// Resolve a target from the normalized tokens.
// Groups: exact only. Devices: fuzzy within maxDist. Exact group beats fuzzy device.
function findTarget(tokens, deviceNames, groupNames) {
  const windows = [];
  for (let i = 0; i < tokens.length; i++) {
    windows.push(tokens[i]);
    if (i + 1 < tokens.length) windows.push(tokens[i] + tokens[i + 1]);
  }

  for (const g of groupNames) {
    if (windows.includes(g.replace(/\s+/g, ''))) return g;
  }

  let best = null; // { name, dist, tjLen }
  for (const name of deviceNames) {
    const tj = name.replace(/\s+/g, '');
    let min = Infinity;
    for (const w of windows) {
      const d = levenshtein(w, tj);
      if (d < min) min = d;
    }
    if (min <= maxDist(tj.length)) {
      if (best === null || min < best.dist || (min === best.dist && tj.length > best.tjLen)) {
        best = { name, dist: min, tjLen: tj.length };
      }
    }
  }
  return best ? best.name : null;
}

export function matchSwitchCommand(text, vocab) {
  const raw = String(text ?? '');
  const isQuestion = raw.includes('?');
  const norm = normalize(raw);
  if (!norm) return null;

  const { deviceNames = [], groupNames = [] } = vocab ?? {};
  const tokens = norm.split(' ').filter(Boolean);
  const target = findTarget(tokens, deviceNames, groupNames);

  // Status query (question form) — single device only.
  if (isQuestion || /^(is|are)\b/.test(norm)) {
    if (target && deviceNames.includes(target)) {
      return { domain: 'switch', action: 'status', target };
    }
    return null;
  }

  // Action: off (incl. "turn of" STT slip + synonyms) / on. Short words kept exact (no fuzzing).
  let action = null;
  if (
    /\boff\b/.test(norm) ||
    /\bturn of\b/.test(norm) ||
    tokens.some((t) => t === 'shut' || t === 'kill' || t === 'cut')
  ) {
    action = 'off';
  } else if (/\bon\b/.test(norm)) {
    action = 'on';
  }
  if (!action) return null;

  if (target) return { domain: 'switch', action, target };

  // all_off: off + no specific target + a global word (fuzzy<=1 on the long word "everything").
  if (action === 'off' && (/\ball\b/.test(norm) || tokens.some((t) => levenshtein(t, 'everything') <= 1))) {
    return { domain: 'switch', action: 'all_off' };
  }
  return null;
}
```

- [ ] **Step 4: Run rules tests**

Run: `node --test orchestrator/intent/rules.test.js`
Expected: PASS — 19 tests (12 existing + 7 new).

- [ ] **Step 5: Full suite (no regressions)**

Run: `npm test`
Expected: PASS — 45 tests (38 baseline + 7), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/intent/rules.js orchestrator/intent/rules.test.js
git commit -m "Add fuzzy device matching (Levenshtein) + action synonyms to rule matcher"
```

---

## Task 2: Gemini fallback client (TDD)

**Files:**
- Create: `orchestrator/intent/gemini.js`
- Test: `orchestrator/intent/gemini.test.js`

- [ ] **Step 1: Write the failing test** — `orchestrator/intent/gemini.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiClassify } from './gemini.js';

const VOCAB = { deviceNames: ['tubelight', 'socket'], groupNames: ['lights'] };

// fake fetch returning a Gemini-shaped response wrapping `text`.
function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });
}

test('valid JSON -> validated intent', async () => {
  const r = await geminiClassify('kill the big light', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"off","target":"tubelight"}'),
  });
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('all_off drops any target', async () => {
  const r = await geminiClassify('shut everything', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"action":"all_off","target":"lights"}'),
  });
  assert.deepEqual(r, { domain: 'switch', action: 'all_off' });
});
test('action "none" -> null', async () => {
  const r = await geminiClassify('hello', VOCAB, { apiKey: 'x', fetchFn: fakeFetch('{"action":"none"}') });
  assert.equal(r, null);
});
test('hallucinated target -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"on","target":"chandelier"}'),
  });
  assert.equal(r, null);
});
test('status on a group -> null (status is device-only)', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"status","target":"lights"}'),
  });
  assert.equal(r, null);
});
test('non-200 -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"action":"off","target":"socket"}', { ok: false, status: 503 }),
  });
  assert.equal(r, null);
});
test('non-JSON text -> null', async () => {
  const r = await geminiClassify('x', VOCAB, { apiKey: 'x', fetchFn: fakeFetch('sorry, I cannot') });
  assert.equal(r, null);
});
test('fetch throws -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(r, null);
});
test('no apiKey -> null and fetch not called', async () => {
  let called = false;
  const r = await geminiClassify('x', VOCAB, {
    apiKey: '',
    fetchFn: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(r, null);
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/intent/gemini.test.js`
Expected: FAIL — cannot find module `./gemini.js`.

- [ ] **Step 3: Create `orchestrator/intent/gemini.js`:**

```js
import { config } from '../config.js';

const VALID_ACTIONS = new Set(['on', 'off', 'all_off', 'status']);

function buildPrompt(text, vocab) {
  const devices = (vocab?.deviceNames ?? []).join(', ');
  const groups = (vocab?.groupNames ?? []).join(', ');
  return [
    'You classify a smart-home switch command into strict JSON. Respond with ONLY a JSON object, no prose.',
    'Actions: on, off, all_off, status.',
    `Valid device targets: ${devices}.`,
    `Valid group targets: ${groups}.`,
    'For on/off: {"domain":"switch","action":"on|off","target":"<one valid device or group>"}.',
    'For a single-device state question: {"domain":"switch","action":"status","target":"<one valid device>"}.',
    'For turning everything off: {"domain":"switch","action":"all_off"} (no target).',
    'The target MUST be exactly one of the valid targets listed above.',
    'If the input is not a switch command, respond {"action":"none"}.',
    `Command: ${text}`,
  ].join('\n');
}

function validate(obj, vocab) {
  if (!obj || typeof obj !== 'object') return null;
  const action = obj.action;
  if (!VALID_ACTIONS.has(action)) return null;
  if (action === 'all_off') return { domain: 'switch', action: 'all_off' };

  const devices = vocab?.deviceNames ?? [];
  const groups = vocab?.groupNames ?? [];
  const target = obj.target;
  if (typeof target !== 'string') return null;

  if (action === 'status') {
    return devices.includes(target) ? { domain: 'switch', action: 'status', target } : null;
  }
  // on / off: device or group
  return devices.includes(target) || groups.includes(target)
    ? { domain: 'switch', action, target }
    : null;
}

// Classify a command with Gemini. Returns a validated intent or null (never throws).
// apiKey + fetchFn are injectable for testing.
export async function geminiClassify(text, vocab, {
  apiKey = config.geminiApiKey,
  fetchFn = globalThis.fetch,
  model = 'gemini-2.5-flash',
  timeoutMs = 8000,
} = {}) {
  if (!apiKey) return null;
  try {
    const res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(text, vocab) }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    return validate(JSON.parse(raw), vocab);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run gemini tests**

Run: `node --test orchestrator/intent/gemini.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/gemini.js orchestrator/intent/gemini.test.js
git commit -m "Add Gemini 2.5 Flash fallback classifier (REST, JSON mode, validated, graceful)"
```

---

## Task 3: Wire the cascade (TDD)

**Files:**
- Modify: `orchestrator/intent/index.js`
- Modify: `orchestrator/intent/index.test.js`
- Modify: `orchestrator/server.js`

- [ ] **Step 1: Replace `orchestrator/intent/index.test.js`** with (existing tests updated to `await` + new cascade tests):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './index.js';

const VOCAB = { deviceNames: ['tubelight'], groupNames: ['lights'] };

test('parse delegates to the rule matcher (rules hit)', async () => {
  assert.deepEqual(await parse('turn off the tubelight', VOCAB), {
    domain: 'switch', action: 'off', target: 'tubelight',
  });
});

test('parse returns null when rules miss and fallback declines', async () => {
  const noop = async () => null;
  assert.equal(await parse('make me a sandwich', VOCAB, noop), null);
});

test('rules hit -> fallback NOT called', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return null;
  };
  await parse('turn off the tubelight', VOCAB, spy);
  assert.equal(called, false);
});

test('rules miss -> fallback called and its result returned', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { domain: 'switch', action: 'off', target: 'tubelight' };
  };
  const r = await parse('lites off', VOCAB, spy);
  assert.equal(called, true);
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/intent/index.test.js`
Expected: FAIL — the "rules miss -> fallback called" test fails (current `parse` ignores `classify` and returns `null` synchronously, so the spy is never called).

- [ ] **Step 3: Replace `orchestrator/intent/index.js`** with:

```js
import { matchSwitchCommand } from './rules.js';
import { geminiClassify } from './gemini.js';

// Parse a command transcript into an intent.
// Cascade: fuzzy rule matcher (offline) -> Gemini fallback (only on a rules-miss).
// `classify` is injectable for testing; defaults to the real Gemini classifier.
export async function parse(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return m;
  return await classify(text, vocab);
}
```

- [ ] **Step 4: Run index tests**

Run: `node --test orchestrator/intent/index.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Make `onCommand` await `parse`** in `orchestrator/server.js`. Find:

```js
  const onCommand = async (text) => {
    const intent = parse(text, vocab);
```
Replace the second line with:
```js
    const intent = await parse(text, vocab);
```

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS — 56 tests (config 2, registry 8, rules 19, gemini 9, index 4, router 7, server 7), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/intent/index.js orchestrator/intent/index.test.js orchestrator/server.js
git commit -m "Wire intent cascade: async parse -> rules then Gemini fallback"
```

---

## Task 4: Live smoke + checkpoint + push

> Verification (no commit for the smoke), then checkpoint + push.

- [ ] **Step 1: Restart the server fresh** (one may be running on :3000)

```bash
pkill -f "orchestrator/server.js" 2>/dev/null; sleep 1
npm start > /tmp/jarvis-intent.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:3000/health >/dev/null 2>&1 && break; sleep 0.3; done
```

- [ ] **Step 2: Offline fuzzy path + Gemini fallback path**

```bash
echo "-- small typo (should be handled OFFLINE by fuzzy rules) --"
curl -s -X POST localhost:3000/command -H 'content-type: application/json' -d '{"text":"soket on"}'; echo
echo "-- phonetic garble (rules miss -> GEMINI) --"
curl -s -X POST localhost:3000/command -H 'content-type: application/json' -d '{"text":"switch off the lites"}'; echo
echo "-- nonsense (rules miss -> Gemini -> none) --"
curl -s -X POST localhost:3000/command -H 'content-type: application/json' -d '{"text":"what is the meaning of life"}'; echo
```
Expected: `soket on` → `{"ok":true,"speak":"Socket is on.",...}`; `switch off the lites` → Gemini returns `{off, lights}` → `{"ok":true,"speak":"Lights are off.",...}` (takes ~1s); nonsense → `{"ok":false,"speak":"Sorry, I didn't catch that.","intent":null}`.

- [ ] **Step 3: Stop the smoke server**

```bash
pkill -f "orchestrator/server.js" 2>/dev/null
```

- [ ] **Step 4: Tick Phase 4 in `CHECKPOINT.md`.** Replace:

```
- [ ] **Phase 4 — Gemini fallback.** LLM intent for commands the rules miss, registry injected, strict JSON output, graceful failure.
```
with:
```
- [x] **Phase 4 — Gemini fallback.** Done 2026-05-28. Intent cascade: exact rules -> fuzzy (Levenshtein, devices) -> Gemini 2.5 Flash (registry-injected, JSON mode, validated, graceful null). Single key (GEMINI_API_KEY); rotation deferred (keys stashed in .env as GEMINI_API_KEYS).
```

- [ ] **Step 5: Add a TL;DR line in `CHECKPOINT.md`.** After the web-dashboard bullet, insert:

```
- **Robust parsing + Gemini fallback — DONE.** Fuzzy device matching for small typos/STT slips; Gemini 2.5 Flash classifies whatever the offline rules miss; graceful "didn't catch that" on failure. 56 tests green.
```

- [ ] **Step 6: Commit + push**

```bash
git add CHECKPOINT.md
git commit -m "Update checkpoint: Phase 4 (robust parsing + Gemini fallback) done"
git push
```
Expected: commits on `origin/main`; `git status -sb` shows `## main...origin/main`.

---

## Acceptance criteria

- [ ] `npm test` green — 56 tests, 0 failures, and runs fully offline (no real Gemini calls in tests).
- [ ] Small device typos resolve offline (`soket on` → Socket is on; `turn of the tublight` → Tubelight off).
- [ ] A rules-missing garble (`switch off the lites`) is classified by Gemini and flips the relay.
- [ ] Nonsense → `{"ok":false,"speak":"Sorry, I didn't catch that.","intent":null}`.
- [ ] No new npm dependencies; `.env` keys never committed.
- [ ] Work pushed to `origin/main`; `CHECKPOINT.md` marks Phase 4 done.
```
