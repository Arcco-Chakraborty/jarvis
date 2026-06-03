# Multi-PC Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** "open \<app\> on the \<pc\>" launches the app on a remote Windows PC running a small Node agent; local "open \<app\>" is unchanged.

**Architecture:** A dependency-free Node `http` agent (`pc-agent/`) with an `apps` capability and bearer auth. The orchestrator parses a trailing "on the \<pc\>", resolves it to a registered `pc_agent` base_url, and POSTs `/run` via a client; no machine → local.

**Tech Stack:** Node ESM `node:test`, stdlib `http`, `fetch` (injected).

**Spec:** `docs/superpowers/specs/2026-06-01-multipc-phase1-design.md`
**Branch:** `multipc-phase1`.

**Test command:** `npm test` / `node --test <file>`.

---

## Task 1: agent `apps` capability

**Files:** Create `pc-agent/capabilities/apps.js`, `pc-agent/capabilities/apps.test.js`.

- [ ] **Step 1: Failing test** — `pc-agent/capabilities/apps.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApps } from './apps.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('apps capability exposes name + open action', () => {
  const a = makeApps({ spawn: rec().spawn });
  assert.equal(a.name, 'apps');
  assert.equal(typeof a.actions.open, 'function');
});

test('open launches via Windows start and resolves the name', () => {
  const r = rec();
  const res = makeApps({ spawn: r.spawn }).actions.open({ name: 'steam' });
  assert.equal(res.ok, true);
  assert.match(res.detail, /opening steam/i);
  assert.deepEqual(r.calls[0].args, ['/c', 'start', '', 'steam']);
  assert.equal(r.calls[0].bin, 'cmd');
});

test('open refuses an empty name', () => {
  const res = makeApps({ spawn: rec().spawn }).actions.open({ name: '' });
  assert.equal(res.ok, false);
});

test('open catches spawn errors', () => {
  const res = makeApps({ spawn: () => { throw new Error('nope'); } }).actions.open({ name: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.detail, /couldn'?t/i);
});
```

- [ ] **Step 2: Run** — `node --test pc-agent/capabilities/apps.test.js`. FAIL (no module).

- [ ] **Step 3: Implement** — `pc-agent/capabilities/apps.js`:
```js
// Agent capability: apps — launch a program on this (Windows) machine.
// Windows `start "" <name>` resolves PATH + App Paths registry.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeApps({ spawn = _spawn } = {}) {
  return {
    name: 'apps',
    actions: {
      open({ name } = {}) {
        const app = String(name ?? '').trim();
        if (!app) return { ok: false, detail: 'no app name' };
        try {
          const p = spawn('cmd', ['/c', 'start', '', app], OPTS);
          p?.unref?.();
          return { ok: true, detail: `Opening ${app}.` };
        } catch {
          return { ok: false, detail: `I couldn't open ${app}.` };
        }
      },
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test pc-agent/capabilities/apps.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add pc-agent/capabilities/apps.js pc-agent/capabilities/apps.test.js
git commit -m "pc-agent: apps capability (Windows start) for remote app launch"
```

---

## Task 2: agent server + boot + package

**Files:** Create `pc-agent/server.js`, `pc-agent/server.test.js`, `pc-agent/index.js`, `pc-agent/package.json`, `pc-agent/README.md`.

- [ ] **Step 1: Failing test** — `pc-agent/server.test.js` (tests the pure handler — no real socket):
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAgent } from './server.js';

// Minimal fake req/res. body is a JSON string (or undefined).
function call(agent, { method = 'POST', url = '/run', auth, body } = {}) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  const req = {
    method, url,
    headers: auth ? { authorization: auth } : {},
    on(ev, cb) { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); return req; },
  };
  let status = 0; let payload = '';
  const res = {
    writeHead(s) { status = s; },
    end(p) { payload = p || ''; },
  };
  return agent(req, res).then(() => ({ status, json: payload ? JSON.parse(payload) : null }));
}

const apps = { name: 'apps', actions: { open: ({ name }) => ({ ok: true, detail: `Opening ${name}.` }) } };

test('GET /health lists capabilities', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { status, json } = await call(agent, { method: 'GET', url: '/health' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, capabilities: ['apps'] });
});

test('POST /run with a valid token dispatches to the capability action', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { status, json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'apps', action: 'open', params: { name: 'steam' } }) });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, detail: 'Opening steam.' });
});

test('POST /run without a valid token is 401', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  assert.equal((await call(agent, { auth: 'Bearer wrong', body: '{}' })).status, 401);
  assert.equal((await call(agent, { body: '{}' })).status, 401);
});

test('unknown capability/action -> ok:false', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'nope', action: 'x' }) });
  assert.equal(json.ok, false);
});

test('a throwing action -> 500 ok:false (never crashes)', async () => {
  const boom = { name: 'boom', actions: { go: () => { throw new Error('x'); } } };
  const agent = makeAgent({ capabilities: [boom], token: 't' });
  const { status, json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'boom', action: 'go' }) });
  assert.equal(status, 500);
  assert.equal(json.ok, false);
});
```

