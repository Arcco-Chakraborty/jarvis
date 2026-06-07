# JARVIS — Fresh Session Start

**Written:** 2026-06-04 · **For:** the next agent picking this up after a context clear.

**Read these first, in order:** `PROJECT.md` (the spec — wins on any conflict) → `CHECKPOINT.md` (full running state/history) → this file (what's hot right now). Don't duplicate those here; this is just the launch pad.

---

## Where things stand (one breath)

Self-hosted home voice assistant: **Node orchestrator** (`orchestrator/`) + **Python voice service** (`voice-service/`) + **ESP32 relay** + a **dependency-free Node agent** (`pc-agent/`) that runs on a remote **Windows desktop**. Whisper large-v3 STT on the GTX 1650 SUPER, openWakeWord `hey_jarvis`, Piper `en_GB-alan-medium` (British male) TTS, Gemini 2.5 Flash fallback with key rotation.

**Just shipped — Multi-PC Phase 2 (merged to `main`, pushed, 293 tests green):** the Windows agent gained **`media`** (Windows media/volume keys via PowerShell `keybd_event`) and **`shell`** (PowerShell, confirm-gated). "on the \<pc\>" now targets media + shell, not just open_app. See the top TL;DR bullet in `CHECKPOINT.md` for the full wiring.

## Verified live this session (2026-06-04)

- Desktop agent at **`http://192.168.0.117:7000`** is **running** — `/health` → `{"ok":true,"capabilities":["apps","media","shell"]}`.
- Bearer auth confirmed: wrong token → `401`, real token → `200` + graceful dispatch.
- **Fixed an `.env` bug:** `PC_AGENTS` and `GEMINI_API_KEY` were glued on one line (no newline), so the agent base_url parsed as `...7000GEMINI_API_KEY=...`. Now split correctly. (`.env` is gitignored — never commit it.)
- NOT yet exercised live by voice: an actual "pause on the desktop" / "volume up on the desktop" / "run notepad on the desktop → confirm" through the full mic→orchestrator→agent path. **That's the obvious first thing to try.**

## Run it

```bash
./run-jarvis.sh          # starts orchestrator + voice with a health gate (NOT run-full.sh alone)
```
Then speak: "hey jarvis" → "pause on the desktop" / "volume up on the desktop" / "run notepad on the desktop" then "confirm".

Quick orchestrator-only sanity (no voice): `cd orchestrator && npm test` (expect 293 pass).

Agent reachability check from the host:
```bash
curl -s http://192.168.0.117:7000/health
```

## Likely next work (not started)

- **Live e2e of Phase 2 by voice** — confirm the remote media keys + confirm-gated shell actually fire on the desktop end-to-end.
- **Multi-PC Phase 3** — more agent capabilities (a `system`/power capability, capability-driven vocab from `/health`), and/or a 2nd agent (laptop). Each phase = its own spec → plan → subagent-driven build.
- Minor known gap: remote `stop_music` refusal path isn't directly unit-tested (covered by the same `play_music` code path). Cosmetic.

## Hard constraints (do not violate)

- **Never** rewrite `orchestrator/devices/esp32-switch.js` or the ESP32 firmware. Always `/set`, never `/toggle`.
- **No message broker, ever. HTTP only.** Local-first intent matching (rules before Gemini).
- **Shell commands NEVER run without a fresh spoken "confirm"** — local OR remote. This invariant is load-bearing; don't weaken the `makePipeline` gate in `orchestrator/server.js`.
- `.env` is gitignored and **must never be committed**.
- Use the superpowers workflow for new features: brainstorming (design + approval) → writing-plans → subagent-driven-development (TDD, two-stage review per task).

## The Windows box

The agent code lives in this same repo under `pc-agent/` and is pulled onto the Windows PC. To update it there: pull, then restart `node pc-agent/index.js` (it needs `PC_AGENT_TOKEN` set in the Windows env to match the orchestrator's). `/health` should list apps, media, shell.
