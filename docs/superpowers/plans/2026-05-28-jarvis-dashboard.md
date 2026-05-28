# JARVIS Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static web dashboard at `GET /` to view live switch state and control switches by clicking, backed by a new direct `POST /switch` endpoint.

**Architecture:** `buildApp` serves `orchestrator/public/index.html` via `express.static` and adds `POST /switch` (injected `onSwitch`). `main()` composes `onSwitch` (build intent → existing `route()` → log) sharing a `runIntent` helper with `onCommand`. The page is vanilla HTML/CSS/JS that polls `GET /state` and posts to `/switch` (buttons) and `/command` (free text).

**Tech Stack:** Node 22 (ESM), Express 5 (`express.static`), `node:test`, vanilla browser JS. No new deps, no build step.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-dashboard-design.md`

---

## Task 1: Backend — `POST /switch` + static mount + wiring (TDD)

**Files:**
- Modify: `orchestrator/server.js`
- Test: `orchestrator/server.test.js`

- [ ] **Step 1: Append the failing endpoint tests** to `orchestrator/server.test.js`:

```js
test('POST /switch returns the onSwitch result as JSON', async () => {
  const onSwitch = async (body) => ({
    ok: true,
    speak: `did: ${body.action} ${body.target}`,
    intent: { domain: 'switch', action: body.action, target: body.target },
  });
  const server = buildApp({ esp32: stubEsp32({}), onSwitch }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'tubelight', action: 'off' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      speak: 'did: off tubelight',
      intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    });
  } finally {
    server.close();
  }
});

test('POST /switch with invalid action returns 400', async () => {
  const onSwitch = async () => {
    throw new Error('onSwitch should not be called for invalid action');
  };
  const server = buildApp({ esp32: stubEsp32({}), onSwitch }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'tubelight', action: 'explode' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, speak: 'Bad request.', intent: null });
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/server.test.js`
Expected: FAIL — `/switch` is 404, so the assertions fail.

- [ ] **Step 3: Replace `orchestrator/server.js`** with:

```js
import express from 'express';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';
import { parse } from './intent/index.js';
import { route } from './router.js';

// Pure factory — no network, no DB. Dependencies injected for testability.
// onCommand(text) and onSwitch({target, action}) each resolve to { ok, speak, intent }.
export function buildApp({ esp32, onCommand, onSwitch }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(import.meta.dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  // Free-text transcript -> NL pipeline.
  app.post('/command', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, speak: "Sorry, I didn't catch that.", intent: null });
    }
    res.json(await onCommand(text));
  });

  // Direct, structured control for the dashboard buttons (bypasses the text matcher).
  app.post('/switch', async (req, res) => {
    const { action } = req.body ?? {};
    if (action !== 'on' && action !== 'off' && action !== 'all_off') {
      return res.status(400).json({ ok: false, speak: 'Bad request.', intent: null });
    }
    res.json(await onSwitch(req.body));
  });

  return app;
}

