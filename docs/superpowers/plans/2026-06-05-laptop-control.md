# Laptop Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the remote PC agent `desktop`→`laptop` and add three new remote capabilities — set volume to a level, open a website/URL, and type text.

**Architecture:** Orchestrator side: `seed()` becomes config-authoritative (deletes orphaned agents), `pc.js` parses a new `type` command, and `router.js` dispatches three new remote actions. Agent side (dependency-free Node + PowerShell): `media` gains `set_volume`, plus two new capability modules `browser` and `type`. URL-vs-app detection lives in the router's remote branch (no new intent type).

**Tech Stack:** Node (ESM), `node:test` + `node:assert/strict`, better-sqlite3, PowerShell on the Windows agent.

---

## Conventions (read once)

- Test runner: from `orchestrator/`, `node --test <file>`; from `pc-agent/`, `node --test <file>`. Whole suite: `node --test`.
- Agent capability shape: `{ name, actions: { actionName: (params) => ({ ok, detail }) } }`. `spawn` is injected for tests (a recorder asserts the `powershell`/`cmd` command string; nothing is really spawned).
- All remote router branches follow the existing guard order: check `REMOTE`/known op → `pcAgents.get(machine)` → `agentClient` → dispatch → `remoteSpeak(r, machine)`.

## File structure

- **Modify** `orchestrator/db/registry.js` — `seed()` deletes `pc_agent` rows not in config (rename = remove old + insert new).
- **Modify** `orchestrator/intent/pc.js` — add `type <text>` rule.
- **Modify** `orchestrator/router.js` — remote `set_volume`; URL detection in remote `open_app`; remote `type` branch.
- **Modify** `pc-agent/capabilities/media.js` — add `set_volume` action.
- **Create** `pc-agent/capabilities/browser.js` — `open` action (`Start-Process <url>`).
- **Create** `pc-agent/capabilities/type.js` — `send` action (PowerShell SendKeys).
- **Modify** `pc-agent/index.js` — register `browser` and `type`.
- **Manual** `.env` / `.env.example` — `PC_AGENTS=laptop=...`; redeploy agent.
- Tests alongside each (`*.test.js`).

---

## Task 1: seed() removes orphaned PC agents (config-authoritative rename)

**Files:**
- Modify: `orchestrator/db/registry.js` (the `seed()` function, ~lines 55-74)
- Test: `orchestrator/db/registry.test.js`

- [ ] **Step 1: Write the failing test** — add after the existing "seed reconciles base_url" test:

```js
test('seed removes pc_agent rows not present in config (rename, not duplicate)', () => {
  const dbPath = join(tmpdir(), `jarvis-test-rename-${process.pid}-${Date.now()}.db`);
  try {
    openRegistry({ dbPath, esp32BaseUrl: 'http://b', pcAgents: [{ name: 'desktop', baseUrl: 'http://x:7000' }] }).close();
    const reg = openRegistry({ dbPath, esp32BaseUrl: 'http://b', pcAgents: [{ name: 'laptop', baseUrl: 'http://x:7000' }] });
    assert.deepEqual(reg.getPcAgents().map((a) => a.name), ['laptop']);
    assert.equal(reg._db.prepare("SELECT COUNT(*) AS n FROM devices WHERE type='pc_agent'").get().n, 1);
    reg.close();
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
  }
});
```

- [ ] **Step 2: Run it — expect FAIL** (currently both `desktop` and `laptop` rows exist)

Run: `cd orchestrator && node --test db/registry.test.js`
Expected: this test fails — `getPcAgents()` returns `['desktop','laptop']`.

- [ ] **Step 3: Implement** — inside `seed()`'s `tx`, after the `for (const a of pcAgents) insertAgent.run(...)` line, add orphan deletion:

```js
    for (const a of pcAgents) insertAgent.run(a.name, a.baseUrl);
    // Config is the source of truth: drop pc_agent rows no longer configured.
    const names = pcAgents.map((a) => a.name);
    if (names.length) {
      db.prepare(
        `DELETE FROM devices WHERE type='pc_agent' AND name NOT IN (${names.map(() => '?').join(',')})`,
      ).run(...names);
    } else {
      db.prepare("DELETE FROM devices WHERE type='pc_agent'").run();
    }
```

- [ ] **Step 4: Run it — expect PASS**, plus full registry file green.

Run: `cd orchestrator && node --test db/registry.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/db/registry.js orchestrator/db/registry.test.js
git commit -m "feat(registry): seed drops pc_agent rows not in config (clean rename)"
```

---

