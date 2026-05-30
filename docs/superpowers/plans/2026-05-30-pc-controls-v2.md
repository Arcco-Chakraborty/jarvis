# PC Controls v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover installed apps + add parameterized PC commands (`play <q>` → Spotify search, `search <q>` → browser, `split A with B` → tile two windows) so the orchestrator stops relying on a hardcoded allowlist.

**Architecture:** New `pc/discover.js` parses `.desktop` files into a `{name: exec}` catalog. Existing `apps.js` consumes the catalog (plus a non-gating `apps-aliases.json`) with PATH fallback. New `pc/browser.js`; existing `pc/media.js` and `pc/window.js` each grow one function (`playOnSpotify`, `splitWith`). `intent/pc.js` gains three matchers, ordered so `"play music"` keeps its old meaning. Router dispatches to the new sub-actions. Composition root becomes async (`await buildAppCatalog()`); new `POST /system/rescan` re-runs discovery without restarting.

**Tech Stack:** Node 22 + Express + `node:test`. No new dependencies. Linux-only spawn targets: `xdg-open`, `wmctrl`, `xdotool`, `playerctl`, `pactl`.

---

## File map

**Create:**
- `orchestrator/pc/discover.js`
- `orchestrator/pc/discover.test.js`
- `orchestrator/pc/browser.js`
- `orchestrator/pc/browser.test.js`
- `orchestrator/pc/apps-aliases.json`
- `orchestrator/pc/test-fixtures/desktop/` (3 fixture `.desktop` files)

**Modify:**
- `orchestrator/pc/apps.js` (drop `loadAllowlistSync`, add `buildAppCatalog`, add PATH fallback to `makeOpenApp`)
- `orchestrator/pc/apps.test.js` (add aliases + PATH-fallback tests)
- `orchestrator/pc/media.js` (add `playOnSpotify`)
- `orchestrator/pc/media.test.js` (add test)
- `orchestrator/pc/window.js` (add `splitWith`, inject `which/wmctrl-list/sleep`)
- `orchestrator/pc/window.test.js` (add splitWith test)
- `orchestrator/intent/pc.js` (3 new patterns before existing media `play_pause` matcher? NO — after. See Task 5.)
- `orchestrator/intent/pc.test.js` (add matcher tests)
- `orchestrator/router.js` (dispatch `media.spotify_search`, `browser.search`, `window.split`)
- `orchestrator/router.test.js` (add tests)
- `orchestrator/server.js` (async composition root; `buildAppCatalog`; inject `browser`; new `POST /system/rescan`)
- `orchestrator/server.test.js` (add `/system/rescan` test)

**Delete:**
- `orchestrator/pc/allowlist.json`

---

## Task 1: Desktop-file discovery

**Files:**
- Create: `orchestrator/pc/discover.js`
- Create: `orchestrator/pc/discover.test.js`
- Create: `orchestrator/pc/test-fixtures/desktop/firefox.desktop`
- Create: `orchestrator/pc/test-fixtures/desktop/hidden.desktop`
- Create: `orchestrator/pc/test-fixtures/desktop/visual-studio-code.desktop`

- [ ] **Step 1: Create fixture files**

Create `orchestrator/pc/test-fixtures/desktop/firefox.desktop`:
```
[Desktop Entry]
Name=Firefox
Exec=firefox %u
Type=Application
Categories=Network;
```

Create `orchestrator/pc/test-fixtures/desktop/hidden.desktop`:
```
[Desktop Entry]
Name=Should Not Show
Exec=should-not-show
Type=Application
NoDisplay=true
```

Create `orchestrator/pc/test-fixtures/desktop/visual-studio-code.desktop`:
```
[Desktop Entry]
Name=Visual Studio Code
Exec=/usr/share/code/code --new-window %F
Type=Application
```

- [ ] **Step 2: Write the failing tests**

