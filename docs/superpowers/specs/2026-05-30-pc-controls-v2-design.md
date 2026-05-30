# PC Controls v2 — Design

**Date:** 2026-05-30
**Status:** Approved (verbal)
**Supersedes parts of:** the Phase 3 PC vertical (apps.js + allowlist.json)

## Goal

Make the PC layer feel less like a fixed switchboard and more like a real
assistant: parameterized commands (play a *specific* song, search for a
*specific* topic), windowing actions across multiple apps (split A with B),
and an app catalog that reflects what is *actually installed*, not a
hardcoded list.

## Scope

In scope:

- **Auto-discovered app catalog** from `.desktop` files + `$PATH` fallback,
  replacing `pc/allowlist.json`.
- **`play <music>`** — search and open on Spotify.
- **`search <topic>` / `search about <topic>`** — Google search in the
  default browser.
- **`split <app1> with <app2>`** — launch (if needed) + focus + tile both.
- Intent matchers + router branches for the three new sub-actions.
- A `POST /system/rescan` endpoint that re-discovers apps and reloads vocab
  without restarting the orchestrator.

Out of scope (deferred):

- Voice for the **free-form** fields (`{music}`, `{topic}`). Vosk grammar
  mode cannot decode arbitrary text. Free-form fields stay typed-only on
  the dashboard until STT is upgraded (faster-whisper / Parakeet).
- MPRIS-driven *direct play* of a specific track. Spotify's URI scheme
  (`spotify:search:<q>`) opens search results; the user clicks the first
  hit. Future: D-Bus MPRIS for true headless play.

## Architecture

```
                     +------------------+
   typed command --> | parseWithSource  |
   voice (Vosk)  --> |  switch -> pc -> |--> { domain: 'pc', action, ... }
                     |  confirm -> gem  |
                     +------------------+
                              |
                              v
                     +------------------+
                     | route(intent, …) |
                     +------------------+
                       |   |   |    |
                       v   v   v    v
                    apps media win browser
                       |              |
              capabilities/spawn (detached)
                       |
        +--------------+--------------+
        |     (separately)            |
        | makePipeline confirmation   |
        |  for shell only             |
        +-----------------------------+
```

The intent layer + router are unchanged in structure. New surface:

- `intent/pc.js` gains matchers for `pc.media op:'spotify_search'`,
  `pc.browser op:'search'`, and `pc.window op:'split'`.
- `router.js` gains dispatch for these three sub-actions.
- A new `pc/browser.js` capability.
- `pc/media.js`, `pc/window.js`, `pc/apps.js` each grow one function.

## Components

### `pc/discover.js` (new)

**Responsibility:** Return a `Map<lowercased name, exec_command>` of GUI
applications installed on the host.

**How:** Read every `*.desktop` file from these directories (when present):

```
/usr/share/applications
/usr/local/share/applications
/var/lib/snapd/desktop/applications
/var/lib/flatpak/exports/share/applications
~/.local/share/applications
```

For each file, parse the `[Desktop Entry]` section:

- Skip if `NoDisplay=true` or `Hidden=true` or `Type` ≠ `Application`.
- `Name=<display name>` → key (lowercased, trimmed).
- `Exec=<cmd>` → value (strip `%f`, `%u`, `%F`, `%U`, `%i`, `%c`, `%k`
  field codes).

Returns an object: `{ "google chrome": "google-chrome", "spotify": "spotify",
"visual studio code": "code --new-window", ... }`.

**Interface:**

```js
export async function discoverApps({
  dirs?,                 // override for tests
  readDir = readdir,
  readFile = readFile,
  home = os.homedir(),
} = {}): Promise<Record<string, string>>;
```

All filesystem access is injected so the unit tests can use a fixture dir
of fake `.desktop` files.

### `pc/apps.js` (modified)

**Loader:** drop `loadAllowlistSync`. Replace with an async `buildAppCatalog`
that:

1. Calls `discoverApps()`.
2. Reads `pc/apps-aliases.json` (a small `{spoken: canonical}` map, *non-gating*).
3. Merges: aliases point to canonical entries from the discovery result.
   An alias for a name not present in discovery is dropped silently.

