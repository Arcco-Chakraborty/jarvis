# JARVIS Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini the general fallback (any missed command, plus a confirm-gated proposed shell command), add a "find out about X" knowledge answer in a Stark-JARVIS voice, split look-up/search (web) from find-out (answer), and add offline persona quips for control confirmations.

**Architecture:** New pure local matcher `intent/ask.js`; `pc.js` gains "look up"; new `intent/knowledge.js` (warm Gemini answer) and `intent/persona.js` (static quips); `intent/gemini.js` rewritten to classify the full vocabulary (switch/open_app/media/search/shell-command/ask). Router gains `ask`→knowledge and a persona post-process; the pipeline accepts a Gemini-proposed raw shell command through the existing confirm gate.

**Tech Stack:** Node ESM, `node:test`, Gemini 2.5 Flash REST (injected `fetchFn`).

**Spec:** `docs/superpowers/specs/2026-05-31-jarvis-brain-design.md`
**Branch:** `jarvis-brain` (already created).

**Test command:** `npm test` (runs `node --test`). Single file e.g. `node --test orchestrator/intent/ask.test.js`.

---

## File Structure
- `orchestrator/intent/ask.js` (create) — local knowledge-question matcher.
- `orchestrator/intent/ask.test.js` (create).
- `orchestrator/intent/pc.js` (modify) — add "look up" to the search matcher.
- `orchestrator/intent/pc.test.js` (modify) — look-up test.
- `orchestrator/intent/persona.js` (create) — control-confirmation quips.
- `orchestrator/intent/persona.test.js` (create).
- `orchestrator/intent/knowledge.js` (create) — Gemini knowledge answer (JARVIS voice).
- `orchestrator/intent/knowledge.test.js` (create).
- `orchestrator/intent/gemini.js` (rewrite) — full-vocabulary classifier.
- `orchestrator/intent/gemini.test.js` (modify) — new-domain tests.
- `orchestrator/intent/index.js` (modify) — add `ask` to the cascade.
- `orchestrator/intent/index.test.js` (modify) — cascade order test.
- `orchestrator/router.js` (modify) — `ask`→knowledge; persona wrapper.
- `orchestrator/router.test.js` (modify) — ask + persona tests.
- `orchestrator/server.js` (modify) — construct/inject knowledge+persona; raw-command shell.
- `orchestrator/server.test.js` (modify) — Gemini-proposed shell command through confirm.

---

## Task 1: `intent/ask.js` — knowledge-question matcher

**Files:** Create `orchestrator/intent/ask.js`, `orchestrator/intent/ask.test.js`.

- [ ] **Step 1: Write the failing test** — create `orchestrator/intent/ask.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAsk } from './ask.js';

test('knowledge triggers -> ask intent with the query', () => {
  assert.deepEqual(matchAsk('find out about the james webb telescope'),
    { domain: 'ask', query: 'the james webb telescope' });
  assert.deepEqual(matchAsk('tell me about quantum computing'),
    { domain: 'ask', query: 'quantum computing' });
  assert.deepEqual(matchAsk('what is a black hole'),
    { domain: 'ask', query: 'a black hole' });
  assert.deepEqual(matchAsk('who is ada lovelace'),
    { domain: 'ask', query: 'ada lovelace' });
  assert.deepEqual(matchAsk("what's the speed of light"),
    { domain: 'ask', query: 'the speed of light' });
});

test('strips a leading "jarvis," and trailing punctuation', () => {
  assert.deepEqual(matchAsk('jarvis, find out about mars?'),
    { domain: 'ask', query: 'mars' });
});

test('control commands and bare triggers do NOT match', () => {
  assert.equal(matchAsk('turn off the tubelight'), null);
  assert.equal(matchAsk('play daft punk'), null);
  assert.equal(matchAsk('search for cats'), null);
  assert.equal(matchAsk('what is'), null);   // no topic
  assert.equal(matchAsk(''), null);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/ask.test.js`. FAIL (no `./ask.js`).