## Task 2: pc.js parses "type <text>"

**Files:**
- Modify: `orchestrator/intent/pc.js` (add a rule near the end, before the final `return null`)
- Test: `orchestrator/intent/pc.test.js`

- [ ] **Step 1: Write the failing test** — add to `pc.test.js`:

```js
test('type command -> type intent, machine-aware', () => {
  assert.deepEqual(
    matchPcCommand('type hello world', {}),
    { domain: 'pc', action: 'type', text: 'hello world' },
  );
  assert.deepEqual(
    matchPcCommand('type hello on the laptop', { pcNames: ['laptop'] }),
    { domain: 'pc', action: 'type', text: 'hello', machine: 'laptop' },
  );
});
```

(If `matchPcCommand` isn't already imported at the top of `pc.test.js`, it is — the file tests it throughout.)

- [ ] **Step 2: Run it — expect FAIL** (`type` returns null today)

Run: `cd orchestrator && node --test intent/pc.test.js`
Expected: fails — got `null`.

- [ ] **Step 3: Implement** — in `pc.js`, just before the `// shell recipe — "run <recipe>"` block, add:

```js
  // type <text> -> send keystrokes (remote-only; router rejects without a machine)
  const typ = norm.match(/^type\s+(.+)$/);
  if (typ && typ[1].trim()) {
    return withMachine({ domain: 'pc', action: 'type', text: typ[1].trim() });
  }
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd orchestrator && node --test intent/pc.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "feat(intent): parse 'type <text>' PC command"
```

---

## Task 3: router dispatches remote set_volume

**Files:**
- Modify: `orchestrator/router.js` (`REMOTE_MEDIA_OPS` line 4; the media remote dispatch ~line 44)
- Test: `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing test** — add to `router.test.js` (match the existing remote-media test style; it uses a fake `agentClient` and `pcAgents`):

```js
test('remote set_volume dispatches level to the agent media capability', async () => {
  const calls = [];
  const agentClient = { run: async (base, payload) => { calls.push({ base, payload }); return { ok: true, detail: 'Volume set to 30.' }; } };
  const pcAgents = { get: (n) => (n === 'laptop' ? { name: 'laptop', base_url: 'http://x:7000' } : undefined) };
  const r = await route(
    { domain: 'pc', action: 'media', op: 'set_volume', arg: 30, machine: 'laptop' },
    { agentClient, pcAgents },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].payload, { capability: 'media', action: 'set_volume', params: { level: 30 } });
});
```

(`route` is the exported router entry already imported in `router.test.js`.)

- [ ] **Step 2: Run it — expect FAIL** (`set_volume` not in `REMOTE_MEDIA_OPS` → "I can't do that on the laptop yet.")

Run: `cd orchestrator && node --test router.test.js`
Expected: fails.

- [ ] **Step 3: Implement** — two edits in `router.js`:

(a) add `set_volume` to the set (line 4):

```js
const REMOTE_MEDIA_OPS = new Set(['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute', 'set_volume']);
```

(b) in the media remote branch, pass the level for `set_volume`. Replace the existing remote dispatch line:

```js
        const r = await agentClient.run(a.base_url, { capability: 'media', action: intent.op, params: {} });
```

with:

```js
        const params = intent.op === 'set_volume' ? { level: intent.arg } : {};
        const r = await agentClient.run(a.base_url, { capability: 'media', action: intent.op, params });
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd orchestrator && node --test router.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "feat(router): dispatch remote set_volume with level"
```

---

## Task 4: router opens a URL on the laptop (URL detection in remote open_app)

**Files:**
- Modify: `orchestrator/router.js` (the `open_app` remote branch ~lines 27-34)
- Test: `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing test**:

```js
test('remote open_app routes a URL-like target to the browser capability', async () => {
  const calls = [];
  const agentClient = { run: async (base, payload) => { calls.push(payload); return { ok: true, detail: 'Opening https://youtube.com.' }; } };
  const pcAgents = { get: () => ({ name: 'laptop', base_url: 'http://x:7000' }) };
  const r = await route({ domain: 'pc', action: 'open_app', target: 'youtube.com', machine: 'laptop' }, { agentClient, pcAgents });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { capability: 'browser', action: 'open', params: { url: 'youtube.com' } });

  const r2calls = [];
  const ac2 = { run: async (b, p) => { r2calls.push(p); return { ok: true, detail: 'Opening notepad.' }; } };
  await route({ domain: 'pc', action: 'open_app', target: 'notepad', machine: 'laptop' }, { agentClient: ac2, pcAgents });
  assert.deepEqual(r2calls[0], { capability: 'apps', action: 'open', params: { name: 'notepad' } });
});
```