Create `orchestrator/pc/discover.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { discoverApps, parseDesktopEntry, stripFieldCodes } from './discover.js';

const FIXTURE = join(import.meta.dirname, 'test-fixtures/desktop');

test('stripFieldCodes removes %f %u %F %U %i %c %k', () => {
  assert.equal(stripFieldCodes('firefox %u'), 'firefox');
  assert.equal(stripFieldCodes('/usr/share/code/code --new-window %F'), '/usr/share/code/code --new-window');
  assert.equal(stripFieldCodes('app %i %c %k %f %u'), 'app');
});

test('parseDesktopEntry returns {name, exec} for a normal entry', () => {
  const raw = '[Desktop Entry]\nName=Firefox\nExec=firefox %u\nType=Application\n';
  assert.deepEqual(parseDesktopEntry(raw), { name: 'Firefox', exec: 'firefox', hidden: false, type: 'Application' });
});

test('parseDesktopEntry honors NoDisplay=true', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Application\nNoDisplay=true\n';
  assert.equal(parseDesktopEntry(raw).hidden, true);
});

test('parseDesktopEntry honors Hidden=true', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Application\nHidden=true\n';
  assert.equal(parseDesktopEntry(raw).hidden, true);
});

test('parseDesktopEntry returns null when Exec is missing', () => {
  const raw = '[Desktop Entry]\nName=X\nType=Application\n';
  assert.equal(parseDesktopEntry(raw), null);
});

test('parseDesktopEntry returns null when Type is not Application', () => {
  const raw = '[Desktop Entry]\nName=X\nExec=x\nType=Link\nURL=https://x\n';
  assert.equal(parseDesktopEntry(raw), null);
});

test('discoverApps walks a directory and yields {lower(name): exec}', async () => {
  const map = await discoverApps({ dirs: [FIXTURE] });
  assert.equal(map['firefox'], 'firefox');
  assert.equal(map['visual studio code'], '/usr/share/code/code --new-window');
  assert.equal(map['should not show'], undefined, 'NoDisplay entry must be skipped');
});

test('discoverApps tolerates missing directories', async () => {
  const map = await discoverApps({ dirs: ['/nonexistent/path/zz'] });
  assert.deepEqual(map, {});
});

test('discoverApps merges entries from multiple dirs (later wins on collision)', async () => {
  const map = await discoverApps({ dirs: [FIXTURE, FIXTURE] });
  assert.equal(map['firefox'], 'firefox');
});
```

- [ ] **Step 3: Run the tests, confirm they fail**

```bash
node --test orchestrator/pc/discover.test.js 2>&1 | tail -5
```
Expected: failures referring to "Cannot find module './discover.js'" or similar.

- [ ] **Step 4: Implement `discover.js`**

Create `orchestrator/pc/discover.js`:
```js
// Parse XDG .desktop files into a { lowercased Name: cleaned Exec } map.
// Spec: https://specifications.freedesktop.org/desktop-entry-spec/

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const FIELD_CODES = /\s*%[fFuUickdDnNvm]/g;

export function stripFieldCodes(exec) {
  return String(exec || '').replace(FIELD_CODES, '').trim();
}

export function parseDesktopEntry(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let inEntry = false;
  const kv = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) { inEntry = (t === '[Desktop Entry]'); continue; }
    if (!inEntry) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (kv[key] === undefined) kv[key] = val;
  }
  if (kv.Type !== 'Application') return null;
  const exec = stripFieldCodes(kv.Exec || '');
  if (!exec) return null;
  const hidden = kv.NoDisplay === 'true' || kv.Hidden === 'true';
  return { name: kv.Name || '', exec, hidden, type: kv.Type };
}

const DEFAULT_DIRS = (home) => [
  '/usr/share/applications',
  '/usr/local/share/applications',
  '/var/lib/snapd/desktop/applications',
  '/var/lib/flatpak/exports/share/applications',
  join(home, '.local/share/applications'),
];

export async function discoverApps({
  dirs,
  home = os.homedir(),
  readDir = readdir,
  readFileFn = readFile,
} = {}) {
  const targetDirs = dirs ?? DEFAULT_DIRS(home);
  const out = {};
  for (const dir of targetDirs) {
    let names;
    try { names = await readDir(dir); }
    catch { continue; }   // tolerate ENOENT / EACCES
    for (const f of names) {
      if (!f.endsWith('.desktop')) continue;
      let raw;
      try { raw = await readFileFn(join(dir, f), 'utf8'); }
      catch { continue; }
      const entry = parseDesktopEntry(raw);
      if (!entry || entry.hidden || !entry.name) continue;
      out[entry.name.toLowerCase()] = entry.exec;
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
node --test orchestrator/pc/discover.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/pc/discover.js orchestrator/pc/discover.test.js orchestrator/pc/test-fixtures
git commit -m "pc: discover.js — parse .desktop files into a name->exec map"
```

