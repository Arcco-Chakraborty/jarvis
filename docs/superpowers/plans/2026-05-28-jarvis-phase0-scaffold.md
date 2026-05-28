# JARVIS Phase 0 (Scaffold) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable JARVIS orchestrator skeleton that serves `GET /health → {"ok":true}`, with the device registry seeded from the §4 channel map and the existing ESP32 adapter wired in and polling the live board.

**Architecture:** A single Node (ESM) Express process. `config.js` reads env (via Node's native `--env-file`); `db/registry.js` opens/seeds a SQLite DB through `better-sqlite3`; `server.js` exposes a pure `buildApp({esp32})` (testable, no network) plus a `main()` composition root that seeds the registry, constructs `Esp32Switch` from it, starts polling, and listens. Tests use the built-in `node:test` runner.

**Tech Stack:** Node.js 22 (ESM), Express, better-sqlite3, `node:test`, `gh` CLI. No `dotenv` (native `--env-file`), no broker, no ORM.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-phase0-scaffold-design.md`

**Implementation notes (refinements from the spec, same behavior):**
- The spec's "config.js throws if `ESP32_BASE_URL` missing" is implemented as a pure, exported `assertEsp32Configured()` called by `main()` — not a throw at module import. Reason: under ESM, import-time throws would break test files that transitively import `config.js`. Same user-facing behavior: booting the real server without the URL fails fast with a clear message.
- `openRegistry` takes an **options object** `{ dbPath, esp32BaseUrl }` (both defaulting to `config`) so tests can inject `:memory:` and a fake URL without depending on env.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `.gitignore` | Exclude `node_modules/`, `.env`, `*.db*` |
| `package.json` | ESM project, scripts (`start`, `test`), deps |
| `.env` | **gitignored** real values (PORT, ESP32 IP, tokens) |
| `.env.example` | committed placeholders |
| `README.md` | what JARVIS is + how to run the orchestrator |
| `orchestrator/config.js` | env → `config` object + `assertEsp32Configured()` |
| `orchestrator/config.test.js` | tests the config assertion |
| `orchestrator/devices/esp32-switch.js` | the existing adapter (moved, unchanged) |
| `orchestrator/db/schema.sql` | §6 schema (`CREATE TABLE IF NOT EXISTS`) |
| `orchestrator/db/registry.js` | open/create DB, run schema, idempotent seed, helpers |
| `orchestrator/db/registry.test.js` | tests schema + seeding |
| `orchestrator/server.js` | `buildApp({esp32})` + `main()` |
| `orchestrator/server.test.js` | tests `/health` and `/state` with a stub board |
| `voice-service/.gitkeep`, `pc-agent/.gitkeep`, `deploy/.gitkeep` | phase placeholders |

---

## Task 1: Project skeleton & dependencies

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Generated: `package-lock.json`, `node_modules/`

> Pure scaffolding — no failing test to write first. The smoke check in Step 4 is the verification.

- [ ] **Step 1: Create `.gitignore`** (must exist before any commit so secrets/DB never get staged)

```gitignore
# dependencies
node_modules/

# secrets & local config
.env

# sqlite database (runtime-generated)
*.db
*.db-journal
*.db-shm
*.db-wal
```

- [ ] **Step 2: Create `package.json`** (deps added in Step 3 so npm resolves current versions with Node-22 prebuilts)

```json
{
  "name": "jarvis-orchestrator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "JARVIS home voice orchestrator",
  "scripts": {
    "start": "node --env-file=.env orchestrator/server.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install express better-sqlite3`
Expected: `added N packages …` with no errors; `node_modules/` and `package-lock.json` created.

- [ ] **Step 4: Smoke-test the native module loads** (this is the `better-sqlite3` build risk gate)

Run:
```bash
node --input-type=module -e "import Database from 'better-sqlite3'; const d=new Database(':memory:'); d.exec('create table t(x)'); d.prepare('insert into t values (1)').run(); console.log('sqlite ok', d.prepare('select count(*) c from t').get().c);"
```
Expected: `sqlite ok 1`

> **If this errors with a node-gyp/compile failure:** the prebuilt binary wasn't available. Mitigate by either `sudo apt install -y build-essential` (user, needs sudo) and re-running `npm install`, or pinning a `better-sqlite3` version that ships a Node-22 prebuilt. Do not proceed until `sqlite ok 1` prints.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json package-lock.json
git commit -m "Add Node project skeleton (ESM) with express + better-sqlite3"
```

---

## Task 2: Env files

**Files:**
- Create: `.env.example` (committed)
- Create: `.env` (gitignored)

- [ ] **Step 1: Create `.env.example`** (placeholders only — no real IP/secret)

```dotenv
PORT=3000
ESP32_BASE_URL=http://192.168.1.50
PC_AGENT_TOKEN=change-me
GEMINI_API_KEY=your-gemini-key-here
```

- [ ] **Step 2: Create `.env`** (real values — this file is gitignored)

```dotenv
PORT=3000
ESP32_BASE_URL=http://192.168.0.202
PC_AGENT_TOKEN=
GEMINI_API_KEY=
```

- [ ] **Step 3: Verify `.env` is ignored and `.env.example` is not**

Run: `git check-ignore .env && git status --short`
Expected: first line prints `.env`; `git status` shows `?? .env.example` and does **not** list `.env`.

- [ ] **Step 4: Commit (only the example)**

```bash
git add .env.example
git commit -m "Add .env.example template (real .env stays gitignored)"
```

---

## Task 3: Config module (TDD)

**Files:**
- Create: `orchestrator/config.js`
- Test: `orchestrator/config.test.js`

- [ ] **Step 1: Write the failing test**

`orchestrator/config.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEsp32Configured } from './config.js';

test('assertEsp32Configured throws when baseUrl is missing', () => {
  assert.throws(
    () => assertEsp32Configured({ esp32: { baseUrl: undefined } }),
    /ESP32_BASE_URL is required/,
  );
});

test('assertEsp32Configured passes when baseUrl is set', () => {
  assert.doesNotThrow(
    () => assertEsp32Configured({ esp32: { baseUrl: 'http://192.168.0.202' } }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test orchestrator/config.test.js`
Expected: FAIL — cannot find module `./config.js` (or `assertEsp32Configured` is not a function).

- [ ] **Step 3: Write minimal implementation**

`orchestrator/config.js`:
```js
// Central config, populated from the environment (loaded via `node --env-file=.env`).
// No secrets or device IPs are hardcoded here — real values live in .env (gitignored).
export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'orchestrator/db/jarvis.db',
  esp32: {
    baseUrl: process.env.ESP32_BASE_URL, // required at boot (see assertEsp32Configured)
  },
  pcAgentToken: process.env.PC_AGENT_TOKEN ?? '', // unused until Phase 3
  geminiApiKey: process.env.GEMINI_API_KEY ?? '', // unused until Phase 4
};

// Fail fast at boot if the board URL is missing. Pure + injectable so it's testable.
export function assertEsp32Configured(cfg = config) {
  if (!cfg.esp32 || !cfg.esp32.baseUrl) {
    throw new Error('ESP32_BASE_URL is required — set it in .env (see .env.example)');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test orchestrator/config.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/config.js orchestrator/config.test.js
git commit -m "Add orchestrator config with ESP32 URL assertion"
```

---

## Task 4: Move the ESP32 adapter into place

**Files:**
- Move: `esp32-switch.js` → `orchestrator/devices/esp32-switch.js` (byte-for-byte unchanged)

> Do **not** edit the adapter. It already matches the firmware.

- [ ] **Step 1: Create the directory and move the file with git**

```bash
mkdir -p orchestrator/devices
git mv esp32-switch.js orchestrator/devices/esp32-switch.js
```

- [ ] **Step 2: Verify the adapter still imports cleanly from its new location**

Run:
```bash
node --input-type=module -e "import { Esp32Switch } from './orchestrator/devices/esp32-switch.js'; console.log(typeof Esp32Switch);"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Move esp32-switch.js into orchestrator/devices/ (unchanged)"
```

---

## Task 5: Schema + registry (TDD)

**Files:**
- Create: `orchestrator/db/schema.sql`
- Create: `orchestrator/db/registry.js`
- Test: `orchestrator/db/registry.test.js`

- [ ] **Step 1: Write the failing test**

`orchestrator/db/registry.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openRegistry } from './registry.js';

function openTestRegistry() {
  return openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://test.local' });
}

test('schema creates the four tables', () => {
  const reg = openTestRegistry();
  const tables = reg._db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['aliases', 'command_log', 'devices', 'switches']);
  reg.close();
});

test('seed inserts the smartswitch device with its base_url', () => {
  const reg = openTestRegistry();
  const board = reg.getBoard();
  assert.equal(board.name, 'smartswitch');
  assert.equal(board.type, 'esp32_switch');
  assert.equal(board.base_url, 'http://test.local');
  reg.close();
});

test('seed inserts the 8-channel map with correct names, channels, and groups', () => {
  const reg = openTestRegistry();
  const rows = reg._db
    .prepare('SELECT name, channel, group_name FROM switches ORDER BY channel')
    .all();
  assert.deepEqual(rows, [
    { name: 'fan 1', channel: 0, group_name: 'fans' },
    { name: 'fan 2', channel: 1, group_name: 'fans' },
    { name: 'tubelight', channel: 2, group_name: 'lights' },
    { name: 'spotlight', channel: 3, group_name: 'lights' },
    { name: 'rgb light', channel: 4, group_name: 'lights' },
    { name: 'night light', channel: 5, group_name: 'lights' },
    { name: 'socket', channel: 6, group_name: 'other' },
    { name: 'spare', channel: 7, group_name: 'other' },
  ]);
  reg.close();
});

test('getSwitchNamesByChannel returns the 8 names ordered 0..7', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getSwitchNamesByChannel(), [
    'fan 1', 'fan 2', 'tubelight', 'spotlight',
    'rgb light', 'night light', 'socket', 'spare',
  ]);
  reg.close();
});

test('seeding is idempotent across reopens (1 device, 8 switches)', () => {
  const dbPath = join(tmpdir(), `jarvis-test-${process.pid}-${Date.now()}.db`);
  try {
    openRegistry({ dbPath, esp32BaseUrl: 'http://test.local' }).close();
    const reg = openRegistry({ dbPath, esp32BaseUrl: 'http://test.local' });
    assert.equal(reg._db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
    assert.equal(reg._db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 8);
    reg.close();
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test orchestrator/db/registry.test.js`
Expected: FAIL — cannot find module `./registry.js`.

- [ ] **Step 3: Create the schema**

`orchestrator/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS devices (
  id        INTEGER PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  type      TEXT NOT NULL,
  base_url  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS switches (
  name       TEXT PRIMARY KEY,
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  channel    INTEGER NOT NULL,
  group_name TEXT
);

CREATE TABLE IF NOT EXISTS aliases (
  alias      TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  intent     TEXT,
  ok         INTEGER,
  detail     TEXT
);
```

- [ ] **Step 4: Create the registry**

`orchestrator/db/registry.js`:
```js
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql');

// channel -> [name, group]. Names match esp32-switch.js DEFAULT_NAMES (lowercased)
// so the registry is the single source of truth and the two never drift.
const CHANNEL_MAP = [
  ['fan 1', 'fans'],
  ['fan 2', 'fans'],
  ['tubelight', 'lights'],
  ['spotlight', 'lights'],
  ['rgb light', 'lights'],
  ['night light', 'lights'],
  ['socket', 'other'],
  ['spare', 'other'],
];

export function openRegistry({ dbPath = config.dbPath, esp32BaseUrl = config.esp32.baseUrl } = {}) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  seed(db, esp32BaseUrl);

  return {
    getBoard: () =>
      db.prepare("SELECT id, name, type, base_url FROM devices WHERE name = 'smartswitch'").get(),
    getSwitchNamesByChannel: () =>
      db.prepare('SELECT name FROM switches ORDER BY channel').all().map((r) => r.name),
    close: () => db.close(),
    _db: db, // exposed for tests/debug only
  };
}

function seed(db, esp32BaseUrl) {
  const insertDevice = db.prepare(
    "INSERT OR IGNORE INTO devices (name, type, base_url) VALUES ('smartswitch', 'esp32_switch', ?)",
  );
  const insertSwitch = db.prepare(
    'INSERT OR IGNORE INTO switches (name, device_id, channel, group_name) VALUES (?, ?, ?, ?)',
  );
  const tx = db.transaction((baseUrl) => {
    insertDevice.run(baseUrl ?? '');
    const board = db.prepare("SELECT id FROM devices WHERE name = 'smartswitch'").get();
    CHANNEL_MAP.forEach(([name, group], channel) => {
      insertSwitch.run(name, board.id, channel, group);
    });
  });
  tx(esp32BaseUrl);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test orchestrator/db/registry.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/db/schema.sql orchestrator/db/registry.js orchestrator/db/registry.test.js
git commit -m "Add SQLite schema + registry with idempotent channel-map seeding"
```

---

## Task 6: Server (TDD)

**Files:**
- Create: `orchestrator/server.js`
- Test: `orchestrator/server.test.js`

- [ ] **Step 1: Write the failing test**

`orchestrator/server.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './server.js';

function stubEsp32(snapshot, online = true) {
  return { snapshot: () => snapshot, online };
}

async function withServer(esp32, fn) {
  const server = buildApp({ esp32 }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('GET /health returns {ok:true}', async () => {
  await withServer(stubEsp32({}), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /state returns the board snapshot and online flag', async () => {
  await withServer(stubEsp32({ tubelight: true, 'fan 1': false }, true), async (base) => {
    const res = await fetch(`${base}/state`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      smartswitch: { tubelight: true, 'fan 1': false },
      online: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test orchestrator/server.test.js`
Expected: FAIL — cannot find module `./server.js`.

- [ ] **Step 3: Write the server**

`orchestrator/server.js`:
```js
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';

// Pure factory — no network, no DB. Takes its dependencies so it is trivially testable.
export function buildApp({ esp32 }) {
  const app = express();

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Debug: current cached state of the smart switch (PROJECT.md §5.1).
  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  return app;
}

// Composition root: seed the registry, wire the real board, poll, and listen (§5.1 boot).
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

  buildApp({ esp32 }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test orchestrator/server.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all 9 tests across `config.test.js` (2), `registry.test.js` (5), `server.test.js` (2). 0 failures.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "Add Express server: GET /health and GET /state, boot wiring per §5.1"
```

---

## Task 7: README + phase directory stubs

**Files:**
- Create: `README.md`
- Create: `voice-service/.gitkeep`, `pc-agent/.gitkeep`, `deploy/.gitkeep`

- [ ] **Step 1: Create the phase placeholder dirs** (git won't track empty dirs without these)

```bash
mkdir -p voice-service pc-agent deploy
touch voice-service/.gitkeep pc-agent/.gitkeep deploy/.gitkeep
```

- [ ] **Step 2: Create `README.md`**

```markdown
# JARVIS

Self-hosted home voice orchestrator. See `PROJECT.md` for the full system spec and
`CHECKPOINT.md` for build status.

## Orchestrator (Phase 0)

Requires Node 18+ (uses global `fetch`, `AbortSignal.timeout`, and `--env-file`).

### Setup

    cp .env.example .env        # then edit .env: set ESP32_BASE_URL to the board's IP
    npm install

### Run

    npm start                   # boots the orchestrator on $PORT (default 3000)
    curl localhost:3000/health  # -> {"ok":true}
    curl localhost:3000/state   # -> cached ESP32 relay states (debug)

### Test

    npm test
```

- [ ] **Step 3: Commit**

```bash
git add README.md voice-service/.gitkeep pc-agent/.gitkeep deploy/.gitkeep
git commit -m "Add README and phase directory placeholders"
```

---

## Task 8: Manual acceptance against the live board

> Verification only — no commit. Confirms the full boot path works end-to-end against the real ESP32 at `192.168.0.202`.

- [ ] **Step 1: Boot the orchestrator** (run in the background or a second terminal)

Run: `npm start`
Expected within a few seconds:
```
JARVIS orchestrator listening on http://localhost:3000
[esp32] online
```

- [ ] **Step 2: Health check**

Run: `curl -s localhost:3000/health`
Expected: `{"ok":true}`

- [ ] **Step 3: State check (live cached relay states)**

Run: `curl -s localhost:3000/state`
Expected: JSON like `{"ok":true,"smartswitch":{"fan 1":...,"tubelight":...,...8 keys...},"online":true}`

- [ ] **Step 4: Stop the server** (Ctrl-C, or kill the background process)

---

## Task 9: Update CHECKPOINT.md

**Files:**
- Modify: `CHECKPOINT.md`

- [ ] **Step 1: Mark Phase 0 done in the TL;DR.** Replace:

```
- **Phase 0 (Scaffold) — NOT STARTED.** No code written yet.
```
with:
```
- **Phase 0 (Scaffold) — DONE.** ESM Node project, seeded SQLite registry, ESP32 adapter wired with polling, `GET /health` + `GET /state` live. `npm test` green.
```

- [ ] **Step 2: Correct the toolchain blocker.** Replace:

```
- **Toolchain not installed on this machine yet** (no node / npm / git / gh). This is the first hard blocker — see *Host / environment* and step 0 of *Immediate next actions*.
```
with:
```
- **Toolchain installed** (verified 2026-05-28): node v22, npm, git, gh, python 3.14. The old blocker is cleared.
```

- [ ] **Step 3: Correct the ESP32 subnet fact.** Replace:

```
- **LAN:** `192.168.1.x` — this host is `192.168.1.167`. The ESP32 `smartswitch` will take a static DHCP lease on this subnet; its base URL goes in `.env`. (`smartswitch.local` won't resolve — no mDNS in the firmware.)
```
with:
```
- **LAN:** this host is `192.168.1.167` (`192.168.1.x`). The ESP32 `smartswitch` is at **`192.168.0.202`** — a *different* /24 (`192.168.0.x`), yet reachable from the host (cross-subnet routing works). Its base URL is in `.env`. (`smartswitch.local` won't resolve — no mDNS.)
```

- [ ] **Step 4: Tick the Phase 0 roadmap checkbox.** Replace:

```
- [ ] **Phase 0 — Scaffold** ← *you are here.* Express + SQLite + seeded registry + `GET /health`.
```
with:
```
- [x] **Phase 0 — Scaffold** — Express + SQLite + seeded registry + `GET /health` (+ `/state`). Done 2026-05-28.
```

- [ ] **Step 5: Commit**

```bash
git add CHECKPOINT.md
git commit -m "Update checkpoint: Phase 0 complete; correct toolchain + ESP32 subnet"
```

---

## Task 10: Create and push the private GitHub repo

> Requires interactive auth — the **user** runs Step 1.

- [ ] **Step 1 (USER ACTION): authenticate `gh`**

In the session, the user runs: `! gh auth login`
Expected: ends with `✓ Logged in as <username>`. Verify with `gh auth status`.

- [ ] **Step 2: Create the private repo and push everything**

Run: `gh repo create jarvis --private --source=. --remote=origin --push`
Expected: `✓ Created repository <user>/jarvis on GitHub` and `✓ Pushed commits to …`.

- [ ] **Step 3: Verify**

Run: `git remote -v && git status --short && git log --oneline`
Expected: `origin` points at the new repo; working tree clean; all Phase 0 commits present.

> Confirm `.env` and `*.db` are **not** in the repo: `git ls-files | grep -E '\.env$|\.db$'` should print nothing.

---

## Acceptance criteria (Phase 0 complete when all true)

- [ ] `npm install` succeeds and the `better-sqlite3` smoke check prints `sqlite ok 1`.
- [ ] `npm test` is green (9 tests, 0 failures).
- [ ] `npm start` boots and logs `listening on http://localhost:3000` + `[esp32] online`.
- [ ] `curl localhost:3000/health` → `{"ok":true}`.
- [ ] `curl localhost:3000/state` → real cached relay states with `"online":true`.
- [ ] Private GitHub repo `jarvis` exists with all commits pushed; `.env` and `*.db` are not tracked.
- [ ] `CHECKPOINT.md` reflects Phase 0 done.