- [ ] **Step 2: Run** — `node --test pc-agent/server.test.js`. FAIL (no module).

- [ ] **Step 3: Implement** — `pc-agent/server.js`:
```js
// JARVIS PC agent — a tiny dependency-free Node http server. Capabilities are
// injected; /run is bearer-authenticated. Returns { ok, detail } JSON.
import http from 'node:http';

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// Returns an async (req,res) handler. Pure + injectable for tests.
export function makeAgent({ capabilities = [], token = '' } = {}) {
  const byName = new Map(capabilities.map((c) => [c.name, c]));
  return async function handler(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, capabilities: [...byName.keys()] });
      }
      if (req.method === 'POST' && req.url === '/run') {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${token}`) return send(res, 401, { ok: false, detail: 'unauthorized' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { ok: false, detail: 'bad json' }); }
        const cap = byName.get(body.capability);
        const action = cap?.actions?.[body.action];
        if (typeof action !== 'function') return send(res, 200, { ok: false, detail: 'unknown capability/action' });
        const result = await action(body.params || {});
        return send(res, 200, { ok: !!result?.ok, detail: result?.detail ?? '' });
      }
      return send(res, 404, { ok: false, detail: 'not found' });
    } catch {
      return send(res, 500, { ok: false, detail: 'agent error' });
    }
  };
}

export function start({ capabilities, token, port = Number(process.env.PORT ?? 7000) } = {}) {
  const server = http.createServer(makeAgent({ capabilities, token }));
  server.listen(port, () => console.log(`JARVIS PC agent on :${port} — capabilities: ${capabilities.map((c) => c.name).join(', ')}`));
  return server;
}
```

- [ ] **Step 4: Create `pc-agent/index.js`** (boot — not unit-tested):
```js
import { start } from './server.js';
import { makeApps } from './capabilities/apps.js';

const token = process.env.PC_AGENT_TOKEN ?? '';
if (!token) console.warn('WARNING: PC_AGENT_TOKEN is empty — /run will reject everything.');
start({ capabilities: [makeApps()], token });
```

- [ ] **Step 5: Create `pc-agent/package.json`**:
```json
{
  "name": "jarvis-pc-agent",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": { "start": "node index.js", "test": "node --test" }
}
```

- [ ] **Step 6: Create `pc-agent/README.md`**:
```markdown
# JARVIS PC Agent (Windows)

A tiny dependency-free Node agent. JARVIS's orchestrator POSTs to it to run
actions on this machine (Phase 1: launch apps).