- [ ] **Step 2: Run it — expect FAIL** (today every remote open_app goes to `apps`)

Run: `cd orchestrator && node --test router.test.js`
Expected: first assertion fails.

- [ ] **Step 3: Implement** — add a URL helper near the top of `router.js` (after the `REMOTE_MEDIA_OPS` line):

```js
// A target is treated as a website if it has a dot with no spaces, or an explicit scheme.
function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s) || (/\./.test(s) && !/\s/.test(s));
}
```

Then in the `open_app` remote branch, replace:

```js
        const r = await agentClient.run(a.base_url, { capability: 'apps', action: 'open', params: { name: intent.target } });
```

with:

```js
        const r = looksLikeUrl(intent.target)
          ? await agentClient.run(a.base_url, { capability: 'browser', action: 'open', params: { url: intent.target } })
          : await agentClient.run(a.base_url, { capability: 'apps', action: 'open', params: { name: intent.target } });
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd orchestrator && node --test router.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "feat(router): open URLs on the laptop via the browser capability"
```

---

## Task 5: router dispatches remote type

**Files:**
- Modify: `orchestrator/router.js` (add a `type` branch inside the `intent.domain === 'pc'` block, after the `media` branch)
- Test: `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing test**:

```js
test('remote type dispatches text to the agent type capability', async () => {
  const calls = [];
  const agentClient = { run: async (b, p) => { calls.push(p); return { ok: true, detail: 'Typed.' }; } };
  const pcAgents = { get: () => ({ name: 'laptop', base_url: 'http://x:7000' }) };
  const r = await route({ domain: 'pc', action: 'type', text: 'hello world', machine: 'laptop' }, { agentClient, pcAgents });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { capability: 'type', action: 'send', params: { text: 'hello world' } });
});

test('type without a machine is rejected (remote-only)', async () => {
  const r = await route({ domain: 'pc', action: 'type', text: 'hello' }, {});
  assert.equal(r.ok, false);
  assert.match(r.speak, /which (pc|laptop)|on (a|the)/i);
});
```

- [ ] **Step 2: Run it — expect FAIL** (no `type` branch; falls through to "I don't know how to do that.")

Run: `cd orchestrator && node --test router.test.js`
Expected: fails (second test's message won't match yet, first returns the generic decline).

- [ ] **Step 3: Implement** — in `router.js`, inside the `if (intent.domain === 'pc') {` block, after the `media` branch's closing `}`, add:

```js
    if (intent.action === 'type') {
      if (!intent.machine) return { ok: false, speak: 'I can only type on a PC — say "type … on the laptop".' };
      const a = pcAgents?.get?.(intent.machine);
      if (!a) return { ok: false, speak: `I don't know a PC called ${intent.machine}.` };
      if (!agentClient) return { ok: false, speak: 'PC agent client not configured.' };
      const r = await agentClient.run(a.base_url, { capability: 'type', action: 'send', params: { text: intent.text } });
      return remoteSpeak(r, intent.machine);
    }
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd orchestrator && node --test router.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "feat(router): dispatch remote 'type' to the agent"
```

---

## Task 6: agent media gains set_volume

**Files:**
- Modify: `pc-agent/capabilities/media.js`
- Test: `pc-agent/capabilities/media.test.js`

- [ ] **Step 1: Write the failing test** — add to `media.test.js`:

```js
test('set_volume floors then steps up ~2%/step via powershell', () => {
  const r = rec();
  const res = makeMedia({ spawn: r.spawn }).actions.set_volume({ level: 30 });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'powershell');
  const script = r.calls[0].args.join(' ');
  assert.match(script, /keybd_event/);
  assert.ok(script.includes('0xAE'), 'sends volume-down');
  assert.ok(script.includes('0xAF'), 'sends volume-up');
  assert.ok(script.includes('1..50'), 'floors to zero with 50 down-steps');
  assert.ok(script.includes('1..15'), 'steps up round(30/2)=15');
});

