# JARVIS — Build Checkpoint / Handoff

**Last updated:** 2026-05-31
**Audience:** any AI agent (or human) picking up this project mid-stream.
**Source of truth:** `PROJECT.md`. This file tracks *state*; PROJECT.md defines *the spec*.
If the two ever conflict, **PROJECT.md wins** — then fix this file.

---

## TL;DR — where things stand

- **Voice quality batch — DONE (2026-05-31).** (1) **Wake threshold** default `0.5 → 0.35` (easier to trigger; env-tunable). (2) **Music plays the real song in a window:** `pc/music.js` rewritten — `play <q>` resolves the top result with `yt-dlp --get-id ytsearch1:<q>` and opens its **`youtube.com/watch?v=…` in Chrome** (falls back to a YouTube search page if unresolved); the old headless mpv path is gone. **pause/stop now go through `playerctl`** (MPRIS — controls the Chrome/YouTube tab *and* Spotify); the server detects `playerctl` at boot (`which`) and degrades gracefully if absent (**`sudo apt install -y playerctl`** to enable transport). (3) **Music phrasings stay local:** "put on X" / "play me X" / "i want to hear X" → `play_music` (no Gemini). (4) **Compound commands:** "X and then Y" runs each clause in order via a new `intent/split.js` + `parseLocal` (offline cascade) in the server pipeline — only when **every** clause parses locally and none is shell/confirm (so "all lights except tubelight **and** socket" isn't wrongly split); combined `ok`/speak. Local-first routing was already working (verified). 210 node + 42 voice tests green. Merged to `main`. **Next cycle: Wayland window control** (focus / side-by-side / window awareness — needs a GNOME D-Bus extension and/or ydotool; `wmctrl`/`xdotool` don't work on Wayland).

- **JARVIS brain — DONE (2026-05-31).** Gemini is no longer switch-only: `intent/gemini.js` now classifies the **full vocabulary** (switch + pc `open_app`/`play_music`/`play_pause`/`stop_music`/`search` + a **proposed `shell` command** + `ask`), so it actually rescues commands the local rules miss. New **`intent/knowledge.js`**: "find out about X" / "what is X" / "tell me about X" → a concise spoken answer in a **Stark-JARVIS voice** (separate warm Gemini call, `systemInstruction` persona, graceful in-character fallback). New local **`intent/ask.js`** matcher (cascade is now switch → pc → ask → confirm → gemini). **"look up / search X" = web (Chrome)** vs **"find out about X" = answer**. New **`intent/persona.js`**: offline witty control confirmations ("Tubelight powered down.", "Powering down. Good night, sir.", "Spinning it up.") applied via a router wrapper to successful control results — no API, instant. Gemini-**proposed shell commands run only after a spoken "confirm"** (existing TTL gate; raw command guarded by `typeof === 'string'`). **Window ops deliberately excluded** (broken on Wayland — separate cycle). 204 node tests green. Needs `GEMINI_API_KEY` (already in `.env`) + an `npm start` restart; live e2e pending. Merged to `main`.

