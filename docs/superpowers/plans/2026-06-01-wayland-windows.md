# Wayland Window Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make window control work on GNOME-Wayland — focus a named window, put two side by side, list what's open — by driving the Window Calls extension's D-Bus interface via `gdbus`, replacing the dead wmctrl/xdotool implementation.

**Architecture:** Rewrite `pc/window.js` to call `org.gnome.Shell.Extensions.Windows` (List/Activate/MoveResize/Minimize/Close) through an injected `gdbus`; keep the method signatures the router already uses and add `list()`. A pure `resolve()` maps a spoken name to a window id. Geometry comes from a configurable `getWorkArea()`. Intent gains a "what's open" matcher; the router gains a `list` case.

**Tech Stack:** Node ESM `node:test`, `node:child_process` execFile (injected), GNOME `gdbus`.

**Spec:** `docs/superpowers/specs/2026-06-01-wayland-windows-design.md`
**Branch:** `wayland-windows` (already created, current with main).

**Test command:** `npm test` / `node --test <file>`.

---

## File Structure
- `orchestrator/pc/window.js` (rewrite) + `window.test.js` (rewrite) — D-Bus window capability + `resolve`.
- `orchestrator/intent/pc.js` (modify) + `pc.test.js` (modify) — "what's open" matcher.
- `orchestrator/router.js` (modify) + `router.test.js` (modify) — `list` case.
- `orchestrator/server.js` — no code change needed (it already constructs `makeWindow()` and injects `win: winCap`); Task 4 just verifies boot + full suite.

---

## Task 1: Rewrite `pc/window.js` — D-Bus window capability

**Files:** Rewrite `orchestrator/pc/window.js`, rewrite `orchestrator/pc/window.test.js`.

- [ ] **Step 1: Replace the test** — overwrite `orchestrator/pc/window.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, resolve } from './window.js';

const WINS = [
  { id: 11, wm_class: 'Google-chrome', focus: false, in_current_workspace: true },
  { id: 22, wm_class: 'Code', focus: true, in_current_workspace: true },
  { id: 33, wm_class: 'firefox', focus: false, in_current_workspace: false },
];

// Fake gdbus: List returns the tuple-wrapped JSON; everything else records + returns '()'.
function harness({ wins = WINS, listThrows = false } = {}) {
  const calls = [];
  const gdbus = async (method, ...args) => {
    calls.push({ method, args });
    if (method === 'List') {
      if (listThrows) throw new Error('no such interface');
      return `('${JSON.stringify(wins)}',)\n`;
    }
    return '()\n';
  };
  const getWorkArea = () => ({ left: [0, 37, 960, 1043], right: [960, 37, 960, 1043] });
  return { calls, w: makeWindow({ gdbus, getWorkArea }) };
}

test('resolve matches a spoken name against wm_class (normalized, substring)', () => {
  assert.equal(resolve('chrome', WINS), 11);
  assert.equal(resolve('code', WINS), 22);
  assert.equal(resolve('firefox', WINS), 33);
  assert.equal(resolve('spotify', WINS), null);
});

test('focus activates the matched window', async () => {
  const h = harness();
  const r = await h.w.focus({ name: 'chrome' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.find((c) => c.method === 'Activate'), { method: 'Activate', args: ['11'] });
  assert.match(r.speak, /chrome/i);
});

test('focus on an unknown window is graceful', async () => {
  const r = await harness().w.focus({ name: 'spotify' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t see a window/i);
});

test('snap left moves the focused window to the left half', async () => {
  const h = harness();
  const r = await h.w.snap({ dir: 'left' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.find((c) => c.method === 'MoveResize'),
    { method: 'MoveResize', args: ['22', '0', '37', '960', '1043'] });
});

test('splitWith positions A left and B right', async () => {
  const h = harness();
  const r = await h.w.splitWith({ a: 'chrome', b: 'code' }, {});
  assert.equal(r.ok, true);
  const mrs = h.calls.filter((c) => c.method === 'MoveResize');
  assert.deepEqual(mrs[0], { method: 'MoveResize', args: ['11', '0', '37', '960', '1043'] });
  assert.deepEqual(mrs[1], { method: 'MoveResize', args: ['22', '960', '37', '960', '1043'] });
  assert.match(r.speak, /chrome.*left.*code.*right/i);
});

test('minimize and close target the focused window', async () => {
  const h = harness();
  await h.w.minimize();
  await h.w.close();
  assert.deepEqual(h.calls.find((c) => c.method === 'Minimize'), { method: 'Minimize', args: ['22'] });
  assert.deepEqual(h.calls.find((c) => c.method === 'Close'), { method: 'Close', args: ['22'] });
});

test('list speaks the open window names in the current workspace', async () => {
  const r = await harness().w.list();
  assert.equal(r.ok, true);
  assert.match(r.speak, /chrome/i);
  assert.match(r.speak, /code/i);
  assert.doesNotMatch(r.speak, /firefox/i); // not in current workspace
});

test('a missing extension degrades gracefully', async () => {
  const r = await harness({ listThrows: true }).w.focus({ name: 'chrome' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /window calls|extension/i);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/pc/window.test.js`. FAIL (old wmctrl impl, no `resolve`/`gdbus`).

