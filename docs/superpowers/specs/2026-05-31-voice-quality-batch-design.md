# Voice Quality Batch — Wake Threshold, Music→YouTube, Compound Commands (design)

**Date:** 2026-05-31
**Status:** approved, pre-implementation
**Branch:** `voice-quality-batch`

Four "make it work better" improvements from live use. Local-first routing already works (verified: most natural phrasings match offline before Gemini), so the focus is the gaps.

**Out of scope (next dedicated cycle):** Wayland **window control** (focus / side-by-side / window awareness). It needs an environment investigation — `wmctrl`/`xdotool` don't work on this GNOME-Wayland session; the path is a GNOME-Shell D-Bus extension and/or `ydotool` with uinput permissions. Tracked as its own spec.

---

## 1. Lower the wake threshold

`VOICE_WAKE_THRESHOLD` default `0.5 → 0.35` (in `voice-service/config.py`, `voice-service/run-full.sh`, `.env.example`) so "hey jarvis" triggers more readily. Still env-overridable if it becomes too sensitive. No code logic change.

## 2. Music plays the real song in Chrome (`orchestrator/pc/music.js` rewrite)

The mpv approach played the top YouTube result headless with no music bias and no window. Replace it: open the actual song's YouTube page in Chrome (it plays the real song *and* a window comes up).

`makeMusic({ resolve, spawn, browserCmd = google-chrome, hasPlayerctl })`:
- **`play({ query })`** (async): `resolve(query)` returns the top YouTube video id via `yt-dlp --get-id "ytsearch1:<query>"` (injectable; default runs yt-dlp). Then spawn `browserCmd https://www.youtube.com/watch?v=<id>` (detached, unref'd) → `{ ok:true, speak:'Playing <query>.' }`. If `resolve` yields nothing, fall back to opening `https://www.youtube.com/results?search_query=<query>` and speak the same. Empty query → `{ ok:false, speak:'I need a song name.' }`.
- **`pauseResume()` / `stop()`** → `playerctl play-pause` / `playerctl stop` (MPRIS — controls the Chrome/YouTube tab *and* Spotify, one mechanism). If `hasPlayerctl` is false → `{ ok:false, speak:"I can't control playback yet — playerctl isn't installed." }`.
- The mpv IPC socket code (`connect`/`exists`/socket) is removed.

Router/server: `play_music`→`music.play`, `play_pause`→`music.pauseResume`, `stop_music`→`music.stop` (unchanged wiring; the methods change). Server computes `hasPlayerctl` once at boot (`which playerctl`) and injects it.

**Install note:** `yt-dlp` already present. `playerctl` needs `sudo apt install -y playerctl` for pause/stop (and Spotify control); play works without it.

## 3. Keep music phrasings local (`orchestrator/intent/pc.js`)

Extend the `play <query>` matcher so natural music phrasings stay offline instead of falling to Gemini: add **"put on X"**, **"play me X"**, **"i want to hear X"** alongside "play X". Same `play_music` intent. (The `play`/`play music`/`pause` → `play_pause` carve-out stays.)

## 4. Compound commands — "do X and then Y" (`orchestrator/intent/index.js`, `orchestrator/server.js`)

Today a chained utterance matches only its first clause and silently drops the rest. Add sequential multi-command execution.

- **`splitUtterance(text)`** (new, `intent/split.js`): pure splitter on explicit sequencers — ` and then `, ` then `, ` after that `, and ` and `. Returns the list of clause strings (length 1 if none present).
- **`parseLocal(text, vocab)`** (new export in `intent/index.js`): the cascade **without** Gemini (switch → pc → ask → confirm), returning an intent or `null`. (`parseWithSource` stays as-is for the single-command path.)
- **Pipeline** (`makePipeline.onCommand`): before the normal single-command flow, compute `pieces = splitUtterance(text)`. If `pieces.length > 1` AND **every** piece `parseLocal`s to a non-null intent that is **not** `confirm` and **not** a `pc/shell` intent, treat it as a compound: `route()` each piece's intent in order, collect the `speak`s, and return one combined result (`ok:true`, speaks joined). Otherwise fall through to the existing single-command handling of the original `text` (so a stray "and" inside one command — e.g. "all lights except tubelight and socket" — is never wrongly split, because "socket" alone doesn't parse).
- **Guards:** compound is local-only (no per-clause Gemini calls); shell/confirm clauses disqualify the whole utterance from compound treatment (we never auto-run multiple confirm-gated commands), so it falls back to single handling. Cap at a small number of clauses (e.g. 5) to bound work.

## Testing
- `split.js`: "x and then y"/"x then y"/"x and y" → multiple pieces; a plain command → single; multiple connectors handled.
- `parseLocal`: returns local intents without calling Gemini (assert no classify call); returns null for a Gemini-only phrasing.
- `pc.js`: "put on daft punk" / "play me some jazz" / "i want to hear queen" → `play_music`; "play"/"play music" still → `play_pause`.
- `music.js`: `play` calls `resolve` then spawns `browserCmd` with `youtube.com/watch?v=<id>`; resolve-null → opens the search URL; empty query → not ok; `pauseResume`/`stop` spawn `playerctl` when `hasPlayerctl`, else graceful not-ok.
- pipeline: "turn off the tubelight and then play some music" → both clauses execute (two route calls), combined speak; "turn off all lights except tubelight and socket" → treated as single (not split); a compound containing a shell clause → falls back to single.
- config: `wake_threshold` default 0.35.

## Verification (on the box, after restart)
1. "hey jarvis" triggers more easily (threshold 0.35).
2. "play \<song\>" → the actual song opens and plays in a Chrome window. With `playerctl` installed, "pause" / "stop music" control it (and Spotify).
3. "put on \<song\>" stays instant/local.
4. "turn off the tubelight and then play \<song\>" → both happen.