- [ ] **Step 3: Implement** — create `orchestrator/intent/ask.js`:

```js
// Local matcher for spoken knowledge questions -> { domain:'ask', query }.
// Deliberately a small explicit trigger set so it never swallows control
// commands (which are matched earlier in the cascade anyway). Questions
// phrased without a trigger still get caught by the Gemini brain.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRIGGERS = [
  /^find out about\s+(.+)$/,
  /^tell me about\s+(.+)$/,
  /^what(?:'s| is| are)\s+(.+)$/,
  /^who(?:'s| is| are)\s+(.+)$/,
];

export function matchAsk(text) {
  const norm = normalize(text);
  if (!norm) return null;
  for (const re of TRIGGERS) {
    const m = norm.match(re);
    if (m && m[1].trim()) return { domain: 'ask', query: m[1].trim() };
  }
  return null;
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/ask.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/ask.js orchestrator/intent/ask.test.js
git commit -m "intent: ask.js — local knowledge-question matcher"
```

---

## Task 2: `pc.js` — "look up" → web search

**Files:** Modify `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`.

- [ ] **Step 1: Add the failing test** — in `orchestrator/intent/pc.test.js`, in the browser.search section, add:

```js
test('"look up <topic>" routes to browser.search (web)', () => {
  assert.deepEqual(matchPcCommand('look up the weather'),
    { domain:'pc', action:'browser', op:'search', arg:'the weather' });
  assert.deepEqual(matchPcCommand('look up risc-v'),
    { domain:'pc', action:'browser', op:'search', arg:'risc-v' });
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/pc.test.js`. FAIL (look up not matched).

- [ ] **Step 3: Implement** — in `orchestrator/intent/pc.js`, change the search matcher line:

```js
  // search/look up <topic> -> browser.search
  const sQ = norm.match(/^(?:search(?:\s+(?:about|for))?|look\s+up)\s+(.+)$/);
```

(The existing block body — the `topic !== 'about' && topic !== 'for'` guard and the returned intent — stays unchanged.)

- [ ] **Step 4: Run** — `node --test orchestrator/intent/pc.test.js`. All pass (existing search tests still green).

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent: 'look up <q>' routes to web search alongside 'search <q>'"
```

---

## Task 3: `intent/persona.js` — control quips

**Files:** Create `orchestrator/intent/persona.js`, `orchestrator/intent/persona.test.js`.

- [ ] **Step 1: Write the failing test** — create `orchestrator/intent/persona.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phrase } from './persona.js';

test('switch on/off get a witty line', () => {
  assert.equal(phrase({ domain:'switch', action:'off', target:'tubelight' }), 'Tubelight powered down.');
  assert.equal(phrase({ domain:'switch', action:'on', target:'rgb light' }), 'Rgb light online.');
});

test('all_off / all_on get signature lines', () => {
  assert.equal(phrase({ domain:'switch', action:'all_off' }), 'Powering down. Good night, sir.');
  assert.equal(phrase({ domain:'switch', action:'all_on' }), 'Everything is online.');
});

test('play_music gets a quip', () => {
  assert.equal(phrase({ domain:'pc', action:'media', op:'play_music', arg:'x' }), 'Spinning it up.');
});

