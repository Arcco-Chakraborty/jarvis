# Vision-by-Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let natural deictic/help phrasing ("how do I connect these", "fix this", "what's wrong with this") use the phone camera by default, with a silent text fallback when the camera is offline.

**Architecture:** A new `matchImplicitVision` matcher sits in the intent cascade after explicit vision and before `matchAsk`, returning a vision intent flagged `implicit:true`. The router's vision branch, on capture failure for an implicit intent, falls back to the knowledge (Gemini text) answer instead of speaking a camera error.

**Tech Stack:** Node (ESM), `node:test` + `node:assert/strict`. Orchestrator-only; no agent or `.env` changes.

---

## Rule (option B, as approved)

Because the cascade runs `switch → pc → explicit-vision` first, the only signal the implicit matcher needs is: the utterance contains a **demonstrative** (`this/that/these/those/here`) **or** is a **bare help phrase** (`fix …`, `what's/what is wrong with …`). "How do I …" only reaches the camera when it contains a demonstrative (e.g. "how do I connect **these**"), which the demonstrative test already covers — so "how do I make pasta" stays on the text path.

## File structure

- **Modify** `orchestrator/intent/vision.js` — add exported `matchImplicitVision(text)`.
- **Modify** `orchestrator/intent/index.js` — insert it after `matchVision`, before `matchAsk`, in both `parseWithSource` and `parseLocal`.
- **Modify** `orchestrator/router.js` — implicit fallback to `knowledge.answer` in the vision branch.
- Tests: `vision.test.js`, `index.test.js`, `router.test.js`.

---

## Task 1: matchImplicitVision

**Files:**
- Modify: `orchestrator/intent/vision.js`
- Test: `orchestrator/intent/vision.test.js`

- [ ] **Step 1: Write the failing test** — add to `vision.test.js` (it already imports from `./vision.js`; add `matchImplicitVision` to that import):

```js
import { matchVision, matchImplicitVision } from './vision.js';

test('matchImplicitVision fires on demonstratives and bare help-verbs', () => {
  for (const t of [
    'how do i connect these',
    "what's wrong with this",
    'fix this',
    'fix the wiring',
    'what does this button do',
    'is this plugged in right',
  ]) {
    const r = matchImplicitVision(t);
    assert.ok(r, `should fire: ${t}`);
    assert.equal(r.domain, 'vision');
    assert.equal(r.source, 'phone');
    assert.equal(r.implicit, true);
    assert.equal(typeof r.query, 'string');
  }
});

test('matchImplicitVision stays out of plain knowledge questions', () => {
  for (const t of ['how do i make pasta', "what's the capital of france", 'who is ada lovelace']) {
    assert.equal(matchImplicitVision(t), null, `should not fire: ${t}`);
  }
});
```

(If `vision.test.js` currently imports only `matchVision`, widen that single import line as shown.)

- [ ] **Step 2: Run it — expect FAIL** (`matchImplicitVision` undefined)

Run: `cd orchestrator && node --test intent/vision.test.js`
Expected: import/reference error or failing assertions.

- [ ] **Step 3: Implement** — in `vision.js`, after `matchVision`, add (reusing the existing `normalize`):

```js
const DEMONSTRATIVE = /\b(this|that|these|those|here)\b/;
const BARE_HELP = /^(fix\b|what'?s wrong with\b|what is wrong with\b)/;

// Implicit vision: natural phrasing that points at something physical. Runs
// after explicit vision and before the knowledge matcher. Always the phone.
export function matchImplicitVision(text) {
  const norm = normalize(text);
  if (!norm) return null;
  if (DEMONSTRATIVE.test(norm) || BARE_HELP.test(norm)) {
    return { domain: 'vision', source: 'phone', query: norm, implicit: true };
  }
  return null;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd orchestrator && node --test intent/vision.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/vision.js orchestrator/intent/vision.test.js
git commit -m "feat(intent): matchImplicitVision for deictic/help phrasing"
```

---

## Task 2: Wire it into the cascade

**Files:**
- Modify: `orchestrator/intent/index.js`
- Test: `orchestrator/intent/index.test.js`

- [ ] **Step 1: Write the failing test** — add to `index.test.js` (it imports `parse`/`parseLocal` from `./index.js`; reuse those). Use a classifier stub that returns null so the cascade is exercised offline:

```js
test('implicit vision routes deictic questions before ask', async () => {
  const noGemini = async () => null;
  const r = await parse('how do i connect these', {}, noGemini);
  assert.equal(r.domain, 'vision');
  assert.equal(r.implicit, true);
  assert.equal(r.source, 'phone');
});

test('explicit vision is unaffected (no implicit flag)', async () => {
  const noGemini = async () => null;
  const r = await parse('what is this', {}, noGemini);
  assert.equal(r.domain, 'vision');
  assert.notEqual(r.implicit, true);
});

test('plain knowledge questions still reach ask', async () => {
  const noGemini = async () => null;
  const r = await parse("what's the capital of france", {}, noGemini);
  assert.equal(r.domain, 'ask');
});
```

