# JARVIS Phase 1 (Switch control, typed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /command {text}` so a typed transcript is parsed by a rule matcher, routed to the live ESP32 (idempotent `set`), logged, and answered with a spoken sentence — `{ok, speak, intent}`.

**Architecture:** Three small units behind the existing Express app: a pure `rules.js` matcher (`matchSwitchCommand(text, vocab)`), a thin `intent/index.js` `parse()` seam (Phase 4 adds Gemini here), and an async `router.js` (`route(intent, {board, registry})`) that does board ops + group expansion + status reads and builds the sentence. `server.js` gains `POST /command` via an injected `onCommand(text)` so HTTP stays thin and testable; `main()` composes the real `onCommand` (parse → route → log).

**Tech Stack:** Node 22 (ESM), Express 5, better-sqlite3, `node:test`. Builds directly on the Phase 0 orchestrator.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-phase1-switch-control-design.md`

**Plan note (DRY):** the spec lists a `getAllSwitchNames()` helper, but the existing
`getSwitchNamesByChannel()` already returns all 8 names ordered by channel — reuse it for the
matcher's `deviceNames` vocab instead of adding a redundant helper.

---

## File Structure

| Path | Change | Responsibility |
|------|--------|----------------|
| `orchestrator/db/registry.js` | modify | add `getGroupNames()`, `getSwitchNamesByGroup()`, `logCommand()` |
| `orchestrator/db/registry.test.js` | modify | tests for the three new helpers |
| `orchestrator/intent/rules.js` | create | `matchSwitchCommand(text, vocab) → intent \| null` (pure) |
| `orchestrator/intent/rules.test.js` | create | matcher behavior per the spec's examples table |
| `orchestrator/intent/index.js` | create | `parse(text, vocab)` — delegates to the matcher |
| `orchestrator/intent/index.test.js` | create | delegation seam |
| `orchestrator/router.js` | create | `route(intent, {board, registry}) → {ok, speak}` (async) |
| `orchestrator/router.test.js` | create | fake board + in-memory registry |
| `orchestrator/server.js` | modify | `express.json()` + `POST /command`; `main()` composes `onCommand` |
| `orchestrator/server.test.js` | modify | `POST /command` wiring + 400 on missing text |

---

## Task 1: Registry helpers (TDD)

**Files:**
- Modify: `orchestrator/db/registry.js`
- Test: `orchestrator/db/registry.test.js`

- [ ] **Step 1: Add the failing tests** — append to `orchestrator/db/registry.test.js`:

```js
test('getGroupNames returns the distinct groups', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getGroupNames(), ['fans', 'lights', 'other']);
  reg.close();
});

test('getSwitchNamesByGroup returns members ordered by channel', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getSwitchNamesByGroup('lights'), [
    'tubelight', 'spotlight', 'rgb light', 'night light',
  ]);
  assert.deepEqual(reg.getSwitchNamesByGroup('fans'), ['fan 1', 'fan 2']);
  reg.close();
});