---

## Task 2: apps.js — buildAppCatalog + PATH fallback

**Files:**
- Create: `orchestrator/pc/apps-aliases.json`
- Modify: `orchestrator/pc/apps.js`
- Modify: `orchestrator/pc/apps.test.js`
- Delete: `orchestrator/pc/allowlist.json`

- [ ] **Step 1: Create the aliases file**

Create `orchestrator/pc/apps-aliases.json`:
```json
{
  "chrome": "google chrome",
  "vs code": "visual studio code",
  "code": "visual studio code",
  "browser": "google chrome",
  "editor": "visual studio code",
  "terminal": "gnome terminal"
}
```

- [ ] **Step 2: Write the failing tests**

Append to `orchestrator/pc/apps.test.js` (keep existing tests as-is):
```js
import { buildAppCatalog } from './apps.js';

test('buildAppCatalog merges discovered apps + aliases (aliases point to canonical entries)', async () => {
  const discover = async () => ({ 'google chrome': 'google-chrome', 'firefox': 'firefox' });
  const aliases  = { 'chrome': 'google chrome', 'browser': 'google chrome', 'editor': 'code-missing' };
  const cat = await buildAppCatalog({ discover, aliases });
  assert.equal(cat['google chrome'], 'google-chrome');     // discovered as-is
  assert.equal(cat['firefox'], 'firefox');                 // discovered as-is
  assert.equal(cat['chrome'], 'google-chrome');            // alias resolved
  assert.equal(cat['browser'], 'google-chrome');           // alias resolved
  assert.equal(cat['editor'], undefined);                  // alias target missing -> dropped
});

test('openApp falls back to PATH for single-token unknown names', () => {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  const openApp = makeOpenApp({ allowlist: { chrome: 'google-chrome' }, spawn });
  const r = openApp({ name: 'htop' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].bin, 'htop');
  assert.deepEqual(calls[0].args, []);
});

test('openApp does NOT PATH-fall-back for multi-word names (would be ambiguous)', () => {
  const openApp = makeOpenApp({
    allowlist: { chrome: 'google-chrome' },
    spawn: () => { throw new Error('should not spawn'); },
  });
  const r = openApp({ name: 'random app' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know/i);
});

test('openApp reports PATH-fallback spawn errors as ok:false', () => {
  const openApp = makeOpenApp({
    allowlist: {},
    spawn: () => { throw new Error('ENOENT'); },
  });
  const r = openApp({ name: 'noprogram' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know/i);
});
```

- [ ] **Step 3: Run the tests, confirm the new ones fail**

```bash
node --test orchestrator/pc/apps.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# fail >= 3`.

- [ ] **Step 4: Modify `apps.js`**