// Composition root: seed registry, wire the board, poll, build pipelines, listen.
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
  const knownTargets = new Set([...vocab.deviceNames, ...registry.getGroupNames()]);

  const runIntent = async (intent, rawText) => {
    const { ok, speak } = await route(intent, { board: esp32, registry });
    registry.logCommand({ raw_text: rawText, intent, ok: ok ? 1 : 0, detail: speak });
    return { ok, speak, intent };
  };

  const onCommand = async (text) => {
    const intent = parse(text, vocab);
    if (!intent) {
      registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
      return { ok: false, speak: "Sorry, I didn't catch that.", intent: null };
    }
    return runIntent(intent, text);
  };

  const onSwitch = async ({ target, action } = {}) => {
    let intent;
    if (action === 'all_off') intent = { domain: 'switch', action: 'all_off' };
    else if ((action === 'on' || action === 'off') && knownTargets.has(target)) {
      intent = { domain: 'switch', action, target };
    } else {
      return { ok: false, speak: "I don't know how to do that.", intent: null };
    }
    return runIntent(intent, `[ui] ${action}${target ? ' ' + target : ''}`);
  };

  buildApp({ esp32, onCommand, onSwitch }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 4: Run server tests**

Run: `node --test orchestrator/server.test.js`
Expected: PASS — 6 tests (`/health`, `/state`, `/command` ok, `/command` 400, `/switch` ok, `/switch` 400).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS — 37 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "Add POST /switch direct control + static mount; share runIntent"
```

---

## Task 2: Dashboard page (TDD for the route, manual for the UI)

**Files:**
- Create: `orchestrator/public/index.html`
- Test: `orchestrator/server.test.js`

- [ ] **Step 1: Append the failing `GET /` test** to `orchestrator/server.test.js`:

```js
test('GET / serves the dashboard HTML', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /JARVIS/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test orchestrator/server.test.js`
Expected: FAIL — `GET /` is 404 (no `public/index.html` yet).

- [ ] **Step 3: Create `orchestrator/public/index.html`:**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JARVIS</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background:#111; color:#eee; }
  header { display:flex; align-items:center; gap:.6rem; padding:1rem 1.25rem; border-bottom:1px solid #333; }
  header h1 { font-size:1.2rem; margin:0; letter-spacing:.18em; }
  .dot { width:.7rem; height:.7rem; border-radius:50%; background:#666; }
  .dot.online { background:#3fb950; }
  main { padding:1.25rem; max-width:760px; margin:0 auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:.7rem; }
  .tile { padding:.9rem; border:1px solid #333; border-radius:.6rem; background:#1b1b1b; cursor:pointer; text-align:left; color:#eee; font:inherit; }
  .tile:hover { border-color:#555; }
  .tile .name { display:block; font-weight:600; text-transform:capitalize; }
  .tile .st { font-size:.85rem; color:#888; }
  .tile.on { background:#16301c; border-color:#2ea043; }
  .tile.on .st { color:#3fb950; }
  .row { display:flex; flex-wrap:wrap; gap:.5rem; margin:1.25rem 0; }
  button.act { padding:.5rem .8rem; border:1px solid #333; border-radius:.5rem; background:#1b1b1b; color:#eee; cursor:pointer; font:inherit; }
  button.act:hover { border-color:#555; }
  .cmd { display:flex; gap:.5rem; margin-top:1rem; }
  .cmd input { flex:1; padding:.55rem .7rem; border:1px solid #333; border-radius:.5rem; background:#1b1b1b; color:#eee; font:inherit; }
  .say { margin-top:1rem; min-height:1.4em; color:#9ecbff; }
  body.offline .grid { opacity:.45; pointer-events:none; }
</style>
</head>
<body>
<header><span id="dot" class="dot"></span><h1>JARVIS</h1></header>
<main>
  <div id="tiles" class="grid"></div>
  <div class="row">
    <button class="act" onclick="sw('lights','on')">Lights On</button>
    <button class="act" onclick="sw('lights','off')">Lights Off</button>
    <button class="act" onclick="sw('fans','on')">Fans On</button>
    <button class="act" onclick="sw('fans','off')">Fans Off</button>
    <button class="act" onclick="allOff()">All Off</button>
  </div>
  <form class="cmd" onsubmit="return runCmd(event)">
    <input id="cmd" placeholder="turn off the tubelight" autocomplete="off" />
    <button class="act" type="submit">Send</button>
  </form>
  <div id="say" class="say"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);

  async function post(path, body) {
    try {
      const r = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (j && j.speak) $('say').textContent = '▸ ' + j.speak;
    } catch { $('say').textContent = '▸ (request failed)'; }
    refresh();
  }
  const sw = (target, action) => post('/switch', { target, action });
  const allOff = () => post('/switch', { action: 'all_off' });
  function runCmd(e) { e.preventDefault(); const t = $('cmd').value.trim(); if (t) post('/command', { text: t }); $('cmd').value=''; return false; }

  function render(state) {
    $('dot').className = 'dot' + (state.online ? ' online' : '');
    document.body.classList.toggle('offline', !state.online);
    const sm = state.smartswitch || {};
    const tiles = $('tiles');
    tiles.innerHTML = '';
    for (const [name, on] of Object.entries(sm)) {
      const b = document.createElement('button');
      b.className = 'tile' + (on ? ' on' : '');
      const nameEl = document.createElement('span'); nameEl.className = 'name'; nameEl.textContent = name;
      const stEl = document.createElement('span'); stEl.className = 'st'; stEl.textContent = on ? 'on' : 'off';
      b.append(nameEl, stEl);
      b.onclick = () => sw(name, on ? 'off' : 'on');
      tiles.appendChild(b);
    }
  }

  async function refresh() {
    try { const r = await fetch('/state'); render(await r.json()); }
    catch { document.body.classList.add('offline'); }
  }
  refresh();
  setInterval(refresh, 1500);
</script>
</body>
</html>
```

- [ ] **Step 4: Run server tests**

Run: `node --test orchestrator/server.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS — 38 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/public/index.html orchestrator/server.test.js
git commit -m "Add web dashboard page served at GET /"
```

---

## Task 3: Live acceptance + browser hand-off

> Verification only — no commit. A server may already be running on :3000 from earlier; stop it first.

- [ ] **Step 1: Stop any running server, boot fresh in the background**

```bash
pkill -f "orchestrator/server.js" 2>/dev/null; sleep 1
npm start > /tmp/jarvis-dash.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:3000/health >/dev/null 2>&1 && break; sleep 0.3; done
```

- [ ] **Step 2: Confirm the page and the endpoint**

```bash
echo "-- GET / contains JARVIS --"; curl -s localhost:3000/ | grep -o JARVIS | head -1
echo "-- POST /switch on tubelight --"; curl -s -X POST localhost:3000/switch -H 'content-type: application/json' -d '{"target":"tubelight","action":"on"}'; echo
echo "-- state --"; curl -s localhost:3000/state; echo
```
Expected: prints `JARVIS`; the `/switch` call returns `{"ok":true,"speak":"Tubelight is on.","intent":{...}}` and relay 2 turns on; `/state` shows `tubelight:true`.

- [ ] **Step 3: Hand off to the user**

Leave the server running and tell the user to open **http://localhost:3000/** in a browser, click tiles/buttons, and confirm the UI updates. (The agent cannot drive a browser; this step is the user's visual confirmation.)

---

## Task 4: Checkpoint note + push

**Files:**
- Modify: `CHECKPOINT.md`

- [ ] **Step 1: Add a dashboard line to the TL;DR.** After the `Phase 1 (Switch control) — DONE.` bullet, insert:

```
- **Web dashboard (Phase 5, pulled forward) — DONE.** `GET /` serves a static control panel; buttons hit `POST /switch`, free text hits `/command`; live state via `/state` polling.
```

- [ ] **Step 2: Commit**

```bash
git add CHECKPOINT.md
git commit -m "Note web dashboard in checkpoint"
```

- [ ] **Step 3: Push**

Run: `git push`
Expected: commits land on `origin/main`; `git status -sb` shows `## main...origin/main` with nothing ahead.

---

## Acceptance criteria

- [ ] `npm test` green — 38 tests, 0 failures.
- [ ] `GET /` serves the dashboard (contains `JARVIS`).
- [ ] `POST /switch {"target":"tubelight","action":"on"}` flips relay 2 and returns `{ok,speak,intent}`; invalid action → 400.
- [ ] User confirms in a browser: tiles show live state, clicking toggles the real relay, group/all-off/command box all work.
- [ ] Work committed and pushed to `origin/main`; `CHECKPOINT.md` notes the dashboard.