(If `parse` isn't imported in `index.test.js`, add it to the existing `./index.js` import.)

- [ ] **Step 2: Run it — expect FAIL** (first test gets `ask`, not implicit vision)

Run: `cd orchestrator && node --test intent/index.test.js`
Expected: first test fails.

- [ ] **Step 3: Implement** — in `index.js`, import the new matcher and insert it after `matchVision` and before `matchAsk` in BOTH `parseWithSource` and `parseLocal`.

Update the import:

```js
import { matchVision, matchImplicitVision } from './vision.js';
```

In `parseWithSource`, after the `const vi = matchVision(text); if (vi) ...` lines add:

```js
  const ivi = matchImplicitVision(text);
  if (ivi) return { intent: ivi, via: 'rules' };
```

In `parseLocal`, change the chain to include it after `matchVision`:

```js
  return (
    matchSwitchCommand(text, vocab) ||
    matchPcCommand(text, vocab) ||
    matchVision(text) ||
    matchImplicitVision(text) ||
    matchAsk(text) ||
    matchConfirm(text) ||
    null
  );
```

- [ ] **Step 4: Run it — expect PASS**, and the whole intent folder green.

Run: `cd orchestrator && node --test intent/index.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "feat(intent): wire implicit vision into the cascade before ask"
```

---

## Task 3: Router fallback to knowledge on implicit-vision capture failure

**Files:**
- Modify: `orchestrator/router.js` (the vision branch, ~lines 21-24)
- Test: `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing test** — add to `router.test.js`:

```js
test('implicit vision falls back to knowledge when capture fails', async () => {
  const vision = { look: async () => ({ ok: false, speak: "I couldn't reach your phone's camera." }) };
  const knowledge = { answer: async (q) => ({ ok: true, speak: `Knowledge: ${q}` }) };
  const r = await route(
    { domain: 'vision', source: 'phone', query: 'how do i connect these', implicit: true },
    { vision, knowledge },
  );
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'Knowledge: how do i connect these');
});

test('implicit vision returns the description when capture succeeds', async () => {
  const vision = { look: async () => ({ ok: true, speak: 'A tangle of cables.' }) };
  const knowledge = { answer: async () => { throw new Error('should not be called'); } };
  const r = await route({ domain: 'vision', source: 'phone', query: 'q', implicit: true }, { vision, knowledge });
  assert.equal(r.speak, 'A tangle of cables.');
});

test('explicit vision keeps the camera error (no knowledge fallback)', async () => {
  const vision = { look: async () => ({ ok: false, speak: "I couldn't reach your phone's camera." }) };
  const knowledge = { answer: async () => { throw new Error('should not be called'); } };
  const r = await route({ domain: 'vision', source: 'phone', query: 'q' }, { vision, knowledge });
  assert.equal(r.ok, false);
  assert.match(r.speak, /camera/i);
});
```

- [ ] **Step 2: Run it — expect FAIL** (today the vision branch returns `vision.look` directly; the first test gets the camera error)

Run: `cd orchestrator && node --test router.test.js`
Expected: first test fails.

- [ ] **Step 3: Implement** — in `router.js`, replace the vision branch:

```js
  if (intent.domain === 'vision') {
    if (!vision) return { ok: false, speak: 'Vision capability not configured.' };
    return vision.look({ source: intent.source, query: intent.query });
  }
```

with:

```js
  if (intent.domain === 'vision') {
    if (!vision) return { ok: false, speak: 'Vision capability not configured.' };
    const r = await vision.look({ source: intent.source, query: intent.query });
    // Implicit (deictic/help) requests should never block on a flaky camera —
    // fall back to a normal spoken answer instead of a camera error.
    if (!r.ok && intent.implicit && knowledge) return knowledge.answer(intent.query);
    return r;
  }
```

(`knowledge` is already in the `_route` destructured deps.)

- [ ] **Step 4: Run it — expect PASS**, plus the whole orchestrator suite green.

Run: `cd orchestrator && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "feat(router): implicit vision falls back to knowledge on capture failure"
```

---

## Task 4: Manual end-to-end

- [ ] **Step 1: Restart** the orchestrator (`./run-jarvis.sh`).
- [ ] **Step 2: Camera up** — say/POST `"how do i connect these"`; expect a spoken description of what the phone sees (no "look at" needed).
- [ ] **Step 3: Camera down** (stop the phone app) — same phrase; expect a normal knowledge answer with NO camera-error mention.
- [ ] **Step 4: Negative** — `"what's the capital of france"`; expect a normal knowledge answer (no camera attempt).

---

## Done criteria

- Deictic/help phrasing uses the phone camera without explicit triggers.
- Camera-offline implicit requests answer silently from knowledge; explicit "look at…" still reports the camera error.
- Plain knowledge questions are unaffected.
- `cd orchestrator && node --test` green.