test('intents without a quip return null', () => {
  assert.equal(phrase({ domain:'switch', action:'status', target:'tubelight' }), null);
  assert.equal(phrase({ domain:'pc', action:'open_app', target:'firefox' }), null);
  assert.equal(phrase(null), null);
  assert.equal(phrase({ domain:'ask', query:'x' }), null);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/persona.test.js`. FAIL (no `./persona.js`).

- [ ] **Step 3: Implement** — create `orchestrator/intent/persona.js`:

```js
// Offline persona quips for control confirmations. phrase(intent) -> a witty
// line for a recognised control success, or null to keep the plain response.
// Small and curated on purpose; no API calls.

function cap(s) {
  return String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);
}

export function phrase(intent) {
  if (!intent) return null;
  const { domain, action, target } = intent;
  if (domain === 'switch') {
    if (action === 'all_off') return 'Powering down. Good night, sir.';
    if (action === 'all_on') return 'Everything is online.';
    if (action === 'off' && target) return `${cap(target)} powered down.`;
    if (action === 'on' && target) return `${cap(target)} online.`;
  }
  if (domain === 'pc' && action === 'media' && intent.op === 'play_music') {
    return 'Spinning it up.';
  }
  return null;
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/persona.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/persona.js orchestrator/intent/persona.test.js
git commit -m "intent: persona.js — offline witty control confirmations"
```

---

## Task 4: `intent/knowledge.js` — JARVIS-voice answers

**Files:** Create `orchestrator/intent/knowledge.js`, `orchestrator/intent/knowledge.test.js`.

- [ ] **Step 1: Write the failing test** — create `orchestrator/intent/knowledge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKnowledge } from './knowledge.js';

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
}

test('answer returns the spoken text, ok:true', async () => {
  const k = makeKnowledge({ apiKey: 'x', fetchFn: fakeFetch('The Webb telescope observes in infrared.') });
  const r = await k.answer('the webb telescope');
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'The Webb telescope observes in infrared.');
});

test('prompt carries the JARVIS persona + the query', async () => {
  let body;
  const k = makeKnowledge({ apiKey: 'x', fetchFn: async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; } });
  await k.answer('black holes');
  const sys = body.systemInstruction.parts[0].text;
  assert.match(sys, /JARVIS/);
  assert.match(sys, /sir/i);
  assert.equal(body.contents[0].parts[0].text, 'black holes');
});

test('no apiKey -> graceful in-character line, ok:true, fetch not called', async () => {
  let called = false;
  const k = makeKnowledge({ apiKey: '', fetchFn: async () => { called = true; return {}; } });
  const r = await k.answer('x');
  assert.equal(r.ok, true);
  assert.match(r.speak, /knowledge base/i);
  assert.equal(called, false);
});

test('HTTP error / non-JSON / throw -> graceful fallback, ok:true', async () => {
  for (const ff of [
    fakeFetch('x', { ok: false, status: 500 }),
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
    async () => { throw new Error('down'); },
  ]) {
    const r = await makeKnowledge({ apiKey: 'x', fetchFn: ff }).answer('q');
    assert.equal(r.ok, true);
    assert.match(r.speak, /apolog|knowledge base/i);
  }
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/knowledge.test.js`. FAIL (no `./knowledge.js`).

- [ ] **Step 3: Implement** — create `orchestrator/intent/knowledge.js`:

```js
// Knowledge answers in the Stark-JARVIS voice. One Gemini call, warm temperature,
// concise spoken output. Never throws; degrades to an in-character apology.
import { config } from '../config.js';

const PERSONA = [
  "You are JARVIS, Tony Stark's AI assistant.",
  'Answer the user\'s question in 2 to 4 spoken sentences: technically precise, concise, and dryly witty.',
  'Plain text only — no markdown, no bullet lists — it will be read aloud by text-to-speech.',
  "Address the user as 'sir' at most once, and only when it feels natural.",
].join(' ');

const OFFLINE = "I'm afraid my knowledge base is offline at the moment, sir.";
const FAILED = "My apologies, sir — I can't reach my knowledge base right now.";

export function makeKnowledge({
  apiKey = config.geminiApiKey,
  fetchFn = globalThis.fetch,
  model = 'gemini-2.5-flash',
  timeoutMs = 9000,
} = {}) {
  return {
    async answer(query) {
      const q = String(query ?? '').trim();
      if (!apiKey) return { ok: true, speak: OFFLINE };
      try {
        const res = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: PERSONA }] },
              contents: [{ parts: [{ text: q }] }],
              generationConfig: { temperature: 0.7 },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!res.ok) return { ok: true, speak: FAILED };
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) return { ok: true, speak: FAILED };
        return { ok: true, speak: String(raw).trim() };
      } catch {
        return { ok: true, speak: FAILED };
      }
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/knowledge.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/knowledge.js orchestrator/intent/knowledge.test.js
git commit -m "intent: knowledge.js — Stark-JARVIS voice answers via Gemini"
```

---

## Task 5: `intent/gemini.js` — full-vocabulary brain

**Files:** Modify `orchestrator/intent/gemini.js`, `orchestrator/intent/gemini.test.js`.

Window ops are deliberately excluded (broken on Wayland — separate cycle).

- [ ] **Step 1: Add failing tests** — APPEND to `orchestrator/intent/gemini.test.js` (the existing switch tests stay; update `VOCAB` near the top to include apps):

Change the top `const VOCAB = ...` line to:
```js
const VOCAB = { deviceNames: ['tubelight', 'socket'], groupNames: ['lights'], appNames: ['firefox', 'visual studio code'] };
```
Then append:
```js
test('emits a pc open_app for a known app', async () => {
  const r = await geminiClassify('fire up the code editor', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"open_app","target":"visual studio code"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'open_app', target: 'visual studio code' });
});