Rewrite `orchestrator/pc/apps.js`:
```js
// PC capability: open_app — spawn an app from a catalog of discovered names
// (with optional aliases) or fall back to PATH for single-token names.

import { spawn as _spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverApps } from './discover.js';

const OPTS = { detached: true, stdio: 'ignore' };

export function loadAliasesSync(path = join(import.meta.dirname, 'apps-aliases.json')) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

// catalog = discovered apps merged with aliases. Aliases pointing to a name
// that wasn't discovered are silently dropped.
export async function buildAppCatalog({
  discover = discoverApps,
  aliases = loadAliasesSync(),
} = {}) {
  const discovered = await discover();
  const out = { ...discovered };
  for (const [alias, target] of Object.entries(aliases || {})) {
    const exec = discovered[String(target).toLowerCase()];
    if (exec) out[String(alias).toLowerCase()] = exec;
  }
  return out;
}

export function makeOpenApp({ allowlist, spawn = _spawn }) {
  return function openApp({ name } = {}) {
    const key = String(name ?? '').toLowerCase().trim();
    if (!key) return { ok: false, speak: "I don't know how to open that." };
    const cmd = allowlist[key];
    if (cmd) {
      try {
        const parts = String(cmd).trim().split(/\s+/);
        const proc = spawn(parts[0], parts.slice(1), OPTS);
        proc?.unref?.();
        return { ok: true, speak: `Opening ${key}.` };
      } catch {
        return { ok: false, speak: `I couldn't open ${key}.` };
      }
    }
    // PATH fallback: only for single-token names (otherwise this becomes a
    // surprising injection vector when users speak garbage).
    if (!key.includes(' ')) {
      try {
        const proc = spawn(key, [], OPTS);
        proc?.unref?.();
        return { ok: true, speak: `Opening ${key}.` };
      } catch {
        return { ok: false, speak: `I don't know how to open ${key}.` };
      }
    }
    return { ok: false, speak: `I don't know how to open ${key}.` };
  };
}
```

- [ ] **Step 5: Delete the old allowlist**

```bash
rm orchestrator/pc/allowlist.json
```

- [ ] **Step 6: Run the apps tests, confirm all pass**

```bash
node --test orchestrator/pc/apps.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/pc/apps.js orchestrator/pc/apps.test.js orchestrator/pc/apps-aliases.json
git rm orchestrator/pc/allowlist.json
git commit -m "pc: replace allowlist.json with discover-based catalog + aliases + PATH fallback"
```

---

## Task 3: `pc/browser.js` — Google search

**Files:**
- Create: `orchestrator/pc/browser.js`
- Create: `orchestrator/pc/browser.test.js`

- [ ] **Step 1: Write the failing tests**

Create `orchestrator/pc/browser.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowser } from './browser.js';

function recorder() {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  return { calls, spawn };
}

