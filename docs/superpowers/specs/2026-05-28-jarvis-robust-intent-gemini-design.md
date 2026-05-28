# JARVIS — Robust Intent Parsing + Gemini Fallback Design

**Date:** 2026-05-28
**Status:** Approved — ready for implementation planning
**Scope:** Harden the intent layer before voice (Phase 2): typo/STT-tolerant rule matching, plus the
Gemini 2.5 Flash fallback (PROJECT.md Phase 4). Single API key now; key **rotation is deferred**.
**Source of truth:** `PROJECT.md` (§5.3 hybrid intent: rules then Gemini; §6 intent contract; §9 lean
deps + Gemini 2.5 Flash, temp 0.1, JSON). Local-first (principle 6): Gemini only on a rules-miss.

---

## 1. Goal

Make `parse(text, vocab)` understand imperfect input — spelling errors, STT slips, loose phrasing —
and fall back to Gemini for anything the offline rules can't classify, always emitting the existing
intent contract `{domain:'switch', action:'on|off|all_off|status', target}` (target omitted for
`all_off`) or `null`.

**Acceptance:** small typos like `"turn of the tublight"` or `"soket on"` resolve **offline** via the
fuzzy rules (no network); heavier phonetic garbles (`"lites off"`, `"toob light on"`) and genuinely
novel phrasings fall through to **Gemini**, which classifies them; Gemini-unreachable/garbage →
graceful `null` → "Sorry, I didn't catch that." The two layers together deliver the robustness — fuzzy
is just the cheap first net. `npm test` green (existing 38 + new).

## 2. The cascade

`parse(text, vocab)` (async) tries, in order:

1. **Rule matcher with fuzzy target resolution** (`matchSwitchCommand`, offline, instant). Exact
   matches still win (they are distance 0); fuzzy only kicks in when there's no exact target.
2. **Gemini fallback** (`geminiClassify`, ~1s, only if the rules return `null`).
3. Still `null` → caller speaks "Sorry, I didn't catch that."

In code this is two layers (the fuzzy logic lives **inside** `matchSwitchCommand`'s target finder, so
exact-vs-fuzzy is one unified step), then the Gemini fallback. Local path stays offline + instant.

## 3. Fuzzy rule matcher (`intent/rules.js`)

Keep the current normalization, action detection, and assembly. Replace exact target-finding with
fuzzy-capable target-finding (approach A — conservative, target words only).

**Levenshtein:** add a small pure `levenshtein(a, b)` helper (standard DP, no deps).

**Target resolution** over the normalized tokens:
- Build candidate windows: every contiguous run of **1 and 2 tokens**; each window's *joined* form is
  its tokens concatenated without spaces (so `"tube light"`→`"tubelight"`, `"night light"`→
  `"nightlight"` — handles STT word splits/joins).
- For each vocab target `T` (device or group name), `Tj = T` without spaces. Compute the min
  Levenshtein distance between `Tj` and any window's joined form.
- `T` matches if `minDist ≤ maxDist(Tj)`, where **`maxDist(len) = len <= 4 ? 0 : Math.min(2, Math.floor(len/4))`**
  (short names like `fans`, `fan 1` require an exact match — avoids ambiguous fuzzy flips; longer
  names tolerate 1–2 edits).
- Among matching targets pick the smallest distance; tie-break by **longest** `Tj` (so `night light`
  beats `lights`), then first. Exact (distance 0) always wins.

**Action detection** (kept mostly exact — fuzzing 2-char words causes false flips):
- **status** if the text is a question (starts `is`/`are`, or original had `?`).
- else **off** if `/\boff\b/`, or `/\bturn of\b/` (common STT/typo for "turn off"), or a token in
  `{shut, kill, cut}`.
- else **on** if `/\bon\b/`.
- `all_off` when action is off, no specific target, and the text has `all` or `everything`
  (fuzzy ≤1 allowed on the long word `everything`).

**No false positives:** if no action, or an on/off action with no resolved target and not all_off →
return `null` (let Gemini try). Examples (fuzzy catches small ≤maxDist typos; the rest go to Gemini):