- [ ] **Step 3: Rewrite** — overwrite `orchestrator/pc/window.js` with:

```js
// PC capability: window — drives the "Window Calls" GNOME extension over D-Bus
// (org.gnome.Shell.Extensions.Windows) via gdbus. Works on Wayland, no root.
// Methods used: List, Activate, MoveResize, Minimize, Close.
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

const DEST = 'org.gnome.Shell';
const PATH = '/org/gnome/Shell/Extensions/Windows';
const IFACE = 'org.gnome.Shell.Extensions.Windows';

// Spoken-name shortcuts for windows whose wm_class isn't an obvious substring.
const ALIASES = {
  browser: 'chrome', editor: 'code', 'vs code': 'code',
  files: 'nautilus', terminal: 'gnome-terminal',
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]/g, '');

// Pure: spoken name -> window id (or null). Matches wm_class first, then title.
export function resolve(name, windows) {
  const want = norm(ALIASES[String(name).toLowerCase().trim()] || name);
  if (!want) return null;
  for (const w of windows) {
    const cls = norm(w.wm_class);
    if (cls && (cls.includes(want) || want.includes(cls))) return w.id;
  }
  for (const w of windows) {
    if (w.title && norm(w.title).includes(want)) return w.id;
  }
  return null;
}

function pretty(wmClass) {
  return String(wmClass || '')
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function defaultGdbus(method, ...args) {
  return execFileAsync('gdbus', [
    'call', '--session', '--dest', DEST, '--object-path', PATH,
    '--method', `${IFACE}.${method}`, ...args.map(String),
  ], { timeout: 8000 }).then(({ stdout }) => stdout);
}

function defaultWorkArea() {
  const W = parseInt(process.env.WINDOW_SCREEN_W || '1920', 10);
  const H = parseInt(process.env.WINDOW_SCREEN_H || '1080', 10);
  const top = parseInt(process.env.WINDOW_TOP_BAR || '37', 10);
  const halfW = Math.floor(W / 2);
  return { left: [0, top, halfW, H - top], right: [halfW, top, W - halfW, H - top] };
}

const EXT_ERROR = { ok: false, speak: "I can't control your windows — is the Window Calls extension enabled?" };

export function makeWindow({ gdbus = defaultGdbus, getWorkArea = defaultWorkArea } = {}) {
  // Returns the parsed window array, or null if the extension/D-Bus is unreachable.
  async function windows() {
    try {
      const out = await gdbus('List');
      const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  const focusedId = (wins) => (wins.find((w) => w.focus) || {}).id;

  return {
    async focus({ name } = {}) {
      const key = String(name ?? '').trim();
      if (!key) return { ok: false, speak: 'I need a window name to focus.' };
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const id = resolve(key, wins);
      if (id == null) return { ok: false, speak: `I don't see a window for ${key}.` };
      await gdbus('Activate', String(id));
      return { ok: true, speak: `Focusing ${key}.` };
    },

    async snap({ dir } = {}) {
      const d = String(dir ?? '').toLowerCase();
      if (d !== 'left' && d !== 'right') return { ok: false, speak: 'I can snap left or right.' };
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const id = focusedId(wins);
      if (id == null) return { ok: false, speak: 'No window is focused.' };
      await gdbus('MoveResize', String(id), ...getWorkArea()[d].map(String));
      return { ok: true, speak: `Snapped ${d}.` };
    },

    async splitWith({ a, b } = {}, { openApp } = {}) {
      const A = String(a ?? '').trim();
      const B = String(b ?? '').trim();
      if (!A || !B) return { ok: false, speak: 'I need two windows to split.' };
      const area = getWorkArea();
      async function place(name, half) {
        let wins = await windows();
        if (!wins) return EXT_ERROR;
        let id = resolve(name, wins);
        if (id == null && openApp) {
          const o = openApp({ name });
          if (!o.ok) return o;
          await new Promise((r) => setTimeout(r, 1200));
          wins = await windows();
          id = wins ? resolve(name, wins) : null;
        }
        if (id == null) return { ok: false, speak: `I don't see a window for ${name}.` };
        await gdbus('MoveResize', String(id), ...area[half].map(String));
        return { ok: true };
      }
      const ra = await place(A, 'left'); if (!ra.ok) return ra;
      const rb = await place(B, 'right'); if (!rb.ok) return rb;
      return { ok: true, speak: `${A} on the left, ${B} on the right.` };
    },

    async minimize() {
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const id = focusedId(wins);
      if (id == null) return { ok: false, speak: 'No window is focused.' };
      await gdbus('Minimize', String(id));
      return { ok: true, speak: 'Minimized.' };
    },

    async close() {
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const id = focusedId(wins);
      if (id == null) return { ok: false, speak: 'No window is focused.' };
      await gdbus('Close', String(id));
      return { ok: true, speak: 'Closed.' };
    },

    async list() {
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const names = wins
        .filter((w) => w.in_current_workspace !== false)
        .map((w) => pretty(w.wm_class));
      if (names.length === 0) return { ok: true, speak: 'No windows are open, sir.' };
      const list = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return { ok: true, speak: `You have ${list} open, sir.` };
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/pc/window.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/pc/window.js orchestrator/pc/window.test.js
git commit -m "pc: window capability drives Window Calls over D-Bus (Wayland focus/snap/split/list)"
```

---

## Task 2: intent — "what's open" → window list

**Files:** `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/intent/pc.test.js`, in the window section, add:
```js
test('"what\'s open" / "list my windows" -> window list', () => {
  assert.deepEqual(matchPcCommand("what's open"), { domain: 'pc', action: 'window', op: 'list' });
  assert.deepEqual(matchPcCommand('what windows are open'), { domain: 'pc', action: 'window', op: 'list' });
  assert.deepEqual(matchPcCommand('list my windows'), { domain: 'pc', action: 'window', op: 'list' });
  assert.deepEqual(matchPcCommand('list windows'), { domain: 'pc', action: 'window', op: 'list' });
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/pc.test.js`. FAIL (no list matcher).

- [ ] **Step 3: Implement** — in `orchestrator/intent/pc.js`, add the matcher just before the `// window` matcher loop (the `for (const [re, op, argFrom] of WINDOW)` block):
```js
  // what's open -> list windows
  if (/^(?:what'?s open|what is open|what windows are open|what windows do i have(?: open)?|list (?:my )?windows)$/.test(norm)) {
    return { domain: 'pc', action: 'window', op: 'list' };
  }
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/pc.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent: 'what's open' / 'list my windows' -> window list"
```

---

## Task 3: router — `list` case

**Files:** `orchestrator/router.js`, `orchestrator/router.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/router.test.js`, add:
```js
test('window list -> win.list()', async () => {
  const win = { list: async () => ({ ok: true, speak: 'You have Chrome open, sir.' }) };
  const res = await route({ domain: 'pc', action: 'window', op: 'list' }, { board: fakeBoard(), registry, win });
  assert.equal(res.ok, true);
  assert.match(res.speak, /chrome/i);
});
```
(Match the file's `fakeBoard()`/`registry` pattern — adapt if it uses per-test `reg()`.)

- [ ] **Step 2: Run** — `node --test orchestrator/router.test.js`. FAIL (no `list` case → "I don't know how to do that.").

- [ ] **Step 3: Implement** — in `orchestrator/router.js`, in the `if (intent.action === 'window')` switch, add a case (alongside focus/snap/minimize/close/split):
```js
        case 'list':     return win.list();
```

- [ ] **Step 4: Run** — `node --test orchestrator/router.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: window 'list' op -> win.list()"
```

---

## Task 4: boot verification + full suite

**Files:** none code (verification).

- [ ] **Step 1: Confirm the server still constructs the window capability** — `grep -n "makeWindow\|win: winCap" orchestrator/server.js`. It already calls `const winCap = makeWindow();` and injects `win: winCap` into route + makePipeline. The rewritten `makeWindow()` keeps the same no-arg construction (gdbus defaults), so no server edit is needed. If `makeWindow` is constructed with args that no longer apply (e.g. `{ spawn }`), update that call to `makeWindow()`.

- [ ] **Step 2: Boot-import check** — `node -e "import('./orchestrator/server.js').then(()=>console.log('import ok')).catch(e=>{console.error(e);process.exit(1)})"` → `import ok`.

- [ ] **Step 3: Full suite** — `npm test`. All pass.

- [ ] **Step 4: Commit (only if a server edit was needed in Step 1)**
```bash
git add orchestrator/server.js
git commit -m "server: construct rewritten window capability (gdbus defaults)"
```
(If no edit was needed, skip — nothing to commit.)

---

## Task 5: checkpoint, finish, install instructions

**Files:** `CHECKPOINT.md`.

- [ ] **Step 1: Update CHECKPOINT.md** — dated bullet: window control now works on Wayland via the Window Calls GNOME extension driven by `gdbus` (replaces dead wmctrl/xdotool); `pc/window.js` rewritten with `focus`/`snap`/`splitWith`/`minimize`/`close`/`list`; "what's open" speaks the open windows; side-by-side uses computed half-screen `MoveResize` from `WINDOW_SCREEN_W`/`H` (default 1920×1080, top bar 37). **Requires the Window Calls extension enabled** (`window-calls@domandoman.xyz`); degrades gracefully if absent. Commit:
```bash
git add CHECKPOINT.md && git commit -m "checkpoint: Wayland window control via Window Calls D-Bus"
```

- [ ] **Step 2: Finish the branch** — use superpowers:finishing-a-development-branch to merge `wayland-windows` into `main`.

- [ ] **Step 3: Hand off install + live e2e** (needs the user):
  1. Install the extension: open the GNOME Extensions app or visit `https://extensions.gnome.org/extension/4724/window-calls/`, install, and enable it (or `gnome-extensions install` then log out/in). Quick check it's live:
     `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/Windows --method org.gnome.Shell.Extensions.Windows.List` → should print a JSON window list.
  2. If your screen isn't 1920×1080, set `WINDOW_SCREEN_W`/`WINDOW_SCREEN_H` in `.env`.
  3. Restart via `! ./run-jarvis.sh`, then: "what's open?" → speaks windows; "focus chrome"; "put chrome and vs code side by side"; "minimize"/"close".
```