## Run (Windows)
1. Install Node.js (https://nodejs.org).
2. Set a shared secret (same value as the orchestrator's PC_AGENT_TOKEN):
   `setx PC_AGENT_TOKEN "your-secret"` (reopen the terminal), optionally `setx PORT 7000`.
3. From this folder: `node index.js`
4. Allow the port through Windows Firewall (e.g. Node inbound, TCP 7000).
5. From the orchestrator box: `curl http://<windows-ip>:7000/health` → capabilities list.

## Orchestrator side
In the orchestrator `.env`:
```
PC_AGENT_TOKEN=your-secret
PC_AGENTS=desktop=http://<windows-ip>:7000
```
Then: "jarvis, open notepad on the desktop".
```

- [ ] **Step 7: Run** — `node --test pc-agent/server.test.js` (pass) and boot-import `node -e "import('./pc-agent/index.js')"` (it will start listening — Ctrl-C; just confirm no import error, or run `node --check pc-agent/index.js`).

- [ ] **Step 8: Commit**
```bash
git add pc-agent/server.js pc-agent/server.test.js pc-agent/index.js pc-agent/package.json pc-agent/README.md
git commit -m "pc-agent: dependency-free http server (health + bearer-gated /run) + boot"
```

---

## Task 3: config `parsePcAgents`

**Files:** `orchestrator/config.js`, `orchestrator/config.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/config.test.js`, add (`parsePcAgents` to the import):
```js
test('parsePcAgents parses name=url pairs', () => {
  assert.deepEqual(parsePcAgents('desktop=http://x:7000, htpc=http://y:7000'),
    [{ name: 'desktop', baseUrl: 'http://x:7000' }, { name: 'htpc', baseUrl: 'http://y:7000' }]);
});
test('parsePcAgents drops malformed / empty', () => {
  assert.deepEqual(parsePcAgents(''), []);
  assert.deepEqual(parsePcAgents('garbage,desktop='), []);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/config.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/config.js`, add the exported parser (above `config`) and a field:
```js
// PC_AGENTS: comma-separated "name=baseUrl" pairs.
export function parsePcAgents(raw = process.env.PC_AGENTS) {
  return String(raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => { const i = p.indexOf('='); return i > 0 ? { name: p.slice(0, i).trim(), baseUrl: p.slice(i + 1).trim() } : null; })
    .filter((a) => a && a.name && a.baseUrl);
}
```
Add to `config`: `pcAgents: parsePcAgents(),`.

- [ ] **Step 4: Run** — `node --test orchestrator/config.test.js`, then `npm test`. Pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/config.js orchestrator/config.test.js
git commit -m "config: parsePcAgents (PC_AGENTS name=url list)"
```

---

## Task 4: registry pc_agent seed + lookups

**Files:** `orchestrator/db/registry.js`, `orchestrator/db/registry.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/db/registry.test.js`, add (match the file's existing setup — it opens a registry against a temp/`:memory:` db; check how other tests construct it and follow that):
```js
test('registers PC agents and looks them up', () => {
  const reg = openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://e', pcAgents: [{ name: 'desktop', baseUrl: 'http://192.168.0.50:7000' }] });
  try {
    assert.deepEqual(reg.getPcAgents().map((a) => a.name), ['desktop']);
    assert.equal(reg.getPcAgent('desktop').base_url, 'http://192.168.0.50:7000');
    assert.equal(reg.getPcAgent('nope'), undefined);
  } finally { reg.close(); }
});
```
(If the existing tests don't pass `dbPath: ':memory:'`, use whatever temp-db pattern they use; the key new args are `pcAgents`.)

- [ ] **Step 2: Run** — `node --test orchestrator/db/registry.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/db/registry.js`:
(a) Add `pcAgents = config.pcAgents` to the `openRegistry({...})` params and pass it to `seed`: `seed(db, esp32BaseUrl, pcAgents);`.
(b) In the returned object add:
```js
    getPcAgents: () =>
      db.prepare("SELECT name, base_url FROM devices WHERE type = 'pc_agent' ORDER BY name").all(),
    getPcAgent: (name) =>
      db.prepare("SELECT name, base_url FROM devices WHERE type = 'pc_agent' AND name = ?").get(String(name ?? '')),
```
(c) Change `seed(db, esp32BaseUrl)` to `seed(db, esp32BaseUrl, pcAgents = [])` and, inside its transaction (after the switches are seeded), insert the agents:
```js
    const insertAgent = db.prepare("INSERT OR IGNORE INTO devices (name, type, base_url) VALUES (?, 'pc_agent', ?)");
    for (const a of pcAgents) insertAgent.run(a.name, a.baseUrl);
```
(Adjust so `insertAgent` is prepared alongside the other prepares and runs within `tx`. Keep `getPcAgent` bound so it can be passed as `registry.getPcAgent` — i.e. it must not rely on `this`; it's already a closure.)

- [ ] **Step 4: Run** — `node --test orchestrator/db/registry.test.js`, then `npm test`. Pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/db/registry.js orchestrator/db/registry.test.js
git commit -m "registry: seed pc_agent devices from PC_AGENTS; getPcAgents/getPcAgent"
```

---

## Task 5: PC agent client

**Files:** Create `orchestrator/devices/pc-agent-client.js`, `orchestrator/devices/pc-agent-client.test.js`.

- [ ] **Step 1: Failing test** — `orchestrator/devices/pc-agent-client.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePcAgentClient } from './pc-agent-client.js';

test('run posts to <baseUrl>/run with bearer + body and returns the detail', async () => {
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ ok: true, detail: 'Opening steam.' }) }; };
  const c = makePcAgentClient({ fetchFn, token: 'secret' });
  const r = await c.run('http://x:7000', { capability: 'apps', action: 'open', params: { name: 'steam' } });
  assert.deepEqual(r, { ok: true, detail: 'Opening steam.' });
  assert.equal(seen.url, 'http://x:7000/run');
  assert.equal(seen.opts.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(seen.opts.body), { capability: 'apps', action: 'open', params: { name: 'steam' } });
});

test('non-ok HTTP -> unreachable', async () => {
  const c = makePcAgentClient({ fetchFn: async () => ({ ok: false, status: 500 }), token: 't' });
  assert.deepEqual(await c.run('http://x', {}), { ok: false, detail: 'unreachable' });
});

test('a thrown fetch -> unreachable', async () => {
  const c = makePcAgentClient({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, token: 't' });
  assert.deepEqual(await c.run('http://x', {}), { ok: false, detail: 'unreachable' });
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/devices/pc-agent-client.test.js`. FAIL.

- [ ] **Step 3: Implement** — `orchestrator/devices/pc-agent-client.js`:
```js
// Talks to a JARVIS PC agent over HTTP. POST /run with a bearer token.
// Returns { ok, detail }; never throws.
import { config } from '../config.js';

export function makePcAgentClient({ fetchFn = fetch, token = config.pcAgentToken } = {}) {
  return {
    async run(baseUrl, { capability, action, params } = {}) {
      try {
        const res = await fetchFn(`${baseUrl}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ capability, action, params }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, detail: 'unreachable' };
        const data = await res.json();
        return { ok: !!data?.ok, detail: data?.detail ?? '' };
      } catch {
        return { ok: false, detail: 'unreachable' };
      }
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/devices/pc-agent-client.test.js`, then `npm test`. Pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/devices/pc-agent-client.js orchestrator/devices/pc-agent-client.test.js
git commit -m "devices: pc-agent-client — POST /run with bearer, graceful unreachable"
```

---

## Task 6: intent — "on the <pc>" machine suffix

**Files:** `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`, `orchestrator/intent/index.js`, `orchestrator/intent/index.test.js`.

- [ ] **Step 1: Failing tests**
(a) in `orchestrator/intent/pc.test.js`:
```js
test('open <app> on the <pc> attaches a machine', () => {
  assert.deepEqual(matchPcCommand('open steam on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'open_app', target: 'steam', machine: 'desktop' });
});
test('open <app> with no known pc stays local (no machine)', () => {
  assert.deepEqual(matchPcCommand('open steam', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'open_app', target: 'steam' });
  assert.deepEqual(matchPcCommand('open steam on the laptop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'open_app', target: 'steam on the laptop' });
});
```
(b) in `orchestrator/intent/index.test.js`:
```js
test('cascade passes pcNames so "open x on the desktop" carries a machine', async () => {
  const { intent } = await parseWithSource('open chrome on the desktop', { pcNames: ['desktop'] }, async () => null);
  assert.deepEqual(intent, { domain: 'pc', action: 'open_app', target: 'chrome', machine: 'desktop' });
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/pc.test.js` and `node --test orchestrator/intent/index.test.js`. FAIL.

- [ ] **Step 3: Implement**
(a) `orchestrator/intent/pc.js`: change the signature to `export function matchPcCommand(text, vocab = {}) {`. Add a helper above it:
```js
// Strip a trailing "on (the) <known-pc>" -> { target, machine }.
function splitMachine(target, pcNames) {
  for (const name of pcNames) {
    const re = new RegExp(`^(.+?)\\s+on\\s+(?:the\\s+)?${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`);
    const m = String(target).match(re);
    if (m) return { target: m[1].trim(), machine: name };
  }
  return { target, machine: null };
}
```
Then in the `open_app` branch (currently `if (target) return { domain:'pc', action:'open_app', target };`), replace with:
```js
    if (target) {
      const { target: app, machine } = splitMachine(target, vocab.pcNames ?? []);
      return { domain: 'pc', action: 'open_app', target: app, ...(machine ? { machine } : {}) };
    }
```
(b) `orchestrator/intent/index.js`: in BOTH `parseWithSource` and `parseLocal`, change `matchPcCommand(text)` → `matchPcCommand(text, vocab)`.

- [ ] **Step 4: Run** — both intent test files, then `npm test`. Pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "intent: open_app parses 'on the <pc>' into a machine target"
```

---

## Task 7: router — remote open_app

**Files:** `orchestrator/router.js`, `orchestrator/router.test.js`.

- [ ] **Step 1: Failing tests** — in `orchestrator/router.test.js` (match the board/registry pattern):
```js
test('open_app with a machine routes to the pc agent', async () => {
  const calls = [];
  const agentClient = { run: async (url, body) => { calls.push({ url, body }); return { ok: true, detail: 'Opening steam.' }; } };
  const pcAgents = { get: (n) => (n === 'desktop' ? { name: 'desktop', base_url: 'http://x:7000' } : undefined) };
  const res = await route({ domain: 'pc', action: 'open_app', target: 'steam', machine: 'desktop' },
    { board: fakeBoard(), registry, agentClient, pcAgents });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'Opening steam.');
  assert.equal(calls[0].url, 'http://x:7000');
  assert.deepEqual(calls[0].body, { capability: 'apps', action: 'open', params: { name: 'steam' } });
});

test('open_app with an unknown machine is graceful', async () => {
  const pcAgents = { get: () => undefined };
  const res = await route({ domain: 'pc', action: 'open_app', target: 'steam', machine: 'garage' },
    { board: fakeBoard(), registry, pcAgents, agentClient: { run: async () => ({ ok: true }) } });
  assert.equal(res.ok, false);
  assert.match(res.speak, /don'?t know a pc/i);
});

test('open_app without a machine uses local openApp', async () => {
  let local = false;
  const openApp = () => { local = true; return { ok: true, speak: 'Opening steam.' }; };
  await route({ domain: 'pc', action: 'open_app', target: 'steam' }, { board: fakeBoard(), registry, openApp });
  assert.equal(local, true);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/router.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/router.js`:
(a) Add `agentClient, pcAgents` to the `_route` deps destructure.
(b) Replace the `open_app` branch:
```js
    if (intent.action === 'open_app') {
      if (intent.machine) {
        const a = pcAgents?.get?.(intent.machine);
        if (!a) return { ok: false, speak: `I don't know a PC called ${intent.machine}.` };
        const r = await agentClient.run(a.base_url, { capability: 'apps', action: 'open', params: { name: intent.target } });
        return { ok: r.ok, speak: r.ok ? r.detail : `I couldn't reach the ${intent.machine}.` };
      }
      if (!openApp) return { ok: false, speak: 'PC capability not configured.' };
      return openApp({ name: intent.target });
    }
```

- [ ] **Step 4: Run** — `node --test orchestrator/router.test.js`, then `npm test`. Pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: open_app with a machine routes to the remote PC agent"
```

---

## Task 8: server wiring + suite + finish

**Files:** `orchestrator/server.js`, `CHECKPOINT.md`.

- [ ] **Step 1: Wire the server** — in `orchestrator/server.js`:
(a) Import: `import { makePcAgentClient } from './devices/pc-agent-client.js';`.
(b) In boot, construct: `const agentClient = makePcAgentClient();`.
(c) Add `pcNames: registry.getPcAgents().map((a) => a.name)` to the `vocab` object.
(d) Add `agentClient, pcAgents: { get: registry.getPcAgent }` to BOTH `route(...)` deps (the `makePipeline` `routeDeps` and the boot-level onSwitch `route(...)` call) — and to the `makePipeline({...})` invocation params + its destructure (`agentClient = null, pcAgents = null,`) + `routeDeps`.

- [ ] **Step 2: Verify** — `node -e "import('./orchestrator/server.js').then(()=>console.log('import ok'))"`, then `npm test`. All pass.

- [ ] **Step 3: Commit**
```bash
git add orchestrator/server.js
git commit -m "server: wire pc-agent client + pcNames vocab + pcAgents resolver into routing"
```

- [ ] **Step 4: CHECKPOINT.md** — dated bullet: multi-PC Phase 1 — a dependency-free Node agent (`pc-agent/`) with bearer-auth `/run` + `apps.open`; orchestrator registers agents from `PC_AGENTS` (name=url), parses "on the \<pc\>", and routes `open_app` to the agent (`devices/pc-agent-client.js`); local commands unchanged; needs `PC_AGENT_TOKEN` shared both sides; first agent target = Windows. Commit it.

- [ ] **Step 5: Finish** — superpowers:finishing-a-development-branch to merge `multipc-phase1` into `main`.

- [ ] **Step 6: Host handoff** — Windows: install Node, set `PC_AGENT_TOKEN`, `node pc-agent/index.js`, open the firewall port. Orchestrator `.env`: `PC_AGENT_TOKEN=...` + `PC_AGENTS=desktop=http://<win-ip>:7000`. Restart → "open notepad on the desktop".