test('open_app with an unknown app -> null', async () => {
  const r = await geminiClassify('open photoshop', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"open_app","target":"photoshop"}'),
  });
  assert.equal(r, null);
});

test('emits play_music with a query', async () => {
  const r = await geminiClassify('put on some daft punk', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"media","op":"play_music","arg":"daft punk"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'media', op: 'play_music', arg: 'daft punk' });
});

test('emits a web search', async () => {
  const r = await geminiClassify('google the weather', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"browser","op":"search","arg":"weather"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'browser', op: 'search', arg: 'weather' });
});

test('emits a proposed shell command (free-form)', async () => {
  const r = await geminiClassify('free up some disk space', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"shell","command":"apt clean"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'shell', command: 'apt clean' });
});

test('emits an ask intent for a question', async () => {
  const r = await geminiClassify('how far away is the moon', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"ask","query":"how far away is the moon"}'),
  });
  assert.deepEqual(r, { domain: 'ask', query: 'how far away is the moon' });
});

test('prompt lists app names and the action menu', async () => {
  let body;
  await geminiClassify('do something', VOCAB, {
    apiKey: 'x',
    fetchFn: async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action":"none"}' }] } }] }) }; },
  });
  const prompt = body.contents[0].parts[0].text;
  assert.match(prompt, /visual studio code/);
  assert.match(prompt, /open_app/);
  assert.match(prompt, /play_music/);
  assert.match(prompt, /shell/);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/gemini.test.js`. FAIL (new domains rejected by old validator).

- [ ] **Step 3: Rewrite `orchestrator/intent/gemini.js`** entirely:

```js
import { config } from '../config.js';

const SWITCH_ACTIONS = new Set(['on', 'off', 'all_off', 'all_on', 'status', 'keep_only']);

function buildPrompt(text, vocab) {
  const devices = (vocab?.deviceNames ?? []).join(', ');
  const groups = (vocab?.groupNames ?? []).join(', ');
  const apps = (vocab?.appNames ?? []).join(', ');
  return [
    'You are the intent router for a voice assistant. Map the command to ONE JSON object. Respond with ONLY JSON, no prose.',
    'Choose the best match from these shapes:',
    '- Lights/fans/socket on or off: {"domain":"switch","action":"on|off","target":"<device or group>"}.',
    '- Everything off / everything on: {"domain":"switch","action":"all_off"} or {"domain":"switch","action":"all_on"}.',
    '- One device state question: {"domain":"switch","action":"status","target":"<device>"}.',
    '- Keep one on, rest off: {"domain":"switch","action":"keep_only","target":"<device or group>"}.',
    '- Launch an application: {"domain":"pc","action":"open_app","target":"<one of the app names>"}.',
    '- Play a song: {"domain":"pc","action":"media","op":"play_music","arg":"<song or artist>"}.',
    '- Pause/resume music: {"domain":"pc","action":"media","op":"play_pause"}. Stop music: {"domain":"pc","action":"media","op":"stop_music"}.',
    '- Web search: {"domain":"pc","action":"browser","op":"search","arg":"<query>"}.',
    '- Run a system task: {"domain":"pc","action":"shell","command":"<a single safe shell command>"} (it will be confirmed before running).',
    '- Answer a general question: {"domain":"ask","query":"<the question>"}.',
    '- Nothing fits: {"action":"none"}.',
    `Valid devices: ${devices}.`,
    `Valid groups: ${groups}.`,
    `Valid app names (use one of these exactly for open_app): ${apps}.`,
    'Infer the closest valid device/app for spelling mistakes and phonetic STT slips (e.g. "lites"->"lights", "vs code"->"visual studio code").',
    'The switch target and open_app target MUST be exactly one of the valid values listed. shell.command and ask.query are free text.',
    `Command: ${text}`,
  ].join('\n');
}

function validate(obj, vocab) {
  if (!obj || typeof obj !== 'object') return null;
  const devices = vocab?.deviceNames ?? [];
  const groups = vocab?.groupNames ?? [];
  const apps = vocab?.appNames ?? [];

  // ask
  if (obj.domain === 'ask') {
    return typeof obj.query === 'string' && obj.query.trim()
      ? { domain: 'ask', query: obj.query.trim() } : null;
  }

  // pc
  if (obj.domain === 'pc') {
    if (obj.action === 'open_app') {
      return typeof obj.target === 'string' && apps.includes(obj.target)
        ? { domain: 'pc', action: 'open_app', target: obj.target } : null;
    }
    if (obj.action === 'media') {
      if (obj.op === 'play_music') {
        return typeof obj.arg === 'string' && obj.arg.trim()
          ? { domain: 'pc', action: 'media', op: 'play_music', arg: obj.arg.trim() } : null;
      }
      if (obj.op === 'play_pause' || obj.op === 'stop_music') {
        return { domain: 'pc', action: 'media', op: obj.op };
      }
      return null;
    }
    if (obj.action === 'browser' && obj.op === 'search') {
      return typeof obj.arg === 'string' && obj.arg.trim()
        ? { domain: 'pc', action: 'browser', op: 'search', arg: obj.arg.trim() } : null;
    }
    if (obj.action === 'shell') {
      return typeof obj.command === 'string' && obj.command.trim()
        ? { domain: 'pc', action: 'shell', command: obj.command.trim() } : null;
    }
    return null;
  }

  // switch (default domain when action is a switch action)
  const action = obj.action;
  if (!SWITCH_ACTIONS.has(action)) return null;
  if (action === 'all_off') return { domain: 'switch', action: 'all_off' };
  if (action === 'all_on') return { domain: 'switch', action: 'all_on' };
  const target = obj.target;
  if (typeof target !== 'string') return null;
  if (action === 'status') {
    return devices.includes(target) ? { domain: 'switch', action: 'status', target } : null;
  }
  return devices.includes(target) || groups.includes(target)
    ? { domain: 'switch', action, target } : null;
}

// Classify a command with Gemini. Returns a validated intent or null, never throws.
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

- [ ] **Step 4: Run** — `node --test orchestrator/intent/gemini.test.js`. All pass (old switch tests + new). The pre-existing `prompt asks Gemini to recover obvious STT slips` test asserts `/spelling mistakes/` and `/"lites" means "lights"/`. The new prompt says `spelling mistakes` and `"lites"->"lights"` — UPDATE that one existing test's second assertion to `assert.match(prompt, /"lites"->"lights"/)` to match the new wording (keep the `/spelling mistakes/` assertion).

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/gemini.js orchestrator/intent/gemini.test.js
git commit -m "intent: Gemini brain classifies the full vocabulary (pc/shell/ask), not just switches"
```

---

## Task 6: cascade — slot `ask` into `intent/index.js`

**Files:** Modify `orchestrator/intent/index.js`, `orchestrator/intent/index.test.js`.

- [ ] **Step 1: Add the failing test** — in `orchestrator/intent/index.test.js`, add:

```js
test('cascade matches a knowledge question locally as ask (before Gemini)', async () => {
  let geminiCalled = false;
  const { intent, via } = await parseWithSource('find out about mars', {}, async () => { geminiCalled = true; return null; });
  assert.deepEqual(intent, { domain: 'ask', query: 'mars' });
  assert.equal(via, 'rules');
  assert.equal(geminiCalled, false);
});
```

(Confirm `parseWithSource` is imported in this test file; if not, add it to the import from `./index.js`.)

- [ ] **Step 2: Run** — `node --test orchestrator/intent/index.test.js`. FAIL (ask not in cascade).

- [ ] **Step 3: Implement** — in `orchestrator/intent/index.js`:

Add the import:
```js
import { matchAsk } from './ask.js';
```
Insert `ask` into the cascade in `parseWithSource`, AFTER pc and BEFORE confirm:
```js
  const a = matchAsk(text);
  if (a) return { intent: a, via: 'rules' };
```
(So the order is: switch → pc → ask → confirm → Gemini. Update the cascade comment accordingly.)

- [ ] **Step 4: Run** — `node --test orchestrator/intent/index.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "intent: slot ask into the cascade (switch -> pc -> ask -> confirm -> gemini)"
```

---

## Task 7: router — `ask`→knowledge + persona post-process

**Files:** Modify `orchestrator/router.js`, `orchestrator/router.test.js`.

- [ ] **Step 1: Add failing tests** — in `orchestrator/router.test.js`, add:

```js
test('ask -> knowledge.answer', async () => {
  const calls = [];
  const knowledge = { answer: async (q) => { calls.push(q); return { ok: true, speak: 'A black hole is...' }; } };
  const res = await route({ domain: 'ask', query: 'black holes' }, { board: fakeBoard(), registry, knowledge });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'A black hole is...');
  assert.deepEqual(calls, ['black holes']);
});

test('persona overrides a successful switch confirmation', async () => {
  const persona = { phrase: (i) => (i.action === 'off' ? 'Tubelight powered down.' : null) };
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' },
    { board: fakeBoard(), registry, persona });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'Tubelight powered down.');
});