- **Voice UX + media fixes — code DONE, live e2e pending (2026-05-31).** On branch `voice-ux-media-fixes` (off `main`). (1) **Music actually plays:** new `orchestrator/pc/music.js` runs an `mpv` process (`ytdl://ytsearch1:<query>`, no account) controlled over its JSON IPC socket (`/tmp/jarvis-mpv.sock`); `play <q>`→`play_music`, `pause`/`play`→`play_pause` (toggle), new `stop music`/`stop the music`/`stop playing`→`stop_music` (bare "stop" stays the voice sleep word). The old search-only `playOnSpotify`/`spotify_search` is retired. **Known limit:** mpv control reports success off a stale socket if mpv was SIGKILL'd (normal exit cleans up). `next`/`prev`/`volume` still need the absent `playerctl`/`pactl` — **out of scope**. (2) **Browser search** launches `google-chrome` directly (configurable `BROWSER_CMD`) instead of the unreliable `xdg-open`. (3) **Voice loop is one-command-per-wake, silent on miss** — `run_conversation` does a single `listen()` then sleeps (no retries/follow-up/"didn't catch that"); `WhisperSTT.listen` gained an `on_transcribing` hook that emits `transcribing` the instant VAD ends, so the dashboard flips recording→**THINKING** (it already mapped that status). `vad_silence_ms` 800→600. Dead `max_unrecognized`/`VOICE_MAX_RETRIES` removed. 180 node + 42 voice tests green. **Remaining (M8):** `sudo apt install -y mpv yt-dlp` (host action — sudo needs a password), then live e2e (play/pause/stop, Chrome search, one-shot loop, THINKING badge), then merge.
- **GPU host + open-vocab Whisper STT — DONE (2026-05-31).** Project moved to a new PC with an **NVIDIA GTX 1650 SUPER (4GB, driver 595 / CUDA 13.2)**. STT swapped from grammar-locked Vosk to **`faster-whisper` `large-v3` on CUDA (`int8`, ~3GB VRAM), open-vocabulary** — you can speak naturally and the orchestrator's existing Gemini fallback parses free-form intent. New `WhisperSTT` backend in `voice-service/stt.py` records via `webrtcvad` endpointing (pure `capture_utterance` helper) and guards Whisper hallucinations via `whisper_transcript` (no_speech_prob / avg_logprob thresholds) — returns the same `None`/`STOP`/`""`/`str` contract as Vosk, so `run_conversation` is reused unchanged. Vosk stays selectable (`VOICE_STT_BACKEND=vosk`). Verified: large-v3 loads on the GPU and correctly transcribed a Piper-synth'd "turn off the tubelight". **Open-vocab note:** Whisper spells non-dictionary device names phonetically (e.g. "tubelight"→"tubalight") — relies on the orchestrator's fuzzy match / Gemini to resolve; watch this in real use. **Wake word stayed openWakeWord `hey_jarvis`** (bundled, fully local) — a Porcupine "jarvis" attempt was reverted because it needs a Picovoice account. **New-PC gotchas (in `requirements.txt`/`run-full.sh`):** `setuptools<81` pinned (webrtcvad imports `pkg_resources`, dropped in setuptools 81); `run-full.sh` globs `.venv/lib/python*/site-packages/nvidia/*/lib` onto `LD_LIBRARY_PATH` (the CUDA-12 runtime wheels are namespace packages, so the lib path can't be found by import). The `.venv` is **uv-managed** (no pip; use `uv pip install --python .venv/bin/python ...`). Config defaults: `VOICE_STT_BACKEND=whisper`, `WHISPER_MODEL=large-v3`, `WHISPER_DEVICE=cuda`. Remaining: in-room spoken end-to-end pass (mic → relay). On branch `gpu-whisper-stt`.
- **Phase 0 (Scaffold) — DONE.** ESM Node project, seeded SQLite registry, ESP32 adapter wired with polling, `GET /health` + `GET /state` live. `npm test` green.
- **Phase 1 (Switch control) — DONE.** `POST /command {text}` parses → routes → flips the real relay → returns `{ok, speak, intent}`. 35 tests green.
- **Web dashboard (Phase 5, pulled forward) — DONE.** `GET /` serves a static control panel; buttons hit `POST /switch`, free text hits `/command`; live state via `/state` polling. 38 tests green.
- **Robust parsing + Gemini fallback — DONE.** Fuzzy device matching for small typos/STT slips; Gemini 2.5 Flash classifies whatever the offline rules miss; graceful "didn't catch that" on failure. 58 tests green.
- **Switch intent update — DONE.** `keep X on rest off`, `X on rest off`, and `keep only <group> on and everything else off` now parse as `keep_only` and route through explicit idempotent `/set` calls. `npm test` green at 64 tests.
- **Phase 2 Voice — STARTED.** Python voice stack exists under `voice-service/`: manual text input, `/command` dispatch, console/Piper TTS, faster-whisper STT, openWakeWord `hey_jarvis`, installer, and full launcher. Safe one-shot smoke works; full listener can run with `voice-service/run-full.sh`. Stack installed (uv py3.12 venv at repo `.venv/`, whisper `base` pre-warmed, Piper voice in `voice-service/models/`).
- **Voice observability — DONE.** Voice service emits best-effort events (incl. live wake-score ~3×/sec) to `POST /voice/event`; orchestrator buffers them (`GET /voice`) + recent commands (`GET /log`, with matched `via` rules/gemini). Dashboard shows a Voice panel (state badge, wake-score bar vs threshold, live transcript), an activity feed, and orch/board/voice health dots. Use the wake-score bar to debug whether "hey jarvis" registers.
- **STT → Vosk (grammar-constrained) — DONE.** Replaced free-form Whisper (which hallucinated on short/accented commands, e.g. "They're not the Indian") with **Vosk** constrained to a grammar of valid commands built from `GET /vocab`; "fan one"→"fan 1" normalization; default `VOICE_STT_BACKEND=vosk` (model `vosk-model-small-en-us-0.15` in `voice-service/models/`; whisper still available). Far more reliable for the fixed command set. 77 orchestrator + 12 voice tests green.
- **Conversational voice loop — DONE.** Streaming Vosk endpointing (records exactly while you speak, stops on silence — no fixed window) + continued conversation (wake once, keep issuing commands until ~5s silence re-arms the wake word; `VOICE_FOLLOWUP_SECONDS`=5, `VOICE_MAX_UTTERANCE_SECONDS`=12). Grammar widened (`switch`/`turn the` phrasings). Pure `run_conversation` turn-taker. 15 voice tests green.
- **Voice reliability — DONE.** Spoken aliases so Vosk can decode non-lexicon names (tubelight→"tube light", rgb→"r g b light"); confidence gating (`VOICE_MIN_CONFIDENCE`=0.6) so ambient noise / irrelevant speech in the recording + follow-up windows is ignored (utterance below threshold → "didn't catch that"). 19 voice tests green.
- **Voice relevance + retry + new intents — DONE.** (1) STT `listen()` now distinguishes silence (`None` → re-arm wake word) from heard-but-not-understood (`""` → say "didn't catch that" and retry), bounded by `VOICE_MAX_RETRIES`=3 so noise can't loop; stray fillers like "the" are rejected (`looks_like_command` requires a standalone on/off). (2) New `all_off_except` intent: "turn off all lights except tubelight" turns off the rest of the group (or everything, unscoped) and leaves the named device untouched; "keep only X on" → `keep_only`. Both match offline so voice never waits on Gemini (kills the lingering "THINKING"). Grammar widened to 170 phrases (except + keep-only). Wake prompt copy changed to "jarvis". 85 orch + 24 voice tests green.
- **Phase 3.5 — PC Controls v2 — DONE.** Auto-discovered app catalog from `.desktop` files in /usr/share/applications, ~/.local/share/applications, snap, and flatpak dirs (no more hardcoded allowlist.json). Non-gating `pc/apps-aliases.json` for spoken shortcuts (chrome → google chrome, etc.). PATH fallback for single-token unknown names. New `pc/browser.js` (Google search via xdg-open), `media.playOnSpotify` (spotify:search URI), `window.splitWith` (focus/launch + Super+Left/Right with injected listWindows + sleep). Intent matchers: `play <q>` (with carve-out so "play music"/"play" keep play_pause semantics), `search [about|for] <q>`, `split A with B`. New `POST /system/rescan` hot-reloads the catalog without restarting (mutable catalogRef shared by reference with `makeOpenApp`'s closure). 172 backend tests, 30 voice tests, all green. Exhaustive grammar probe still passes — no Gemini fallthrough for any voice command.
- **Phase 3 full: media + window + shell (confirmation flow) — DONE.** Capabilities under `orchestrator/pc/`: `media.js` (playerctl + pactl), `window.js` (wmctrl + xdotool), `shell.js` (`sh -c` against a recipe lookup). Recipes in `pc/shell-recipes.json` (free space, update system, check memory, git status, screenshot, lock screen, ...). `intent/pc.js` extended with media/window/shell matchers; `intent/confirm.js` for "confirm" / "go ahead" / "do it". New cascade: switch → pc → confirm → gemini. `router.js` dispatches media/window via injected capabilities. **Shell + confirmation lives in `makePipeline`** in `server.js`: a shell intent stashes pending {command, expiresAt(now+60s)} and replies "Should I run <command>? Say confirm to run.". A confirm.yes within TTL executes it; any other intent abandons pending. Pipeline tested for happy path, no-pending confirm, expiry, abandon-on-other-intent, and unknown recipe. Voice grammar covers all phrases (media + set-volume × 11 number words + window + recipes + confirm); STT has a `STANDALONE` set so verb-only commands ("play", "mute", "snap left") bypass the target check; `shellRecipes` get added to `_targets` so "run free space" passes. 141 orch + 30 voice tests green; exhaustive probe — all 258 grammar phrases match a local rule (no Gemini fallthrough for any voice command).
- **Phase 3 vertical slice: PC open_app — DONE.** New `pc` intent domain. `intent/pc.js` matches "open|launch|start <app>" (with "the" stripped, wake prefix tolerated); cascade is `switch → pc → gemini`. `pc/apps.js` exposes `makeOpenApp({allowlist, spawn})` returning a function that looks the name up in `pc/allowlist.json` (seeded with chrome/firefox/code/terminal/files/settings/spotify/vlc/calculator) and spawns the binary detached + unref'd. Router handles `domain:'pc'`; `route()` accepts an injected `openApp`. Server wires `loadAllowlistSync()` at boot, exposes app names via `/vocab.appNames`. Voice grammar adds `"open|launch|start <app>"` phrases per appName; `looks_like_command` now accepts the PC verbs; `stt._targets` includes app names. 112 orch + 27 voice tests green. Next slices: media, window, shell (allow-listed, voice-disabled).
- **all_on + confidence retune + STT diagnostic — DONE.** Added `all_on` ("turn everything on" / "all on" — mirror of all_off, iterates set(name,true)); these returned null before. Lowered default `VOICE_MIN_CONFIDENCE` 0.6→0.4: Vosk word-confidences run lower in grammar-constrained mode, so 0.6 was rejecting valid lgraph commands (the grammar + `looks_like_command` on/off filter already guard against noise). Added `voice-service/diagnose.py` (records an utterance and prints mic level + free vs grammar transcript + confidence + accept/reject reason) and a `VOICE_DEBUG=1` accept/reject trace in `listen()`. Confirmed the ESP32 at 192.168.0.202 is reachable (GET /state OK) — the control path (parse→route→relay) is sound; remaining voice misses are recognition/confidence, not hardware. 89 orch + 24 voice tests green.
- **STT model upgrade → lgraph — DONE.** Swapped the small model for **`vosk-model-en-us-0.22-lgraph`** (~128MB, in `voice-service/models/`) for better acoustic accuracy. Critical: only **small** and **lgraph** Vosk models support the dynamic grammar constraint we depend on — the full 1.8GB `vosk-model-en-us-0.22` is a static graph that ignores grammar (would reintroduce hallucinations), so it is deliberately NOT used. Default `VOSK_MODEL_PATH` updated in `config.py` + `run-full.sh` + `.env.example`.
- **Toolchain installed** (verified 2026-05-28): node v22, npm, git, gh, python 3.14. The old blocker is cleared.
- **GitHub:** private repo `jarvis` exists at `origin`; local `main` may be ahead until the current worker pushes.
- Repo holds the orchestrator under `orchestrator/` (config, registry, intent, router, server + tests), specs/plans under `docs/superpowers/`, plus `PROJECT.md` and this file.

## Host / environment

**This machine IS the production host** from PROJECT.md — the "Ubuntu spare laptop" that runs the orchestrator + voice service. So local dev == the deploy box.

- **OS:** Ubuntu 26.04 LTS  •  **Host:** `arcco-chakraborty-Latitude-5490` (Dell Latitude 5490)
- **LAN:** this host is `192.168.1.167` (`192.168.1.x`). The ESP32 `smartswitch` is at **`192.168.0.202`** — a *different* /24 (`192.168.0.x`), yet reachable from the host (cross-subnet routing works). Its base URL is in `.env`. (`smartswitch.local` won't resolve — no mDNS.)
- **Toolchain:** installed. Node v22+ is known-good for the orchestrator.
- PC agents (Phase 3) run on *other* machines on this same LAN.

## What's in the repo right now

| Path | Status | Notes |
|------|--------|-------|
| `PROJECT.md` | spec, stable | Full system design. **Read it fully before writing code.** |
| `orchestrator/devices/esp32-switch.js` | **done — do not rewrite** | Adapter matches the fixed firmware API. |
| `CHECKPOINT.md` | this file | Handoff/state. Keep it current. |

The repo is initialized with `package.json`, lockfile, SQLite schema/seed logic, `.env.example`,
and gitignored local `.env` / `orchestrator/db/jarvis.db`.

## Immediate next actions

1. Test/tune Phase 2 by speaking "hey jarvis", then a short command during the recording window.
2. Tune `VOICE_WAKE_THRESHOLD` and `VOICE_RECORD_SECONDS` if wake detection or clipping needs adjustment.
3. Build Phase 3 PC agent + music capability after voice basics work.

## Non-negotiable constraints — read before writing code

These are PROJECT.md §2 design principles, condensed to the ones that are easiest to break:

- **Never rewrite `esp32-switch.js`.** It already matches the firmware exactly. Build *around* it.
- **Never modify the ESP32 firmware.** Its standalone web UI (any browser/phone on the LAN) must keep working untouched.
- **Always `/set`, never `/toggle`.** Commands must be idempotent. The adapter already enforces this — do not add any toggle code path.
- **No message broker. Ever.** No MQTT, no WebSocket-as-bus. HTTP only, orchestrator is just another LAN client. This is deliberate (§2.2), not an oversight.
- **Devices are dumb; the orchestrator owns all naming.** "tubelight" → channel `2` lives in the registry, never on the device.
- **Separate processes, HTTP between them.** Orchestrator / voice service / PC agents are independent programs, each testable in isolation.
- **Local-first.** Wake word, STT, and TTS all run locally. Only the Gemini intent fallback touches the internet.
- **Build in phase order.** Each phase must run and be verifiable before the next begins.

## The ESP32 adapter — how to use it (don't reinvent)

`Esp32Switch` is an `EventEmitter`. Construct one per board, then start polling.

```js
import { Esp32Switch } from './devices/esp32-switch.js';

const board = new Esp32Switch({
  baseUrl: 'http://192.168.x.x',   // the board's static IP — see "Needs the user"
  names: [/* 8 names, channel 0..7 */], // pass names from the registry (see gotcha)
});
board.startPolling();                 // refreshes every ~4s, caches state

await board.set('tubelight', false);  // idempotent; returns the new bool; THROWS if unreachable
board.isOn('tubelight');              // cached: true | false | undefined (undefined = never reached yet)
board.snapshot();                     // { 'tubelight': true, ... } | null
await board.allOff();

board.on('change',  e => {});  // { index, name, on } — fires ONLY for externally-flipped relays
board.on('offline', err => {});
board.on('online',  () => {});
```

Behaviors baked into the adapter (rely on these, don't duplicate them):

- `set()` / `allOff()` update the cache **silently** — so a `'change'` event always means "something *outside* JARVIS flipped a relay" (detected by polling).
- `set()` **throws** when the board is unreachable → the orchestrator should catch it and speak *"I couldn't reach the smart switch."*
- `isOn()` returns `undefined` until the first successful poll completes.

**Canonical channel map** (must exactly match the seeded `switches` table — PROJECT.md §4):

| Idx | Device      | Group  |
|-----|-------------|--------|
| 0   | Fan 1       | fans   |
| 1   | Fan 2       | fans   |
| 2   | Tubelight   | lights |
| 3   | Spotlight   | lights |
| 4   | RGB Light   | lights |
| 5   | Night Light | lights |
| 6   | Socket      | other  |
| 7   | Spare       | other  |

**Naming gotcha:** the adapter's `DEFAULT_NAMES` are lowercased with spaces — `'fan 1'`, `'fan 2'`,
`'rgb light'`, `'night light'`, etc. `resolve()` lowercases + trims its input. To avoid two
sources of truth, make the registry's switch names match these and **pass them into the
constructor via `names` (ordered by channel 0–7)** rather than relying on the defaults.

**Groups:** the adapter has no group concept. "all lights off" / "fans off" must be expanded by
the orchestrator — look up every `switches` row whose `group_name` matches and call `board.set()`
per channel. `allOff()` covers the entire board in one call.

## Needs the user (config + actions nobody can guess)

- **ESP32 static IP** — reserve the board's MAC in the router (DHCP lease) and record the IP (on `192.168.1.x`). No mDNS, so `smartswitch.local` will not resolve.
- **`PC_AGENT_TOKEN`** — shared bearer secret between orchestrator and PC agents (Phase 3).
- **`GEMINI_API_KEY`** — for the Phase 4 intent fallback (Gemini 2.5 Flash).
- **PC targets** — hostname/IP + friendly name ("laptop", "htpc") for each controllable machine (Phase 3), seeded as `pc_agent` rows in `devices`.
- **GitHub** — repo decided: **private**, named `jarvis`. Create via `gh auth login` (interactive) then `gh repo create`. **Never commit `.env`.**

## Phase roadmap (status)

- [x] **Phase 0 — Scaffold** — Express + SQLite + seeded registry + `GET /health` (+ `/state`). Done 2026-05-28.
- [x] **Phase 1 — Switch control.** `POST /command` + rule matcher (on/off, all_off, groups, status) + command logging. Done 2026-05-28. Note: `all_off`/"everything off" power-cycles the board (the socket relay feeds it/its uplink) — brief unreachability then a reboot to defaults `[T,T,T,F,F,F,T,F]`. Left as-is by choice.
- [ ] **Phase 2 — Voice.** Started 2026-05-28. Python service handles manual transcript -> `POST /command` -> console/Piper TTS and has installed local wake/STT/TTS backends (`openwakeword`, `faster-whisper`, `piper-tts`). Remaining: user-in-room tuning and end-to-end spoken verification. *Verify:* "jarvis, turn off the tubelight" works by voice, end to end.
- [ ] **Phase 3 — PC agent + music.** Capability loader + `music` capability; add the `pc` domain to intent + routing. *Verify:* "jarvis, play \<song\> on the laptop" works.
- [x] **Phase 4 — Gemini fallback.** Done 2026-05-28. Intent cascade: exact/fuzzy rules (Levenshtein for device names) -> Gemini 2.5 Flash (registry-injected prompt, JSON mode, validated, graceful null). Single key via `GEMINI_API_KEY`; rotation deferred.
- [ ] **Phase 5+ — Expand.** More PC capabilities (§5.5 roadmap), more devices, multi-room voice satellites, status dashboard.

---

*Keep this file current: when you finish a phase, tick its box, update the TL;DR, and note anything the next agent would trip over.*