Result is the same shape as the old allowlist: `{ spokenName: execCommand }`.

**Runtime resolution:** `makeOpenApp({ catalog, spawn })` is unchanged.
**PATH fallback:** if `catalog[name]` is missing but `name` is a single
non-spaced token, attempt `spawn(name, [], opts)` directly. If `spawn`
throws (`ENOENT`), return the usual `"I don't know how to open <x>."`.

### `pc/apps-aliases.json` (new, committed)

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

Replaces `allowlist.json`. The "allowlist" semantic is gone — aliases
never block, they only rename. Committed (not gitignored) so the defaults
travel with the repo; users edit in-place and their changes are tracked.
A non-existent alias target is silently ignored (so per-host edits don't
crash the build).

### `pc/media.js` (modified)

Add `playOnSpotify({ query })`:

- `xdg-open "spotify:search:<URL-encoded query>"`
- Speaks `"Searching Spotify for <query>."`

Rationale: works whether or not Spotify is currently running. Spotify
auto-launches and shows the search. Future MPRIS work can replace this with
"play first result" without changing the intent contract.

### `pc/browser.js` (new)

`makeBrowser({ spawn })` exposes:

- `search({ query })` → `xdg-open "https://www.google.com/search?q=<URL-encoded query>"`.
- Speaks `"Searching the web for <query>."`

`xdg-open` opens the user's default browser. No need to know whether it's
Chrome or Firefox.

### `pc/window.js` (modified)

Add `splitWith({ a, b }, { openApp, sleep })`:

1. If `wmctrl -l` doesn't list a window matching `a`, call `openApp({name: a})` and `await sleep(900)`.
2. `wmctrl -a <a>` to focus it; `xdotool key super+Left`.
3. If `wmctrl -l` doesn't list a window matching `b`, call `openApp({name: b})` and `await sleep(900)`.
4. `wmctrl -a <b>` to focus it; `xdotool key super+Right`.
5. Returns `{ ok: true, speak: "<A> on the left, <B> on the right." }`.

Failures (missing app, wmctrl not installed) → `ok:false` with a friendly message.

`sleep` is injected for tests so they don't actually wait.

### `intent/pc.js` (modified)

Three new patterns, inserted **after** the existing media `play_pause`/`pause`
matchers (so `play music` / `play` still mean play-pause):

```js
// play <query> where <query> is non-empty and not exactly "music"
/^play\s+(?!music$)(.+)$/  -> { domain:'pc', action:'media',
                                op:'spotify_search', arg: query }

// search [about] <topic>
/^search(?:\s+about|\s+for)?\s+(.+)$/ -> { domain:'pc', action:'browser',
                                            op:'search', arg: topic }

// split <a> with <b>
/^split\s+(.+?)\s+with\s+(.+)$/ -> { domain:'pc', action:'window',
                                      op:'split', a, b }
```

`<a>` and `<b>` get the `"the "` prefix stripped (same as `open_app`).

### `router.js` (modified)

Add cases:

```js
case 'spotify_search': return media.playOnSpotify({ query: intent.arg });
// pc.browser
if (intent.action === 'browser' && intent.op === 'search')
  return browser.search({ query: intent.arg });
// pc.window split
case 'split': return win.splitWith({ a: intent.a, b: intent.b }, { openApp, sleep });
```

### `server.js` (modified)

- Composition: `await buildAppCatalog()` instead of `loadAllowlistSync()`.
  `vocab.appNames` becomes `Object.keys(catalog)` — the *discovered* names.
- Inject `browser`, `media`, `win`, `openApp` into `route()` (extend the
  dep bundle).
- New endpoint `POST /system/rescan` → re-runs `buildAppCatalog()`, updates
  `vocab.appNames`, and includes the count in the response. The voice
  service picks up the new vocab on its next `/vocab` fetch (it does this
  at startup; we'll add a /voice/event-style "vocab_changed" later if
  needed — for now a voice-service restart is fine, the apps that *were*
  in the grammar still work).

## Data flow examples