test('search() calls xdg-open with a URL-encoded google query', () => {
  const r = recorder();
  const b = makeBrowser({ spawn: r.spawn });
  const res = b.search({ query: 'RISC-V instruction set' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'xdg-open');
  assert.equal(r.calls[0].args[0], 'https://www.google.com/search?q=RISC-V%20instruction%20set');
  assert.match(res.speak, /searching the web for risc-v instruction set/i);
});

test('search() refuses an empty query', () => {
  const b = makeBrowser({ spawn: () => ({ unref: () => {} }) });
  assert.equal(b.search({ query: '' }).ok, false);
  assert.equal(b.search({}).ok, false);
});

test('search() catches spawn errors', () => {
  const b = makeBrowser({ spawn: () => { throw new Error('ENOENT'); } });
  const r = b.search({ query: 'cats' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test orchestrator/pc/browser.test.js 2>&1 | tail -3
```
Expected: failures.

- [ ] **Step 3: Implement `browser.js`**

Create `orchestrator/pc/browser.js`:
```js
// PC capability: browser.search — open a Google search in the default
// browser via xdg-open. Detached + unref'd.

import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeBrowser({ spawn = _spawn } = {}) {
  return {
    search({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need something to search for.' };
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(q);
      try {
        const p = spawn('xdg-open', [url], OPTS);
        p?.unref?.();
        return { ok: true, speak: `Searching the web for ${q}.` };
      } catch {
        return { ok: false, speak: `I couldn't open the browser.` };
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test orchestrator/pc/browser.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/pc/browser.js orchestrator/pc/browser.test.js
git commit -m "pc: browser.search — google via xdg-open"
```

---

## Task 4: `media.playOnSpotify` + `window.splitWith`

**Files:**
- Modify: `orchestrator/pc/media.js`
- Modify: `orchestrator/pc/media.test.js`
- Modify: `orchestrator/pc/window.js`
- Modify: `orchestrator/pc/window.test.js`

- [ ] **Step 1: Write the failing media test**

Append to `orchestrator/pc/media.test.js`:
```js
test('playOnSpotify opens xdg-open with a spotify:search URI', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  const res = m.playOnSpotify({ query: 'discover weekly' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'xdg-open');
  assert.equal(r.calls[0].args[0], 'spotify:search:discover%20weekly');
  assert.match(res.speak, /searching spotify for discover weekly/i);
});

test('playOnSpotify refuses an empty query', () => {
  const m = makeMedia({ spawn: () => ({ unref: () => {} }) });
  assert.equal(m.playOnSpotify({ query: '' }).ok, false);
});
```

- [ ] **Step 2: Add `playOnSpotify` to `pc/media.js`**

Append the function to the object returned by `makeMedia`:
```js
    playOnSpotify({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need a song or playlist name.' };
      const uri = 'spotify:search:' + encodeURIComponent(q);
      try {
        const p = spawn('xdg-open', [uri], OPTS);
        p?.unref?.();
        return { ok: true, speak: `Searching Spotify for ${q}.` };
      } catch {
        return { ok: false, speak: `I couldn't open Spotify.` };
      }
    },
```

- [ ] **Step 3: Run media tests, confirm pass**

```bash
node --test orchestrator/pc/media.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 4: Write the failing window test**

Append to `orchestrator/pc/window.test.js`:
```js
test('splitWith focuses & snaps left if A exists; launches if missing; same for B with right', async () => {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  const openApp = (a) => { calls.push({ openApp: a.name }); return { ok: true, speak: 'opened' }; };
  // wmctrl list: A is running, B is not.
  const listWindows = async () => 'chrome - Google Chrome\n';
  const sleep = async () => { calls.push('slept'); };
  const w = makeWindow({ spawn });
  const res = await w.splitWith({ a: 'chrome', b: 'code' }, { openApp, listWindows, sleep });
  assert.equal(res.ok, true);
  assert.match(res.speak, /chrome on the left, code on the right/i);
  // sequence: focus chrome -> super+Left -> launch code -> sleep -> focus code -> super+Right
  const seq = calls.filter((c) => c.bin || c.openApp || c === 'slept').map((c) =>
    c === 'slept' ? 'sleep' :
    c.openApp ? `openApp:${c.openApp}` :
    `${c.bin} ${c.args.join(' ')}`);
  assert.deepEqual(seq, [
    'wmctrl -a chrome',
    'xdotool key super+Left',
    'openApp:code',
    'sleep',
    'wmctrl -a code',
    'xdotool key super+Right',
  ]);
});

test('splitWith refuses missing args', async () => {
  const w = makeWindow({ spawn: () => ({ unref: () => {} }) });
  assert.equal((await w.splitWith({ a: '', b: 'code' }, {})).ok, false);
  assert.equal((await w.splitWith({ a: 'a' }, {})).ok, false);
});
```

- [ ] **Step 5: Add `splitWith` to `pc/window.js`**

Add to the object returned by `makeWindow`:
```js
    async splitWith({ a, b } = {}, { openApp, listWindows, sleep } = {}) {
      const A = String(a ?? '').trim();
      const B = String(b ?? '').trim();
      if (!A || !B) return { ok: false, speak: 'I need two apps to split.' };
      const ls = listWindows ?? defaultListWindows;
      const napFn = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      async function ensure(app, snapDir) {
        const list = await ls().catch(() => '');
        if (!list.toLowerCase().includes(app.toLowerCase())) {
          if (!openApp) return { ok: false, speak: `I don't have ${app}.` };
          const r = openApp({ name: app });
          if (!r.ok) return r;
          await napFn(900);
        }
        const f = fire('wmctrl', ['-a', app], `Focusing ${app}.`, `focus ${app}`);
        if (!f.ok) return f;
        return fire('xdotool', ['key', snapDir], `Snapped ${app}.`, `snap ${app}`);
      }
      const ra = await ensure(A, 'super+Left'); if (!ra.ok) return ra;
      const rb = await ensure(B, 'super+Right'); if (!rb.ok) return rb;
      return { ok: true, speak: `${A} on the left, ${B} on the right.` };
    },
```

Also add this helper at the top of `window.js` (after `const OPTS = ...`):
```js
import { exec as _exec } from 'node:child_process';
function defaultListWindows() {
  return new Promise((resolve, reject) => {
    _exec('wmctrl -l', (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}
```

- [ ] **Step 6: Run window tests, confirm pass**

```bash
node --test orchestrator/pc/window.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/pc/media.js orchestrator/pc/media.test.js orchestrator/pc/window.js orchestrator/pc/window.test.js
git commit -m "pc: media.playOnSpotify + window.splitWith"
```

---

## Task 5: Intent matchers — play <q>, search <q>, split A with B

**Files:**
- Modify: `orchestrator/intent/pc.js`
- Modify: `orchestrator/intent/pc.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `orchestrator/intent/pc.test.js`:
```js
test('"play music" / "play" stay as play_pause (NOT spotify_search)', () => {
  assert.deepEqual(matchPcCommand('play music'), { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('play'),       { domain:'pc', action:'media', op:'play_pause' });
});

test('"play <query>" routes to spotify_search', () => {
  assert.deepEqual(matchPcCommand('play discover weekly'),
    { domain:'pc', action:'media', op:'spotify_search', arg:'discover weekly' });
  assert.deepEqual(matchPcCommand('play bohemian rhapsody'),
    { domain:'pc', action:'media', op:'spotify_search', arg:'bohemian rhapsody' });
});

test('"search <topic>" and "search about|for <topic>" route to browser.search', () => {
  assert.deepEqual(matchPcCommand('search risc-v'),
    { domain:'pc', action:'browser', op:'search', arg:'risc-v' });
  assert.deepEqual(matchPcCommand('search about the weather'),
    { domain:'pc', action:'browser', op:'search', arg:'the weather' });
  assert.deepEqual(matchPcCommand('search for cats'),
    { domain:'pc', action:'browser', op:'search', arg:'cats' });
});

test('"split A with B" routes to window.split with trimmed multi-word names', () => {
  assert.deepEqual(matchPcCommand('split chrome with code'),
    { domain:'pc', action:'window', op:'split', a:'chrome', b:'code' });
  assert.deepEqual(matchPcCommand('split the firefox with the terminal'),
    { domain:'pc', action:'window', op:'split', a:'firefox', b:'terminal' });
});
```

- [ ] **Step 2: Run intent tests, confirm new ones fail**

```bash
node --test orchestrator/intent/pc.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# fail >= 4`.

- [ ] **Step 3: Add the matchers to `intent/pc.js`**

In `matchPcCommand`, **immediately after** the existing `MEDIA_FIXED` loop and **before** the `SET_VOL` block, add:
```js
  // play <query> -> spotify_search (excludes the literal "music" so play_pause keeps winning above)
  const playQ = norm.match(/^play\s+(?!music$)(.+)$/);
  if (playQ) {
    return { domain: 'pc', action: 'media', op: 'spotify_search', arg: playQ[1].trim() };
  }
```

After the existing window block, **before** the shell `run` block, add:
```js
  // search [about|for] <topic> -> browser.search
  const sQ = norm.match(/^search(?:\s+(?:about|for))?\s+(.+)$/);
  if (sQ && sQ[1].trim()) {
    return { domain: 'pc', action: 'browser', op: 'search', arg: sQ[1].trim() };
  }

  // split <a> with <b> -> window.split (strip a leading "the " from each)
  const sp = norm.match(/^split\s+(.+?)\s+with\s+(.+)$/);
  if (sp) {
    const a = sp[1].replace(/^the\s+/, '').trim();
    const b = sp[2].replace(/^the\s+/, '').trim();
    if (a && b) return { domain: 'pc', action: 'window', op: 'split', a, b };
  }
```

- [ ] **Step 4: Run intent tests, confirm all pass**

```bash
node --test orchestrator/intent/pc.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass >= 14`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent/pc: play <q> / search <q> / split A with B matchers"
```

---

## Task 6: Router — dispatch the new sub-actions

**Files:**
- Modify: `orchestrator/router.js`
- Modify: `orchestrator/router.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `orchestrator/router.test.js`:
```js
test('pc.media spotify_search -> media.playOnSpotify', async () => {
  const calls = [];
  const media = { playOnSpotify: (a) => { calls.push(a); return { ok: true, speak: 'searching' }; } };
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'media', op:'spotify_search', arg:'discover weekly' },
    { board: fakeBoard(), registry, media },
  );
  assert.deepEqual(calls, [{ query: 'discover weekly' }]);
  assert.equal(res.ok, true);
  registry.close();
});

test('pc.browser search -> browser.search', async () => {
  const calls = [];
  const browser = { search: (a) => { calls.push(a); return { ok: true, speak: 'searching' }; } };
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'browser', op:'search', arg:'cats' },
    { board: fakeBoard(), registry, browser },
  );
  assert.deepEqual(calls, [{ query: 'cats' }]);
  assert.equal(res.ok, true);
  registry.close();
});

test('pc.window split -> window.splitWith with openApp + sleep injected', async () => {
  const calls = [];
  const win = {
    splitWith: async (args, deps) => {
      calls.push({ args, hasOpenApp: !!deps.openApp });
      return { ok: true, speak: 'split done' };
    },
  };
  const openApp = () => ({ ok: true, speak: 'opened' });
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'window', op:'split', a:'chrome', b:'code' },
    { board: fakeBoard(), registry, window: win, openApp },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, { a: 'chrome', b: 'code' });
  assert.equal(calls[0].hasOpenApp, true);
  registry.close();
});
```

- [ ] **Step 2: Run router tests, confirm new ones fail**

```bash
node --test orchestrator/router.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# fail >= 3`.

- [ ] **Step 3: Modify `router.js`**

In `route()`, accept `browser` in the destructured deps:
```js
export async function route(intent, { board, registry, openApp, media, window: win, browser } = {}) {
```

In the `media` switch block, add the `spotify_search` case **after `set_volume`**:
```js
        case 'set_volume':    return media.setVolume(intent.arg);
        case 'spotify_search': return media.playOnSpotify({ query: intent.arg });
        default:              return { ok: false, speak: "I don't know how to do that." };
```

In the `window` switch block, add the `split` case **after `close`**:
```js
        case 'close':    return win.close();
        case 'split':    return win.splitWith({ a: intent.a, b: intent.b }, { openApp });
        default:         return { ok: false, speak: "I don't know how to do that." };
```

Add a new top-level branch right after the `window` block, **before** the existing shell fallthrough:
```js
    if (intent.action === 'browser') {
      if (!browser) return { ok: false, speak: 'Browser capability not configured.' };
      if (intent.op === 'search') return browser.search({ query: intent.arg });
      return { ok: false, speak: "I don't know how to do that." };
    }
```

- [ ] **Step 4: Run router tests, confirm all pass**

```bash
node --test orchestrator/router.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# pass >= 18`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: dispatch pc.media.spotify_search, pc.browser.search, pc.window.split"
```

---

## Task 7: Server — async composition + /system/rescan

**Files:**
- Modify: `orchestrator/server.js`
- Modify: `orchestrator/server.test.js`

- [ ] **Step 1: Update imports**

In `orchestrator/server.js`, replace:
```js
import { loadAllowlistSync, makeOpenApp } from './pc/apps.js';
```
with:
```js
import { buildAppCatalog, makeOpenApp } from './pc/apps.js';
import { makeBrowser } from './pc/browser.js';
```

- [ ] **Step 2: Make `main()` async + use a mutable catalog**

`makeOpenApp` closes over the catalog and reads `allowlist[key]` on every call — so if we mutate the same object in place (delete all keys, then `Object.assign(fresh)`), `openApp` and `vocab.appNames` automatically see the updated app list. No need to rebuild `openApp` on rescan.

Replace the current `loadAllowlistSync()` block in `main()`:
```js
  const allowlist = loadAllowlistSync();
  const openApp = makeOpenApp({ allowlist });
```
with:
```js
  const catalogRef = await buildAppCatalog();   // mutable; shared by reference
  const openApp = makeOpenApp({ allowlist: catalogRef });
  const browser = makeBrowser();
```

Replace `vocab`'s `appNames`:
```js
    appNames: Object.keys(catalogRef),
```

Change the function signature: `export function main()` → `export async function main()`.

Update the bottom auto-run guard:
```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

Wire `browser` into the dep bundle in both routing call sites:
- In `makePipeline`'s factory signature add `browser = null` and in its `route(intent, { ... })` call include `browser`.
- In `onSwitch`'s `route(intent, { ... })` call include `browser`.
- In the `main()` call to `makePipeline({...})` pass `browser`.

- [ ] **Step 3: Add `onRescan` to `main()` and pass to `buildApp`**

In `main()`, after `vocab` is defined and before `buildApp({...}).listen(...)`:
```js
  const onRescan = async () => {
    const fresh = await buildAppCatalog();
    for (const k of Object.keys(catalogRef)) delete catalogRef[k];
    Object.assign(catalogRef, fresh);
    vocab.appNames = Object.keys(catalogRef);
    return { appCount: vocab.appNames.length };
  };
```

Update the `buildApp` call:
```js
  buildApp({ esp32, onCommand, onSwitch, onRescan, telemetry, vocab })
    .listen(config.port, () => {
      console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
    });
```

- [ ] **Step 4: Add the `/system/rescan` route in `buildApp`**

Add `onRescan` to `buildApp`'s destructured args:
```js
export function buildApp({
  esp32, onCommand, onSwitch, onRescan, telemetry, vocab,
  weatherFetch = fetch,
  readNetDev = () => readFile('/proc/net/dev', 'utf8'),
  now = Date.now,
}) {
```

Right after the `/state` GET, add:
```js
  app.post('/system/rescan', async (req, res) => {
    if (!onRescan) return res.status(503).json({ ok: false, error: 'no rescanner' });
    try {
      const result = await onRescan();
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
```

- [ ] **Step 5: Write a failing test for `/system/rescan`**

Append to `orchestrator/server.test.js`:
```js
test('POST /system/rescan invokes the onRescan hook and returns the new app count', async () => {
  let called = 0;
  const onRescan = async () => { called++; return { appCount: 42 }; };
  const server = buildApp({ esp32: stubEsp32({}), onRescan }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/system/rescan`, { method: 'POST' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.appCount, 42);
    assert.equal(called, 1);
  } finally { server.close(); }
});

test('POST /system/rescan returns 503 if no onRescan is configured', async () => {
  await withServer(stubEsp32({}), async (base) => {
    const res = await fetch(`${base}/system/rescan`, { method: 'POST' });
    assert.equal(res.status, 503);
  });
});
```

- [ ] **Step 6: Run the full backend suite**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "server: async composition + POST /system/rescan + browser dep wiring"
```

---

## Task 8: Final verify + push

- [ ] **Step 1: Run all backend tests**

```bash
npm test 2>&1 | tail -10
```
Expected: `# fail 0`.

- [ ] **Step 2: Run voice tests (unchanged but sanity)**

```bash
.venv/bin/python -m unittest discover -s voice-service/tests 2>&1 | tail -3
```
Expected: `OK`.

- [ ] **Step 3: Update CHECKPOINT.md**

Add a bullet near the top under the "Phase 3 full" entry:
```
- **Phase 3.5: PC controls v2 — DONE.** Auto-discovered app catalog from .desktop files (no more allowlist.json). New `pc/browser.js` (Google search via xdg-open), `media.playOnSpotify` (spotify:search URI), `window.splitWith` (focus/launch + Super+Left/Right). Intent: `play <q>` (Spotify, with the "music" carve-out so play/pause keeps working), `search [about|for] <q>` (browser), `split A with B` (window). New POST /system/rescan rebuilds the catalog without restarting the orchestrator. PATH fallback for single-token unknown app names. apps-aliases.json (committed, edit-in-place) replaces the old allowlist.
```

- [ ] **Step 4: Commit + push everything**

```bash
git add CHECKPOINT.md
git commit -m "checkpoint: Phase 3.5 PC controls v2"
git push
```