| Input | Distance | Result |
|-------|----------|--------|
| `turn off the tubelight` (exact) | 0 | fuzzy → `{off, tubelight}` |
| `turn of the tublight` | `tublight`↔`tubelight` = 1 | fuzzy → `{off, tubelight}` |
| `soket on` | `soket`↔`socket` = 1 | fuzzy → `{on, socket}` |
| `spotligt off` | `spotligt`↔`spotlight` = 1 | fuzzy → `{off, spotlight}` |
| `lites off` | `lites`↔`lights` = 3 (> 1) | rules `null` → **Gemini** |
| `toob light on` | `tooblight`↔`tubelight` = 3 (> 2) | rules `null` → **Gemini** |
| `turn on fan` | ambiguous, no exact short-name match | rules `null` → **Gemini** |
| `make me a sandwich` | no target | rules `null` → Gemini → `null` |

(Recall on phonetic garbles comes from the Gemini layer, by design — not from loosening the fuzzy
threshold, which the user chose to keep conservative to avoid flipping the wrong relay.)

## 4. Gemini fallback (`intent/gemini.js`)

```js
export async function geminiClassify(text, vocab, {
  apiKey = config.geminiApiKey,
  fetchFn = globalThis.fetch,
  model = 'gemini-2.5-flash',
  timeoutMs = 8000,
} = {}) { /* ... */ }   // -> intent | null
```

- If `!apiKey` → return `null` (skip; offline still works).
- POST `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  with `AbortSignal.timeout(timeoutMs)`, body:
  ```json
  { "contents": [{ "parts": [{ "text": "<prompt>" }] }],
    "generationConfig": { "temperature": 0.1, "responseMimeType": "application/json" } }
  ```
- **Prompt** injects the valid actions and the valid targets from `vocab` (device names + group
  names) and the exact JSON schema; instructs: return `{"domain":"switch","action":...,"target":...}`
  (omit target for `all_off`), or `{"action":"none"}` if it is not a switch command. Targets MUST be
  from the provided list.
- Parse `candidates[0].content.parts[0].text` as JSON; **validate**: `action ∈ {on,off,all_off,status}`;
  if `action !== 'all_off'`, `target` must be in `vocab.deviceNames ∪ vocab.groupNames`; if
  `all_off`, drop any target. Anything else (`none`, junk, missing fields, hallucinated target) → `null`.
- **Any** thrown error / timeout / non-200 → `null` (never throws to the caller).
- `apiKey` + `fetchFn` are injectable so unit tests use a fake `fetchFn` (no network).

## 5. Wiring (`intent/index.js`, `server.js`)

```js
// index.js
export async function parse(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return m;
  return await classify(text, vocab);
}
```
`classify` is injectable for tests. `server.js` `main()` changes one line: `const intent = await parse(text, vocab);` inside `onCommand`. `/switch` is unaffected (it builds intents directly). `parse` becoming async ripples only into `onCommand` (already async) and `index.test.js`.

## 6. Config & keys

- Uses `config.geminiApiKey` (`GEMINI_API_KEY`, already set to a confirmed-working key in the
  gitignored `.env`).
- The non-expired keys are also stored as `GEMINI_API_KEYS` in `.env` for the **future** rotation —
  **not used yet**. No rotation logic in this work.
- No new npm dependencies (built-in `fetch`).

## 7. Testing

- **`rules.test.js`** — existing exact cases stay green; add fuzzy-**match** cases that are within
  threshold (`turn of the tublight` → `{off, tubelight}`, `soket on` → `{on, socket}`, `spotligt off`
  → `{off, spotlight}`) and **rules-miss** cases that must return `null` (so the cascade defers to
  Gemini): `lites off`, `toob light on`, `turn on fan`, `make me a sandwich`. Add a `levenshtein`
  unit test (e.g. `levenshtein('tublight','tubelight') === 1`, `levenshtein('lites','lights') === 3`).
- **`gemini.test.js`** — `geminiClassify(text, vocab, { apiKey:'x', fetchFn })` with a fake `fetchFn`:
  a canned good JSON → parsed+validated intent; `{"action":"none"}` → null; hallucinated target not in
  vocab → null; non-JSON / non-200 → null; `fetchFn` throws → null; no `apiKey` → null (and `fetchFn`
  not called).
- **`index.test.js`** — update the 2 existing tests to `await parse(...)`; add cascade tests with an
  injected `classify` spy: rules hit ⇒ spy **not** called; rules miss ⇒ spy called and its result
  returned.
- **Live smoke (separate, not in `npm test`):** boot the server, POST a deliberately garbled,
  rules-missing phrase, confirm Gemini classifies it and the relay responds.

## 8. Out of scope

Key rotation (deferred — keys are stored, logic comes after voice), response caching, the `pc`
domain, non-switch intents, multi-language. No changes to the ESP32 firmware or the device rules.