test('persona does not touch a failed result', async () => {
  const persona = { phrase: () => 'should not be used' };
  // unreachable board -> set throws -> ok:false
  const board = { ...fakeBoard(), set: async () => { throw new Error('offline'); } };
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board, registry, persona });
  assert.equal(res.ok, false);
  assert.notEqual(res.speak, 'should not be used');
});
```

(Use the file's existing `fakeBoard`/`registry` pattern; adapt `board.set` override to however `fakeBoard` is shaped.)

- [ ] **Step 2: Run** — `node --test orchestrator/router.test.js`. FAIL (no ask/persona).

- [ ] **Step 3: Implement** — in `orchestrator/router.js`:

(a) Rename the current `export async function route(intent, deps = {})` to an internal `async function _route(intent, deps = {})` (keep its whole body unchanged), then add `knowledge` and `persona` to the deps destructure of `_route` and an `ask` branch at the TOP of `_route` (alongside the other `intent.domain` checks):

```js
async function _route(intent, { board, registry, openApp, media, window: win, browser, music, knowledge } = {}) {
  if (intent.domain === 'ask') {
    if (!knowledge) return { ok: false, speak: 'Knowledge capability not configured.' };
    return knowledge.answer(intent.query);
  }
  // ... existing body (pc domain, switch domain) unchanged ...
}
```

(b) Add a new exported wrapper that applies persona to a successful control result:

```js
export async function route(intent, deps = {}) {
  const result = await _route(intent, deps);
  if (result?.ok && deps?.persona) {
    const quip = deps.persona.phrase(intent);
    if (quip) return { ...result, speak: quip };
  }
  return result;
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/router.test.js` then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: ask -> knowledge.answer; persona quips on successful control results"
```

---

## Task 8: server — inject knowledge+persona; Gemini-proposed shell command

**Files:** Modify `orchestrator/server.js`, `orchestrator/server.test.js`.

- [ ] **Step 1: Add the failing test** — `orchestrator/server.test.js` has a `pipelineWith({ recipes, shellSpawnCalls })` helper returning a pipeline `p` with `p.setIntent(text, intent)` (maps a transcript to a fixed intent) and `p.onCommand(text)`; its fake `shell.execute(cmd)` pushes `cmd` to `shellSpawnCalls`. Add this test using that harness (recipes empty so only the raw-command path can produce a command):

```js
test('pipeline: a Gemini-proposed raw shell command is gated then executed', async () => {
  const sh = [];
  const p = pipelineWith({ recipes: {}, shellSpawnCalls: sh });
  p.setIntent('free up disk space', { domain: 'pc', action: 'shell', command: 'apt clean' });
  p.setIntent('confirm', { domain: 'confirm', action: 'yes' });
  const r1 = await p.onCommand('free up disk space');
  assert.match(r1.speak, /should i run apt clean/i);
  const r2 = await p.onCommand('confirm');
  assert.deepEqual(sh, ['apt clean']);
  assert.match(r2.speak, /running apt clean/i);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/server.test.js`. FAIL (raw command not handled; pipeline still only does `shell.lookup`).

- [ ] **Step 3: Implement** — in `orchestrator/server.js`:

(a) In `makePipeline`, the shell branch currently does `const cmd = shell?.lookup?.(intent.target);`. Replace that resolution so a Gemini-proposed `command` is used directly:
```js
    if (intent?.domain === 'pc' && intent.action === 'shell') {
      const cmd = intent.command ? String(intent.command).trim() : shell?.lookup?.(intent.target);
      if (!cmd) { pending = null; return log(text, intent, via, false, `I don't have a recipe called ${intent.target}.`); }
      pending = { command: cmd, expiresAt: now() + ttlMs };
      return log(text, intent, via, true, `Should I run ${cmd}? Say confirm to run.`);
    }