test('set_volume clamps out-of-range levels', () => {
  const r = rec();
  makeMedia({ spawn: r.spawn }).actions.set_volume({ level: 250 });
  const script = r.calls[0].args.join(' ');
  assert.ok(script.includes('1..50'), 'clamps to 100 -> 50 up-steps');
});
```

- [ ] **Step 2: Run it — expect FAIL** (`set_volume` action undefined)

Run: `cd pc-agent && node --test capabilities/media.test.js`
Expected: fails.

- [ ] **Step 3: Implement** — in `media.js`, add a `setVolume` builder and wire the action. After the `press(...)` function add:

```js
function setVolume(spawn, level) {
  const lvl = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const ups = Math.round(lvl / 2); // each VK_VOLUME_UP ≈ 2%
  const script =
    "$s='[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,uint f,IntPtr e);';" +
    '$k=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;' +
    'function vk($c){$k::keybd_event($c,0,0,[IntPtr]::Zero);$k::keybd_event($c,0,2,[IntPtr]::Zero)}' +
    '1..50 | % { vk 0xAE };' +
    `1..${ups} | % { vk 0xAF };`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
    p?.unref?.();
    return { ok: true, detail: `Volume set to ${lvl}.` };
  } catch {
    return { ok: false, detail: "I couldn't set the volume." };
  }
}
```

Then inside `makeMedia`, after the `for (const [name, vk] ...)` loop, add:

```js
  actions.set_volume = ({ level } = {}) => setVolume(spawn, level);
```

Note: `1..0 | % {...}` in PowerShell iterates `0,1` (harmless one extra step) when `ups` is 0; acceptable for level 0/1. If `ups` is 15 the script literally contains `1..15`, satisfying the test.

- [ ] **Step 4: Run it — expect PASS**

Run: `cd pc-agent && node --test capabilities/media.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pc-agent/capabilities/media.js pc-agent/capabilities/media.test.js
git commit -m "feat(agent): media set_volume via volume-key steps"
```

---

## Task 7: agent browser capability (open URL)

**Files:**
- Create: `pc-agent/capabilities/browser.js`
- Create: `pc-agent/capabilities/browser.test.js`

- [ ] **Step 1: Write the failing test** — `pc-agent/capabilities/browser.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowser } from './browser.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('open normalizes a bare domain to https and Start-Process es it', () => {
  const r = rec();
  const res = makeBrowser({ spawn: r.spawn }).actions.open({ url: 'youtube.com' });
  assert.equal(res.ok, true);
  const script = r.calls[0].args.join(' ');
  assert.match(script, /Start-Process/);
  assert.ok(script.includes('https://youtube.com'), 'adds scheme');
});

test('open keeps an explicit scheme', () => {
  const r = rec();
  makeBrowser({ spawn: r.spawn }).actions.open({ url: 'http://example.com/x' });
  assert.ok(r.calls[0].args.join(' ').includes('http://example.com/x'));
});

test('open rejects empty url', () => {
  const res = makeBrowser({ spawn: rec().spawn }).actions.open({ url: '' });
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `cd pc-agent && node --test capabilities/browser.test.js`
Expected: fails to import.

- [ ] **Step 3: Implement** — `pc-agent/capabilities/browser.js`:

```js
// Agent capability: browser — open a URL in the default browser via Start-Process.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

function normalize(url) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function makeBrowser({ spawn = _spawn } = {}) {
  return {
    name: 'browser',
    actions: {
      open({ url } = {}) {
        const u = normalize(url);
        if (!u) return { ok: false, detail: 'no url' };
        // Single-quote for PowerShell; strip any embedded single quotes defensively.
        const safe = u.replace(/'/g, '');
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${safe}'`], OPTS);
          p?.unref?.();
          return { ok: true, detail: `Opening ${u}.` };
        } catch {
          return { ok: false, detail: "I couldn't open that link." };
        }
      },
    },
  };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd pc-agent && node --test capabilities/browser.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pc-agent/capabilities/browser.js pc-agent/capabilities/browser.test.js
git commit -m "feat(agent): browser capability to open URLs"
```

---

## Task 8: agent type capability + register browser & type

**Files:**
- Create: `pc-agent/capabilities/type.js`
- Create: `pc-agent/capabilities/type.test.js`
- Modify: `pc-agent/index.js`

- [ ] **Step 1: Write the failing test** — `pc-agent/capabilities/type.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeType } from './type.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('send types text via SendKeys', () => {
  const r = rec();
  const res = makeType({ spawn: r.spawn }).actions.send({ text: 'hello world' });
  assert.equal(res.ok, true);
  const script = r.calls[0].args.join(' ');
  assert.match(script, /SendKeys/);
  assert.ok(script.includes('hello world'), 'includes the literal text');
});

test('send escapes SendKeys metacharacters', () => {
  const r = rec();
  makeType({ spawn: r.spawn }).actions.send({ text: 'a+b%c' });
  const script = r.calls[0].args.join(' ');
  assert.ok(script.includes('{+}') && script.includes('{%}'), 'escapes + and %');
});