**Voice "open spotify"**
1. STT → "open spotify" → orchestrator.
2. `matchPcCommand` → `{domain:'pc', action:'open_app', target:'spotify'}`.
3. Router → `openApp({name:'spotify'})`.
4. Catalog lookup → `"spotify"`. `spawn('spotify', [], detached)`. ✓

**Typed "play discover weekly"**
1. Dashboard `POST /command {text:"play discover weekly"}`.
2. `matchPcCommand`: `"play music"`/`"play"` matchers miss
   (regex `(?!music$)` blocks "music" alone). The `play <q>` matcher fires.
3. Intent: `{domain:'pc', action:'media', op:'spotify_search', arg:'discover weekly'}`.
4. Router → `media.playOnSpotify({query:'discover weekly'})`.
5. Spawn `xdg-open spotify:search:discover%20weekly`. ✓

**Typed "search about RISC-V"**
1. Intent: `{domain:'pc', action:'browser', op:'search', arg:'risc-v'}`.
2. Router → `browser.search({query:'risc-v'})`.
3. Spawn `xdg-open https://www.google.com/search?q=risc-v`. ✓

**Typed "split chrome with code"**
1. Intent: `{domain:'pc', action:'window', op:'split', a:'chrome', b:'code'}`.
2. Router → `win.splitWith({a:'chrome', b:'code'}, {openApp, sleep})`.
3. wmctrl finds no chrome window → `openApp({name:'chrome'})` → sleep 900ms.
4. wmctrl -a chrome; xdotool super+Left.
5. wmctrl finds no code window → `openApp({name:'code'})` → sleep 900ms.
6. wmctrl -a code; xdotool super+Right. ✓

## Error handling

- **`xdg-open` missing:** spawn throws `ENOENT`. Capability catches → `"I
  couldn't open that."` (same shape as other failures).
- **No `.desktop` directories accessible:** `discoverApps()` returns `{}`;
  `vocab.appNames` is empty; voice "open chrome" fails through the rules
  (no alias / catalog entry) and the user gets `"I don't know how to open
  chrome."` Actionable: edit `apps-aliases.json` or rescan after install.
- **`wmctrl` / `xdotool` not installed:** spawn throws → capability returns
  `ok:false` with a clear message. Document in CHECKPOINT what to apt-install.
- **Split: app doesn't open within 900ms:** wmctrl -a may match nothing,
  super+Left/Right snaps whatever is focused. Mildly broken UX; documented.

## Testing

Same TDD pattern we've used:

- `pc/discover.test.js`: feed a fixture dir of `.desktop` files (one
  `NoDisplay=true`, one missing `Exec=`, one with `%f` field codes) →
  assert the produced map.
- `pc/apps.test.js`: extend with PATH-fallback test (spawn succeeds for an
  unknown name); aliases test.
- `pc/browser.test.js`: stub spawn, assert correct URL passed to xdg-open.
- `pc/media.test.js`: `playOnSpotify` test (stubbed spawn, assert URI).
- `pc/window.test.js`: `splitWith` with stubbed wmctrl probe + spawn +
  sleep → assert sequence of spawn calls.
- `intent/pc.test.js`: new matcher tests including the `"play music"` /
  `"play <q>"` disambiguation, `"search about X"` variants, split with
  multi-word app names.
- `router.test.js`: extend with the new sub-actions.
- `server.test.js`: `POST /system/rescan` returns updated count; the new
  vocab is reflected in subsequent `/vocab` GETs.

Voice tests stay green (no API changes; discovered app names just flow
through the existing pipeline).

## Migration & cleanup

- `pc/allowlist.json` is deleted. `pc/apps-aliases.json` replaces it
  (committed, not gitignored).
- `loadAllowlistSync` is removed. Anything that imported it (just
  server.js) is updated.

## Non-goals (explicit)

- Voice for free-form `{music}` / `{topic}` arguments — needs the better
  STT. Until then, those commands work via the dashboard text input.
- Permission gating on apps. Open is open; if it's installed on the host,
  voice or text can launch it. Risky commands stay gated by the existing
  shell-with-confirmation flow.
- App icons in the dashboard. Future polish.