```

(b) Construct and inject `knowledge` + `persona`. Add imports near the other intent imports at the top of server.js:
```js
import { makeKnowledge } from './intent/knowledge.js';
import * as persona from './intent/persona.js';
```
Add `knowledge = null, persona = null,` to the `makePipeline({...})` destructure params, and pass them into BOTH `route(...)` calls (inside makePipeline and the boot-level one):
```js
    const { ok, speak } = await route(intent, { board: esp32, registry, openApp, media, win, browser, music, knowledge, persona });
```
In the boot section construct it:
```js
  const knowledge = makeKnowledge();
```
and add `knowledge, persona,` to the `makePipeline({ ... })` invocation object, and `knowledge, persona` to the boot-level `route(...)` call.

- [ ] **Step 4: Run** — `node --test orchestrator/server.test.js` then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "server: inject knowledge+persona into routing; gate Gemini-proposed shell commands"
```

---

## Task 9: full suite, checkpoint, finish

**Files:** none code (verification); `CHECKPOINT.md`.

- [ ] **Step 1: Full suite** — `npm test`. All pass. Confirm no `via:'gemini'` regression and the cascade still ends in Gemini.

- [ ] **Step 2: Update CHECKPOINT.md** — add a dated TL;DR bullet: Gemini is now the full-vocabulary brain (switch/open/play/search/shell-command/ask, not switch-only); "find out about X" → JARVIS-voice knowledge answer (`knowledge.js`); "look up/search X" → web; offline persona quips for control; Gemini-proposed shell commands run only after spoken confirm. Note window ops intentionally excluded (Wayland). Commit:
```bash
git add CHECKPOINT.md && git commit -m "checkpoint: JARVIS brain — generalized Gemini + knowledge answers + persona"
```

- [ ] **Step 3: Finish the branch** — use superpowers:finishing-a-development-branch to merge `jarvis-brain` into `main`.

- [ ] **Step 4: Hand off live e2e** (needs the user, mic + GEMINI_API_KEY set): the five checks in the spec §Verification — find-out answer, look-up opens Chrome, a missed command rescued by Gemini, a confirm-gated shell command, and a witty control confirmation.