test('logCommand inserts a row (intent serialized as JSON, null stays null)', () => {
  const reg = openTestRegistry();
  reg.logCommand({
    raw_text: 'turn off the tubelight',
    intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    ok: 1,
    detail: 'Tubelight is off.',
  });
  reg.logCommand({ raw_text: 'gibberish', intent: null, ok: 0, detail: 'no match' });
  const rows = reg._db.prepare('SELECT raw_text, intent, ok, detail FROM command_log ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    raw_text: 'turn off the tubelight',
    intent: '{"domain":"switch","action":"off","target":"tubelight"}',
    ok: 1,
    detail: 'Tubelight is off.',
  });
  assert.deepEqual(rows[1], { raw_text: 'gibberish', intent: null, ok: 0, detail: 'no match' });
  assert.equal(typeof reg._db.prepare('SELECT ts FROM command_log LIMIT 1').get().ts, 'string');
  reg.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/db/registry.test.js`
Expected: FAIL — `reg.getGroupNames is not a function`.

- [ ] **Step 3: Add the helpers** — in `orchestrator/db/registry.js`, extend the object returned by `openRegistry` (add the three methods alongside the existing `getBoard`/`getSwitchNamesByChannel`/`close`/`_db`):

```js
    getGroupNames: () =>
      db
        .prepare("SELECT DISTINCT group_name FROM switches WHERE group_name IS NOT NULL ORDER BY group_name")
        .all()
        .map((r) => r.group_name),
    getSwitchNamesByGroup: (group) =>
      db
        .prepare('SELECT name FROM switches WHERE group_name = ? ORDER BY channel')
        .all(group)
        .map((r) => r.name),
    logCommand: ({ raw_text, intent, ok, detail }) =>
      db
        .prepare('INSERT INTO command_log (ts, raw_text, intent, ok, detail) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), raw_text, intent == null ? null : JSON.stringify(intent), ok, detail),
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test orchestrator/db/registry.test.js`
Expected: PASS — 8 tests (5 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/db/registry.js orchestrator/db/registry.test.js
git commit -m "Add registry helpers: group lookup + command logging"
```

---

## Task 2: Intent layer — matcher + parse seam (TDD)

**Files:**
- Create: `orchestrator/intent/rules.js`, `orchestrator/intent/rules.test.js`
- Create: `orchestrator/intent/index.js`, `orchestrator/intent/index.test.js`

- [ ] **Step 1: Write the failing matcher test** — `orchestrator/intent/rules.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSwitchCommand } from './rules.js';

const VOCAB = {
  deviceNames: ['fan 1', 'fan 2', 'tubelight', 'spotlight', 'rgb light', 'night light', 'socket', 'spare'],
  groupNames: ['lights', 'fans'],
};
const m = (text) => matchSwitchCommand(text, VOCAB);

test('device off', () => {
  assert.deepEqual(m('turn off the tubelight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('device on, multi-word name', () => {
  assert.deepEqual(m('turn on fan 1'), { domain: 'switch', action: 'on', target: 'fan 1' });
});
test('group off', () => {
  assert.deepEqual(m('lights off'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('group on', () => {
  assert.deepEqual(m('fans on'), { domain: 'switch', action: 'on', target: 'fans' });
});
test('"all lights off" is the group, not all_off', () => {
  assert.deepEqual(m('all lights off'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('all_off via everything', () => {
  assert.deepEqual(m('everything off'), { domain: 'switch', action: 'all_off' });
});
test('all_off via all', () => {
  assert.deepEqual(m('all off'), { domain: 'switch', action: 'all_off' });
});
test('multi-word device not confused with group', () => {
  assert.deepEqual(m('turn off the night light'), { domain: 'switch', action: 'off', target: 'night light' });
});
test('status question', () => {
  assert.deepEqual(m('is the tubelight on?'), { domain: 'switch', action: 'status', target: 'tubelight' });
});
test('wake word is stripped', () => {
  assert.deepEqual(m('jarvis, turn off the tubelight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('gibberish is null', () => {
  assert.equal(m('make me a sandwich'), null);
});
test('"everything on" is null (no all_on)', () => {
  assert.equal(m('everything on'), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/intent/rules.test.js`
Expected: FAIL — cannot find module `./rules.js`.

- [ ] **Step 3: Write the matcher** — `orchestrator/intent/rules.js`:

```js
// Pure rule-based matcher for the switch domain. No I/O.
// `vocab` = { deviceNames: string[], groupNames: string[] } injected from the registry.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whole-token containment, so "fans" never matches inside "fan 1" and vice versa.
// `needle` may contain spaces (e.g. "rgb light").
function containsTarget(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?:$| )`).test(haystack);
}

function findTarget(norm, deviceNames, groupNames) {
  const candidates = [...deviceNames, ...groupNames]
    .filter((name) => containsTarget(norm, name))
    .sort((a, b) => b.length - a.length); // longest wins ("night light" over "light")
  return candidates[0] ?? null;
}

