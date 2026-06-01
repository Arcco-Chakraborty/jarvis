# Wayland Window Control — focus, side-by-side, awareness (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `wayland-windows`

## Motivation

"focus chrome", "put X and Y side by side", "what windows are open" — and the existing `pc/window.js` is **dead on Wayland** (it shells `wmctrl`/`xdotool`, which don't work on GNOME-Wayland). Make window control actually work and add window *awareness*.

### Investigation (this GNOME 50.1 / Wayland box)
- GNOME Shell `Eval` is **locked** (`org.gnome.Shell.Eval` → `(false,'')`); Mutter exposes only display/color/idle over D-Bus (no window list); `wmctrl`/`xdotool`/`ydotool` all absent; `/dev/uinput` is root-only.
- **Decision:** use the **Window Calls** GNOME extension, which exposes `org.gnome.Shell.Extensions.Windows` over D-Bus. The orchestrator drives it with `gdbus call` — no root, no uinput, no Eval, Wayland-native. Delivers both window awareness and focus + side-by-side.

**Out of scope:** multi-monitor placement, quarter-tiling, moving windows across workspaces, keystroke injection.

## The dependency (host, one-time)
Install + enable the **Window Calls** extension (`window-calls@domandoman.xyz`) from extensions.gnome.org (or the GNOME Extensions app). Its D-Bus interface:
`--dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/Windows --method org.gnome.Shell.Extensions.Windows.<M>`
Methods used: `List()→json`, `GetTitle(u id)→s`, `Activate(u id)`, `MoveResize(u id,i x,i y,u w,u h)`, `Minimize(u id)`, `Close(u id)`.
`List()` returns a JSON array of `{id, wm_class, pid, focus, in_current_workspace, ...}`.

If the interface is unreachable (extension not enabled), every window command degrades gracefully (spoken: "I can't control your windows — is the Window Calls extension enabled?"). Never crashes.

## Architecture

Rewrite the **implementation** of `pc/window.js`, keeping the method signatures the router already calls (`focus({name})`, `snap({dir})`, `minimize()`, `close()`, `splitWith({a,b},{openApp})`), and add `list()`. The intent matchers for focus/snap/split/minimize/close are unchanged; add a "list windows" matcher.

### `pc/window.js` (rewrite) — `makeWindow({ gdbus, getWorkArea, aliases })`
- **`gdbus(method, ...args)`** (injected; default shells `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/Windows --method org.gnome.Shell.Extensions.Windows.<method> <args>`), returns parsed stdout. A `windows()` helper calls `List`, strips the gdbus tuple wrapper `('...',)`, and `JSON.parse`s the array. On any error → throws a sentinel the callers turn into the graceful "extension enabled?" line.
- **`list()`** → `windows()` filtered to the current workspace → speak the prettified names ("You have Chrome, VS Code, and Spotify open, sir."). Empty → "No windows are open."
- **`focus({name})`** → `resolve(name)` (match the spoken name against each window's `wm_class` lowercased, then the alias map e.g. chrome→google-chrome, then a `GetTitle` substring fallback) → `Activate(id)`. No match → "I don't see a window for <name>."
- **`snap({dir})`** → find the focused window (`focus:true`) → `MoveResize` it to the left/right half from `getWorkArea()`.
- **`splitWith({a,b}, {openApp})`** → resolve A and B (launch via `openApp` + short wait if a window isn't found, as today) → `MoveResize` A to the left half, B to the right half → "X on the left, Y on the right."
- **`minimize()` / `close()`** → focused window → `Minimize`/`Close`.
- **Geometry — `getWorkArea()`** (injected; default reads env `WINDOW_SCREEN_W`/`WINDOW_SCREEN_H` defaulting to 1920×1080, with `WINDOW_TOP_BAR` default 37): returns `{ left:[0, top, W/2, H-top], right:[W/2, top, W/2, H-top] }`. (A configurable resolution is deliberate — there is no clean CLI for the Wayland work area; the user sets their resolution once. Computed `MoveResize` halves are a v1 approximation of GNOME's native snap.)

### Name resolution
`resolve(name, windows)` is a small pure function: normalize the spoken name; for each window compare against `wm_class` (lowercased) and an alias map (`chrome`→`google-chrome`, `vs code`/`code`→`code`, `files`→`nautilus`, etc.); pick the first match; return its `id` or `null`. Title fallback (`GetTitle`) only if no wm_class match. Pure + unit-tested with canned window lists.

### Intent + router
- `intent/pc.js`: add a **list-windows** matcher → `{domain:'pc', action:'window', op:'list'}` for "what's open", "what windows are open", "list (my) windows", "what windows do i have". (Existing focus/snap/split/minimize/close matchers unchanged.)
- `router.js`: add `case 'list': return win.list();` to the existing window switch. Other cases unchanged.
- `server.js`: construct the rewritten `makeWindow()` (D-Bus default) — wiring already exists (`win: winCap`).

## Error handling
- Any `gdbus`/parse failure in `windows()` → callers return the graceful "extension enabled?" line (`ok:false`, spoken). Never throws.
- Unknown window name → a spoken "I don't see a window for <name>."
- All methods are async and return `{ok, speak}`.

## Testing
- **`resolve`:** "chrome" → the google-chrome window id; alias map; no match → null; case-insensitive.
- **`window.js`:** injected `gdbus` returning a canned `List` JSON — `focus('chrome')` issues `Activate <id>`; `snap('left')` issues `MoveResize <focusedId> 0 <top> <W/2> <H-top>`; `splitWith` MoveResizes A left + B right (and launches a missing app via injected `openApp`); `minimize`/`close` target the focused id; `list` speaks the names; a throwing `gdbus` (extension missing) → graceful line. `getWorkArea` injected so geometry is deterministic.
- **`intent/pc.js`:** "what's open"/"list my windows" → `op:'list'`; non-window phrases unaffected.
- **`router.js`:** `window` op `list` → `win.list()`.

## Verification (on the box, after enabling the extension)
1. Enable Window Calls; restart `npm start`.
2. "hey jarvis, what's open?" → speaks the open window names.
3. "hey jarvis, focus chrome" → Chrome comes to the front.
4. "hey jarvis, put chrome and vs code side by side" → Chrome left half, VS Code right half.
5. "hey jarvis, minimize" / "close" → acts on the focused window.
6. Extension disabled → "I can't control your windows — is the Window Calls extension enabled?" (graceful).
