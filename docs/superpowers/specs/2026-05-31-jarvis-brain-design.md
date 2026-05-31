# JARVIS Brain — Generalized Gemini + Knowledge Answers + Persona (design)

**Date:** 2026-05-31
**Status:** approved, pre-implementation
**Branch:** `jarvis-brain`

## Motivation

Three gaps surfaced in live use:
1. The Gemini fallback is **switch-only** — its prompt/validator can only emit light/fan actions, so it never rescues PC commands (open/play/search/window/shell) the local rules miss. "The whole point of the fallback" is defeated.
2. There's no way to **ask JARVIS a question** — "find out about \<topic\>" should return a spoken answer, not a web search.
3. No **personality** — every confirmation is flat ("Tubelight is off.").

This spec makes Gemini the real brain: a general fallback that can emit **any** intent (including a confirm-gated shell command) or answer a question, plus a knowledge-answer path and a light persona layer. Control commands stay offline and instant.

**Decisions (from brainstorming):**
- Tone: **knowledge answers** get the full Stark-JARVIS voice (Gemini); **control commands** stay offline but draw witty lines from a small curated set. No per-command API calls.
- Shell: Gemini may **propose an arbitrary command**, but it always routes through the **existing confirmation gate** ("Should I run `<cmd>`? Say confirm.").
- "look up / search X" = **web (Chrome)**; "find out about X" = **spoken answer**.

**Out of scope** (separate cycles): Wayland window control, `playerctl`/Spotify, music-restart verification.

## Architecture

Five focused units. The fast offline cascade (switch → pc → confirm) is unchanged; `ask` slots in and Gemini is upgraded as the final fallback.

```
parse cascade:  switch → pc → ask(local) → confirm → gemini-brain
route():        ...existing domains... + ask → knowledge.answer ;  persona post-processes control speak
pipeline:       shell intent (recipe name OR raw command) → confirm gate → shell.execute
```

### 1. `intent/ask.js` (new) — local knowledge-question matcher
Pure matcher. Returns `{ domain:'ask', query }` for:
- `find out about <q>`, `tell me about <q>`, `what is/are <q>`, `who is/are <q>`, `why/how <q>` (a small, explicit set — not a catch-all, so it doesn't swallow control commands).
Reuses the same `normalize()` style as `pc.js`/`confirm.js`. Empty/edge → `null`.

### 2. `look up` → web search (`intent/pc.js`)
Extend the existing search matcher so `look up <q>` (and keep `search [about|for] <q>`) → `{ domain:'pc', action:'browser', op:'search', arg:q }`. This makes **look up / search = web**, distinct from **find out about = answer**.

### 3. `intent/gemini.js` (rewrite) — the general brain
When the local cascade misses, one Gemini call (low temp, strict JSON, validated) classifies into the **full vocabulary**:
- switch: `on|off|all_off|all_on|status|keep_only|all_off_except` (existing).
- pc: `open_app <app>`, `media play_music/play_pause/stop_music`, `browser search <q>`, window ops (`focus/snap/minimize/close`).
- **shell (proposed command):** `{ domain:'pc', action:'shell', command:'<raw shell command>' }` — a real command string, not a recipe name. Used for "free up disk space" → `apt clean`, etc.
- **question:** `{ domain:'ask', query:'<q>' }` when the input is a question rather than a command.
- `null` when nothing fits.

The prompt is built from the live registry vocab (`deviceNames`, `groupNames`, `appNames`) so targets are constrained; `validate()` rejects intents whose target/app isn't real (except `shell.command` and `ask.query`, which are free-form). Injected `fetchFn`/`apiKey` as today.

### 4. `intent/knowledge.js` (new) — JARVIS-voice answers
`answer(query, { fetchFn, apiKey })` → one Gemini call, **warmer temperature**, system prompt establishing the Stark-JARVIS persona: technically precise, concise, lightly witty, addresses the user as "sir" sparingly. Returns a **2–4 sentence spoken answer** (plain text, no markdown — it's going to TTS). On any failure → a graceful in-character line ("My apologies, sir — I can't reach my knowledge base right now."). Never throws.

### 5. `intent/persona.js` (new) — control quips
Pure. `phrase(intent)` → a witty confirmation string for a recognised control success, or `null` (keep the default). Small curated map keyed by action/target class, e.g.:
- switch off → "Consider it dark." / tubelight off → "Tubelight extinguished."
- all_off → "Powering down. Good night, sir."
- play_music → "Spinning it up."
- open_app → "Opening <app>."
Kept intentionally small and tasteful; unknown intents return `null`.

## Data flow / wiring

- **Cascade** (`intent/index.js`): `switch → pc → ask → confirm → gemini`. `ask.js` is local and free (most questions use "find out about"); Gemini still catches questions phrased without the trigger.
- **`route()`** (`router.js`): gains injected `knowledge` and `persona`.
  - `domain:'ask'` → `await knowledge.answer(intent.query)` → `{ ok:true, speak:<answer> }`.
  - After producing a **successful control** result, post-process its `speak` through `persona.phrase(intent)` (override only when a quip exists). Implemented as a thin wrapper around the existing route logic so the many switch/pc return points aren't each touched.
- **Shell via Gemini** (`server.js makePipeline`): the shell branch currently does `shell.lookup(intent.target)`. Extend: if `intent.command` is present (Gemini-proposed raw command) use it directly; else `shell.lookup(intent.target)` (local "run <recipe>"). Either way it stashes the pending `{ command, expiresAt }` and prompts "Should I run `<cmd>`? Say confirm." — unchanged gate, TTL, and confirm execution. `shell.execute` already runs an arbitrary `sh -c`, so no capability change.
- **Server boot**: construct `makeKnowledge()` and `persona` (static import) and inject into both `route()` call sites + `makePipeline`.

## Error handling
- Gemini brain unreachable/invalid → `null` → orchestrator's existing "Sorry, I didn't catch that." (voice loop sleeps).
- `knowledge.answer` failure → in-character apology line (still `ok:true` so it's spoken, not treated as a miss).
- Shell still cannot execute without an explicit spoken "confirm" within TTL.

## Testing
- `ask.js`: trigger phrases → `{domain:'ask',query}`; control phrases ("turn off the light", "play X") must NOT match ask; empty → null.
- `pc.js`: `look up cats` → browser search; existing search tests stay green.
- `gemini.js`: injected `fetchFn` returning each domain's JSON → validated intents (open_app/play_music/search/window/shell-command/ask); invalid device/app target → null; non-JSON/HTTP error → null. Assert the prompt includes appNames + the action menu.
- `knowledge.js`: injected fetch → returns the answer text; HTTP/parse failure → the in-character fallback, `ok:true`; assert persona framing in the prompt.
- `persona.js`: known intents → quip; unknown → null.
- `router.js`: `domain:'ask'` → calls `knowledge.answer`; persona override applied to a successful switch result; non-control results untouched.
- `server.js`/pipeline: a `{action:'shell', command:'apt clean'}` intent → "Should I run apt clean?" pending; confirm → `shell.execute('apt clean')`.

## Verification (on the box, after restart)
1. "hey jarvis, find out about the James Webb telescope" → a concise, in-character spoken answer.
2. "hey jarvis, look up the weather" → Chrome opens a search; "find out about" does NOT open a browser.
3. A missed command the rules don't cover (e.g. "fire up the code editor") → Gemini routes it (opens VS Code).
4. "hey jarvis, free up some disk space" → "Should I run `<cmd>`? Say confirm." → "confirm" runs it.
5. "hey jarvis, turn off the tubelight" → a witty confirmation, still instant/offline.