export function matchSwitchCommand(text, vocab) {
  const raw = String(text ?? '');
  const isQuestion = raw.includes('?');
  const norm = normalize(raw);
  if (!norm) return null;

  const { deviceNames = [], groupNames = [] } = vocab ?? {};
  const target = findTarget(norm, deviceNames, groupNames);

  // Status query (question form) — single device only.
  if (isQuestion || /^(is|are)\b/.test(norm)) {
    if (target && deviceNames.includes(target)) {
      return { domain: 'switch', action: 'status', target };
    }
    return null;
  }

  // on / off action (whole word).
  let action = null;
  if (/\boff\b/.test(norm)) action = 'off';
  else if (/\bon\b/.test(norm)) action = 'on';
  if (!action) return null;

  if (target) return { domain: 'switch', action, target };
  if (action === 'off' && /\b(all|everything)\b/.test(norm)) {
    return { domain: 'switch', action: 'all_off' };
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test orchestrator/intent/rules.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 5: Write the failing parse-seam test** — `orchestrator/intent/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './index.js';

const VOCAB = {
  deviceNames: ['tubelight'],
  groupNames: ['lights'],
};

test('parse delegates to the rule matcher', () => {
  assert.deepEqual(parse('turn off the tubelight', VOCAB), {
    domain: 'switch', action: 'off', target: 'tubelight',
  });
});
test('parse returns null for unmatched input', () => {
  assert.equal(parse('make me a sandwich', VOCAB), null);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test orchestrator/intent/index.test.js`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 7: Write the parse seam** — `orchestrator/intent/index.js`:

```js
import { matchSwitchCommand } from './rules.js';

// Parse a command transcript into an intent. Phase 1: rule matcher only.
// Phase 4 will add a Gemini fallback here when matchSwitchCommand returns null.
export function parse(text, vocab) {
  return matchSwitchCommand(text, vocab);
}
```

- [ ] **Step 8: Run to verify pass**

Run: `node --test orchestrator/intent/index.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 9: Commit**

```bash
git add orchestrator/intent/rules.js orchestrator/intent/rules.test.js orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "Add switch-domain rule matcher and parse seam"
```

---

## Task 3: Router (TDD)

**Files:**
- Create: `orchestrator/router.js`, `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing test** — `orchestrator/router.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRegistry } from './db/registry.js';
import { route } from './router.js';

function reg() {
  return openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://test' });
}

function fakeBoard({ states = {}, throwOnSet = false } = {}) {
  return {
    calls: [],
    allOffCalled: false,
    async set(name, on) {
      if (throwOnSet) throw new Error('unreachable');
      this.calls.push([name, on]);
    },
    async allOff() {
      this.allOffCalled = true;
    },
    isOn(name) {
      return states[name];
    },
  };
}

test('device off calls set(false) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board, registry });
  assert.deepEqual(board.calls, [['tubelight', false]]);
  assert.deepEqual(res, { ok: true, speak: 'Tubelight is off.' });
  registry.close();
});

test('device on calls set(true) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'on', target: 'fan 1' }, { board, registry });
  assert.deepEqual(board.calls, [['fan 1', true]]);
  assert.deepEqual(res, { ok: true, speak: 'Fan 1 is on.' });
  registry.close();
});

test('group off expands to all members ordered by channel', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'lights' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['tubelight', false], ['spotlight', false], ['rgb light', false], ['night light', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Lights are off.' });
  registry.close();
});

test('all_off calls board.allOff', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'all_off' }, { board, registry });
  assert.equal(board.allOffCalled, true);
  assert.deepEqual(res, { ok: true, speak: 'Everything is off.' });
  registry.close();
});

test('status reflects cached state', async () => {
  const registry = reg();
  const on = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: true } }), registry });
  assert.deepEqual(on, { ok: true, speak: 'The tubelight is on.' });
  const off = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: false } }), registry });
  assert.deepEqual(off, { ok: true, speak: 'The tubelight is off.' });
  registry.close();
});

test('status before first poll is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: {} }), registry });
  assert.deepEqual(res, { ok: true, speak: "I haven't reached the smart switch yet." });
  registry.close();
});

test('unreachable board yields the error sentence', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board: fakeBoard({ throwOnSet: true }), registry });
  assert.deepEqual(res, { ok: false, speak: "I couldn't reach the smart switch." });
  registry.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/router.test.js`
Expected: FAIL — cannot find module `./router.js`.

- [ ] **Step 3: Write the router** — `orchestrator/router.js`:

```js
// Turns an intent into board actions and a spoken sentence.
// `board` is an Esp32Switch (set/allOff throw when unreachable; isOn is cached).

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function route(intent, { board, registry }) {
  try {
    if (intent.action === 'all_off') {
      await board.allOff();
      return { ok: true, speak: 'Everything is off.' };
    }

    if (intent.action === 'status') {
      const state = board.isOn(intent.target);
      if (state === undefined) {
        return { ok: true, speak: "I haven't reached the smart switch yet." };
      }
      return { ok: true, speak: `The ${intent.target} is ${state ? 'on' : 'off'}.` };
    }

    // on / off
    const on = intent.action === 'on';
    if (registry.getGroupNames().includes(intent.target)) {
      for (const name of registry.getSwitchNamesByGroup(intent.target)) {
        await board.set(name, on);
      }
      return { ok: true, speak: `${capitalize(intent.target)} are ${on ? 'on' : 'off'}.` };
    }
    await board.set(intent.target, on);
    return { ok: true, speak: `${capitalize(intent.target)} is ${on ? 'on' : 'off'}.` };
  } catch {
    return { ok: false, speak: "I couldn't reach the smart switch." };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test orchestrator/router.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "Add router: switch on/off, groups, all_off, status, unreachable"
```

---

## Task 4: POST /command endpoint + wiring (TDD)

**Files:**
- Modify: `orchestrator/server.js`
- Test: `orchestrator/server.test.js`

- [ ] **Step 1: Add the failing endpoint tests** — append to `orchestrator/server.test.js`:

```js
test('POST /command returns the onCommand result as JSON', async () => {
  const onCommand = async (text) => ({
    ok: true,
    speak: `got: ${text}`,
    intent: { domain: 'switch', action: 'off', target: 'tubelight' },
  });
  const server = buildApp({ esp32: stubEsp32({}), onCommand }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'turn off the tubelight' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      speak: 'got: turn off the tubelight',
      intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    });
  } finally {
    server.close();
  }
});

test('POST /command with missing text returns 400', async () => {
  const onCommand = async () => {
    throw new Error('onCommand should not be called for missing text');
  };
  const server = buildApp({ esp32: stubEsp32({}), onCommand }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, speak: "Sorry, I didn't catch that.", intent: null });
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/server.test.js`
Expected: FAIL — `/command` returns 404 (route not defined), so the assertions fail.

- [ ] **Step 3: Update `server.js`** — replace the whole file with:

```js
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';
import { parse } from './intent/index.js';
import { route } from './router.js';

// Pure factory — no network, no DB. Takes its dependencies so it is trivially testable.
// `onCommand(text)` resolves to { ok, speak, intent }.
export function buildApp({ esp32, onCommand }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Debug: current cached state of the smart switch (PROJECT.md §5.1).
  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  // Typed command transcript -> action -> spoken response.
  app.post('/command', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, speak: "Sorry, I didn't catch that.", intent: null });
    }
    res.json(await onCommand(text));
  });

  return app;
}

// Composition root: seed registry, wire the real board, poll, build the command pipeline, listen.
export function main() {
  assertEsp32Configured();
  const registry = openRegistry();
  const board = registry.getBoard();
  const esp32 = new Esp32Switch({
    baseUrl: board.base_url,
    names: registry.getSwitchNamesByChannel(),
  });

  esp32.on('online', () => console.log('[esp32] online'));
  esp32.on('offline', (err) => console.warn('[esp32] offline:', err?.message ?? err));
  esp32.on('change', (e) =>
    console.log(`[esp32] external change: ${e.name} -> ${e.on ? 'on' : 'off'}`),
  );
  esp32.startPolling();

  const vocab = {
    deviceNames: registry.getSwitchNamesByChannel(),
    groupNames: registry.getGroupNames().filter((g) => g !== 'other'),
  };

  const onCommand = async (text) => {
    const intent = parse(text, vocab);
    if (!intent) {
      registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
      return { ok: false, speak: "Sorry, I didn't catch that.", intent: null };
    }
    const { ok, speak } = await route(intent, { board: esp32, registry });
    registry.logCommand({ raw_text: text, intent, ok: ok ? 1 : 0, detail: speak });
    return { ok, speak, intent };
  };

  buildApp({ esp32, onCommand }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 4: Run the server tests**

Run: `node --test orchestrator/server.test.js`
Expected: PASS — 4 tests (`/health`, `/state`, `/command` ok, `/command` 400).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures — config (2), registry (8), rules (12), index (2), router (7), server (4) = 35 tests.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "Add POST /command: parse -> route -> log pipeline"
```

---

## Task 5: Live acceptance against the real board

> Verification only — no commit. Confirms the typed-command path flips real relays. Watch the lights.

- [ ] **Step 1: Boot, fire a sequence of commands, stop**

Run:
```bash
npm start > /tmp/jarvis-p1.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:3000/health >/dev/null 2>&1 && break; sleep 0.3; done
sleep 1   # let the first poll populate cached state
post() { curl -s -X POST localhost:3000/command -H 'content-type: application/json' -d "$1"; echo; }
echo "-- off tubelight --";  post '{"text":"turn off the tubelight"}'
echo "-- on tubelight --";   post '{"text":"turn on the tubelight"}'
echo "-- lights off --";     post '{"text":"lights off"}'
echo "-- status --";         post '{"text":"is the tubelight on?"}'
echo "-- everything off --"; post '{"text":"everything off"}'
echo "-- gibberish --";      post '{"text":"make me a sandwich"}'
pkill -f "orchestrator/server.js"
```

Expected (relays physically change; responses like):
```
-- off tubelight --   {"ok":true,"speak":"Tubelight is off.","intent":{"domain":"switch","action":"off","target":"tubelight"}}
-- on tubelight --    {"ok":true,"speak":"Tubelight is on.","intent":{...}}
-- lights off --      {"ok":true,"speak":"Lights are off.","intent":{...}}
-- status --          {"ok":true,"speak":"The tubelight is off.","intent":{...}}
-- everything off --  {"ok":true,"speak":"Everything is off.","intent":{...}}
-- gibberish --       {"ok":false,"speak":"Sorry, I didn't catch that.","intent":null}
```

---

## Task 6: Update CHECKPOINT.md

**Files:**
- Modify: `CHECKPOINT.md`

- [ ] **Step 1: Tick the Phase 1 roadmap checkbox.** Replace:

```
- [ ] **Phase 1 — Switch control.** `POST /command` + rule matcher (switch domain only) + adapter wired with polling. *Verify:* a `curl` POST flips a real relay.
```
with:
```
- [x] **Phase 1 — Switch control.** `POST /command` + rule matcher (on/off, all_off, groups, status) wired to the adapter; command logging. Done 2026-05-28.
```

- [ ] **Step 2: Add a Phase 1 line to the TL;DR.** Immediately after the `Phase 0 (Scaffold) — DONE.` bullet, insert:

```
- **Phase 1 (Switch control) — DONE.** `POST /command {text}` parses → routes → flips the real relay → returns `{ok, speak, intent}`. 35 tests green.
```

- [ ] **Step 3: Commit**

```bash
git add CHECKPOINT.md
git commit -m "Update checkpoint: Phase 1 complete"
```

---

## Task 7: Push to GitHub

> `gh` is already authenticated and `origin/main` tracking is set (from Phase 0).

- [ ] **Step 1: Push**

Run: `git push`
Expected: commits land on `origin/main`; no errors.

- [ ] **Step 2: Verify in sync**

Run: `git status -sb && git ls-files | grep -E '(^|/)\.env$|\.db$' || echo "OK: no secrets tracked"`
Expected: `## main...origin/main` with nothing ahead/behind; `OK: no secrets tracked`.

---

## Acceptance criteria (Phase 1 complete when all true)

- [ ] `npm test` is green — 35 tests, 0 failures.
- [ ] `POST /command {"text":"turn off the tubelight"}` → `{"ok":true,"speak":"Tubelight is off.","intent":{...}}` and relay 2 physically turns off.
- [ ] Group ("lights off"), all_off ("everything off"), and status ("is the tubelight on?") all work against the live board.
- [ ] Gibberish → `{"ok":false,"speak":"Sorry, I didn't catch that.","intent":null}` (HTTP 200); missing `text` → HTTP 400.
- [ ] Every command writes a `command_log` row.
- [ ] Work pushed to `origin/main`; `CHECKPOINT.md` reflects Phase 1 done.
```
