# JARVIS — Voice UX + Media Fixes (design)

**Date:** 2026-05-31
**Status:** approved, pre-implementation
**Branch:** `voice-ux-media-fixes`

Three independent fixes the user hit after the GPU-Whisper STT landed:

1. **"play \<song\>" doesn't play** — it only opens a Spotify *search*.
2. **Browser search doesn't open Chrome.**
3. **Voice loop feels unresponsive and keeps listening** — should be one command per wake, then sleep; and switch from "listening" to "thinking" the moment the user stops talking.

Discovered while scoping: this host is **missing `playerctl`, `pactl`, `mpv`, `yt-dlp`**. Chrome *is* installed and is the default browser. So media transport/volume for arbitrary apps is broken at the binary level; the music fix sidesteps that with a self-contained `mpv` player.

---

## 1. Music that actually plays — `orchestrator/pc/music.js` (new)

No accounts: "play \<song\>" plays the song's audio from YouTube via `mpv` + `yt-dlp`, matching PROJECT.md §5.5's original music plan.

**`makeMusic({ spawn, connect } = {})`** owns a single `mpv` process controlled over an IPC socket. Fixed socket path `/tmp/jarvis-mpv.sock`.

- **`play(query)`** — stop any current mpv, then spawn detached + unref'd:
  `mpv --no-video --no-terminal --input-ipc-server=/tmp/jarvis-mpv.sock "ytdl://ytsearch1:<query>"`
  (mpv plays the result then exits; the IPC socket lives for the duration).
  Returns `{ ok:true, speak:'Playing <query>.' }`. Empty query → `{ ok:false, speak:'I need a song name.' }`.
- **`pauseResume()`** (toggle) — send `{"command":["cycle","pause"]}` to the socket → `'Toggling playback.'`
- **`stop()`** — send `{"command":["quit"]}` (fallback: kill tracked pid) → `'Stopping the music.'`
- IPC helper: `connect(socketPath)` (injectable; default a thin `net.connect` writer) writes one JSON line and closes. If the socket isn't there (nothing playing), control ops fail soft: `{ ok:false, speak:'Nothing is playing.' }`.

**Intent / router wiring:**
- `intent/pc.js`: the `play <query>` matcher changes `op:'spotify_search'` → **`op:'play_music'`** (`arg` = query). Add a `stop_music` op matched by `^stop(?:\s+(?:the\s+)?music|\s+playing)$` (i.e. "stop music" / "stop the music" / "stop playing"); bare "stop" stays the voice sleep word, untouched.
- `router.js`: dispatch `media` ops `play_music`→`music.play({query:arg})`, `play_pause`→`music.pauseResume()`, `stop_music`→`music.stop()`. The other media ops (`next`/`prev`/`volume*`/`mute`) keep their current `media.js` (playerctl/pactl) path — still binary-broken on this host, **explicitly out of scope** (noted, not fixed here).
- Retire `media.playOnSpotify` and the `spotify_search` op (no remaining callers after the matcher change).

**Install:** `mpv` + `yt-dlp` via apt (host action; documented in the plan + CHECKPOINT).

## 2. Browser search opens Chrome — `orchestrator/pc/browser.js`

Root cause is execution, not intent (`search for X` matches the rule layer fine). Replace the `xdg-open` indirection with a **direct browser launch**:

- `makeBrowser({ spawn, browserCmd = 'google-chrome' } = {})`. `search({query})` spawns `browserCmd <google-search-url>` detached + unref'd. Same speak text.
- `browserCmd` is config-driven (`BROWSER_CMD` env, default `google-chrome`) so it's overridable.
- During implementation: verify the real `xdg-open` failure on this box; if `xdg-open` actually works, prefer it, but default to the explicit Chrome launch since Chrome is installed and is the confirmed default. Whatever genuinely opens a window wins.

## 3. One-shot voice loop + responsive "thinking" — `voice-service/main.py`, `stt.py`

**One command per wake, then sleep (silent on miss):**
- `run_conversation` collapses to: emit `recording`; `text = listen_fn()`; if `text` is a real command string → `handle_fn(text)` (dispatch + speak the reply), emit `idle`; for **anything else** (`None` silence / `""` not-understood / `STOP`) → return silently. No retries, no follow-up, no "didn't catch that," no `unrecognized_fn`/`cancel_fn`/`max_unrecognized`. Those params are removed from the signature and from the `run_loop` call site.
- The post-conversation cooldown (`post_conversation_cooldown_s`) stays — it prevents the wake listener from re-firing on Jarvis's own TTS.
- `STOP_PHRASES` handling in `stt.py` stays (so "stop" doesn't dispatch as a command); it simply causes a silent sleep now.

**Responsive recording → thinking:**
- `WhisperSTT.listen(max_initial_silence, max_utterance, on_transcribing=None)` calls `on_transcribing()` exactly once, right after the recorder returns captured audio (VAD end-of-speech) and before the Whisper call. (Pure helpers unchanged; only `WhisperSTT.listen` gains the optional hook.)
- `run_conversation` passes `on_transcribing=lambda: reporter.emit("thinking")`, so the HUD flips `recording → thinking` the instant the user stops talking — even though Whisper then takes a few seconds. `None` (no speech) never fires it.
- `vad_silence_ms` default 800 → **600** (snappier cut-over; still env-tunable).

---

## Testing

- **`music.js`** (Node `node:test`): injected `spawn` + injected `connect`. Assert `play('daft punk')` spawns `mpv` with args including `ytdl://ytsearch1:daft punk` and the IPC socket flag; `pauseResume()` writes `{"command":["cycle","pause"]}`; `stop()` writes `{"command":["quit"]}`; empty query → not ok; control with no socket → fails soft.
- **`browser.js`**: assert `search({query:'cats'})` spawns `browserCmd` (default `google-chrome`) with the google search URL; empty query → not ok.
- **`intent/pc.js`** (`rules`/`pc` tests): `play daft punk` → `op:'play_music'`; `play` / `play music` still → `play_pause`; `stop music` / `stop the music` → `op:'stop_music'`; bare `stop` → no pc match (stays a voice sleep word). `search for cats` → browser unchanged.
- **`router.js`**: `play_music`/`play_pause`/`stop_music` dispatch to the injected music capability.
- **`run_conversation`** (rewrite `test_main.py` cases): dispatches exactly one command then returns; silence → returns, nothing handled; `""` → returns, **nothing spoken** (no retry); `STOP` → returns, nothing handled; success path speaks the reply.
- **`WhisperSTT.listen`**: `on_transcribing` fires once after capture for a command; does **not** fire when the recorder returns `None`.

## Verification (on the box)
1. "hey jarvis, play \<song\>" → audio actually plays (mpv). "pause"/"play" toggles it; "stop music" stops it.
2. "hey jarvis, search for \<topic\>" → a Chrome window opens on the search.
3. After wake, give one command → it acts and goes quiet. Give none / mumble → it goes quiet (no "didn't catch that", no re-listen).
4. HUD shows `recording` while speaking, flips to `thinking` the moment you stop, then `idle`.