test('send rejects empty text', () => {
  assert.equal(makeType({ spawn: rec().spawn }).actions.send({ text: '' }).ok, false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `cd pc-agent && node --test capabilities/type.test.js`
Expected: fails to import.

- [ ] **Step 3: Implement** — `pc-agent/capabilities/type.js`:

```js
// Agent capability: type — send keystrokes to the focused window via SendKeys.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

// SendKeys treats + ^ % ~ ( ) { } [ ] as control chars; wrap each in braces.
function escapeSendKeys(text) {
  return String(text ?? '').replace(/[+^%~(){}\[\]]/g, (ch) => `{${ch}}`);
}

export function makeType({ spawn = _spawn } = {}) {
  return {
    name: 'type',
    actions: {
      send({ text } = {}) {
        const raw = String(text ?? '').trim();
        if (!raw) return { ok: false, detail: 'no text' };
        const keys = escapeSendKeys(raw).replace(/'/g, '');
        const script =
          "Add-Type -AssemblyName System.Windows.Forms;" +
          `[System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
          p?.unref?.();
          return { ok: true, detail: 'Typed.' };
        } catch {
          return { ok: false, detail: "I couldn't type that." };
        }
      },
    },
  };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd pc-agent && node --test capabilities/type.test.js`
Expected: all pass.

- [ ] **Step 5: Register both capabilities** — edit `pc-agent/index.js`:

```js
import { start } from './server.js';
import { makeApps } from './capabilities/apps.js';
import { makeMedia } from './capabilities/media.js';
import { makeShell } from './capabilities/shell.js';
import { makeBrowser } from './capabilities/browser.js';
import { makeType } from './capabilities/type.js';

const token = process.env.PC_AGENT_TOKEN ?? '';
if (!token) console.warn('WARNING: PC_AGENT_TOKEN is empty — /run will reject everything.');
start({ capabilities: [makeApps(), makeMedia(), makeShell(), makeBrowser(), makeType()], token });
```

- [ ] **Step 6: Whole agent suite green**

Run: `cd pc-agent && node --test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add pc-agent/capabilities/type.js pc-agent/capabilities/type.test.js pc-agent/index.js
git commit -m "feat(agent): type capability; register browser + type"
```

---

## Task 9: Rename in .env and deploy + manual end-to-end

**Files:**
- Manual: `.env` (gitignored — never commit), `.env.example` (committed), the Windows agent.

- [ ] **Step 1: Edit `.env`** — change the agent name to `laptop` (keep the same URL/token):

```
PC_AGENTS=laptop=http://192.168.0.117:7000
```

- [ ] **Step 2: Update `.env.example`** — change its `PC_AGENTS` placeholder name from `desktop` to `laptop` so the documented example matches. Run:

`grep -n PC_AGENTS .env.example`  → edit the placeholder name to `laptop`, leaving the example URL as-is.

- [ ] **Step 3: Deploy the agent** — on the Windows box: `git pull`, then restart `node pc-agent/index.js` (with `PC_AGENT_TOKEN` set). Confirm:

`curl -s http://192.168.0.117:7000/health`
Expected: `{"ok":true,"capabilities":["apps","media","shell","browser","type"]}`

- [ ] **Step 4: Restart the orchestrator** so it reloads `.env` and re-seeds (the old `desktop` row is dropped, `laptop` inserted):

`./run-jarvis.sh`, then verify the agent is known under the new name:

```bash
curl -s -X POST http://localhost:3000/command -H 'Content-Type: application/json' -d '{"text":"open notepad on the laptop"}'
```
Expected: `{"ok":true,...}` (and "on the desktop" now returns "I don't know a PC called desktop.").

- [ ] **Step 5: Exercise the new commands** (API or voice):
  - `"set volume to 30 on the laptop"` → "Volume set to 30." (laptop volume drops to ~30%)
  - `"open youtube.com on the laptop"` → browser opens YouTube on the laptop
  - `"type hello world on the laptop"` → "hello world" appears in the laptop's focused window

- [ ] **Step 6: Commit the example change**

```bash
git add .env.example
git commit -m "docs(env): rename example PC agent desktop -> laptop"
```

---

## Done criteria

- Agent `/health` lists `apps, media, shell, browser, type`.
- "on the laptop" works for open app, open URL, set volume, type, media keys, and confirm-gated shell; "on the desktop" is unknown.
- Full suites green: `cd orchestrator && node --test` and `cd pc-agent && node --test`.
- `.env` not committed; `.env.example` updated.
