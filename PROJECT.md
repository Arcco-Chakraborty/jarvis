# JARVIS — Home Voice Orchestrator

System spec and build guide. This document is the source of truth — read it
fully before writing code, and keep its principles intact.

---

## 1. Vision

A self-hosted voice assistant for the home. The user speaks a wake word
("jarvis") followed by a command; the system understands it and acts.

Two capability **domains**, one mechanism:

- **`switch`** — control an 8-channel ESP32 relay board (lights, fans, socket).
- **`pc`** — run an action on a named computer. **Music playback is the first
  PC action; the PC-control surface is deliberately built to grow far beyond
  it** (system control, launching apps, running scripts, etc.).

Example commands:

- "jarvis, turn off the tubelight"
- "jarvis, all lights off"
- "jarvis, turn on the fan"
- "jarvis, play the f1 theme song on the laptop"
- "jarvis, pause the music"

---

## 2. Design principles

These are load-bearing. Do not violate them without a stated reason.

1. **The orchestrator is the hub.** Everything fans out from one process. It
   owns intent, the device registry, routing, and logging.
2. **HTTP everywhere — no message broker.** Devices already expose HTTP; the
   orchestrator is just another client on the LAN. Do **not** introduce MQTT,
   WebSockets-as-a-bus, or any broker. This is intentional, not an oversight.
3. **Devices are dumb; the orchestrator owns all naming.** The ESP32 only
   knows relay indices `0–7`. The mapping from "tubelight" to index `2` lives
   in the orchestrator's registry, never on the device.
4. **Never modify the ESP32 firmware.** Its HTTP API is fixed (see §4). Its
   standalone "independent mode" — direct control from any browser/phone on
   the LAN — must keep working untouched.
5. **Commands are idempotent.** Always use the ESP32's `/set` endpoint, never
   `/toggle`. A retried command must not flip state back.
6. **Local-first.** Wake word, speech-to-text, and text-to-speech all run
   locally. Only the optional Gemini intent fallback needs internet.
7. **Separate processes, HTTP between them.** Orchestrator, voice service, and
   PC agents are independent programs. Each must be testable in isolation.
8. **Phased and testable.** Each build phase (see §8) ships something the user
   can actually run and verify.

---

## 3. Architecture

```
   [ Microphone ]
        |
        v
  [ Voice service ]  (Python — wake word, STT, TTS)
        |  POST /command {text}   <-->   {speak}
        v
  [ Orchestrator ]   (Node — the hub; intent, registry, routing)
        |                         \
        |  HTTP                     \  HTTP (intent fallback)
        v                            v
  [ ESP32 switch ]              [ Gemini 2.5 Flash ]
   8-channel relay board
        ^
        |  HTTP
  [ PC agents ]   (Node — one per controllable computer; capability modules)
```

Components:

| Component      | Runtime | Host                  | Role |
|----------------|---------|-----------------------|------|
| Orchestrator   | Node    | Spare laptop (Ubuntu) | Brain: intent, registry, routing, logging |
| Voice service  | Python  | Spare laptop (Ubuntu) | Wake word → STT → command → TTS |
| ESP32 switch   | C++     | The relay board       | 8-channel relay control (firmware fixed) |
| PC agent       | Node    | Each controllable PC  | Runs capability actions (music, …) |
| Gemini 2.5 Flash | API   | Cloud                 | Intent fallback for commands the rules miss |

The orchestrator and voice service run on the same Ubuntu spare laptop and
talk over `localhost`. PC agents run on the other machines and are reached
over the LAN.

---

## 4. Hardware — ESP32 smart switch

A single ESP32 board driving **8 relays**. Hostname `smartswitch`, plain
**HTTP on port 80** (not HTTPS — no TLS, no cert handling needed).

**Give the board a static DHCP lease** (reserve its MAC in the router) so its
IP never changes. The firmware sets a DHCP hostname but does not run mDNS, so
`smartswitch.local` will not resolve on its own.

### Channel map

The orchestrator's registry must encode this exactly:

| Index | Device      | Group |
|-------|-------------|-------|
| 0     | Fan 1       | fans  |
| 1     | Fan 2       | fans  |
| 2     | Tubelight   | lights |
| 3     | Spotlight   | lights |
| 4     | RGB Light   | lights |
| 5     | Night Light | lights |
| 6     | Socket      | other |
| 7     | Spare       | other |

### HTTP API

| Method/Path            | Effect | Returns |
|------------------------|--------|---------|
| `GET /state`           | Read all relay states | `{"states":[bool x8],"ip":"..."}` |
| `GET /set?r=<i>&s=<0\|1>` | Set relay `i` to state `s` (idempotent) | same as `/state` |
| `GET /alloff`          | Turn all relays off | same as `/state` |
| `GET /toggle?r=<i>`    | Toggle relay `i` (**do not use** — not idempotent) | same as `/state` |
| `GET /`                | The standalone web UI | HTML |

Notes:

- **State is pull-based.** There is no push/webhook. The orchestrator polls
  `/state` (~every 4 s). The adapter caches the result so state lookups are
  instant.
- Every command endpoint conveniently returns the full fresh state array, so
  a `/set` gives authoritative state with no extra request.
- Endpoints are **unauthenticated** — anything on the LAN can call them. This
  is acceptable for a home network and is a property of keeping independent
  mode. Do not add auth to the firmware.

---

## 5. Components

### 5.1 Orchestrator

Node + Express, running on the Ubuntu spare laptop. The brain.

**Responsibilities:** expose the command API, parse intent, resolve names via
the registry, route to the right device, log every command, and poll switch
state in the background.

**HTTP API:**

```
POST /command
  req:  { "text": "turn off the tubelight" }
  res:  { "ok": true,
          "speak": "Tubelight is off.",
          "intent": { "domain":"switch","action":"off","target":"tubelight" } }

GET /health   -> { "ok": true }
GET /state    -> debug: current cached state of all known devices
```

`/command` is synchronous: it performs the action and returns the sentence
the voice service should speak. On failure, `ok` is `false` and `speak`
explains it ("I couldn't reach the smart switch.").

**On boot:** load the registry from SQLite, instantiate one `Esp32Switch` per
board, call `startPolling()`, start the HTTP server.

### 5.2 ESP32 adapter — already built

`esp32-switch.js` already exists and wraps the firmware API exactly. **Do not
rewrite it.** Place it at `orchestrator/devices/esp32-switch.js` and build
around it. Its interface:

```js
const board = new Esp32Switch({ baseUrl: 'http://192.168.x.x' });
board.startPolling();
board.on('change',  e => {});   // external relay change detected by polling
board.on('offline', () => {});  // device unreachable
await board.set('tubelight', false);   // idempotent command, throws if unreachable
board.isOn('tubelight');               // instant cached lookup: true|false|undefined
board.snapshot();                      // { 'tubelight': true, ... } or null
await board.allOff();
```

### 5.3 Intent layer

**Hybrid, in this order:**

1. **Rule matcher** — fast, deterministic, offline. Handles the common cases.
2. **Gemini fallback** — only for input the rule matcher cannot classify.

**Intent object** (the contract between parsing and routing):

```json
{
  "domain": "switch | pc",
  "action": "on | off | toggle | all_off | play | pause | resume | stop | next",
  "target": "tubelight | lights | fans | laptop | htpc | ...",
  "params": { "query": "f1 theme song" }
}
```

**Rule matcher** must cover:

- Switch: on/off/toggle a named device; `all_off`; group commands
  ("lights off", "fans off") — the orchestrator expands a group to its member
  channels using the registry (the firmware has no group concept).
- PC: `play <query> on <target>`, `pause`/`resume`/`stop`/`next` the music.

**Gemini fallback:** Gemini 2.5 Flash, temperature 0.1, strict JSON-only
output, with the current device/group/target registry injected into the
prompt so it can only emit valid targets. (Same structured-output pattern
used elsewhere in the stack.) If Gemini is unreachable, return a graceful
"I didn't catch that" rather than crashing.

### 5.4 Voice service

Python, on the Ubuntu spare laptop. A loop:

1. **Wake word** — listen for "jarvis" (openWakeWord, or Porcupine).
2. **Record** — capture the command audio after the wake word.
3. **STT** — transcribe locally (`faster-whisper`, `base` or `small` model).
4. **Dispatch** — `POST /command { text }` to the orchestrator on localhost.
5. **Speak** — run the response's `speak` text through TTS (Piper) to the
   speaker.

Knows nothing about lights or computers — it only moves audio and text. Target
the full mic→action loop under ~2 s for local-path commands.

Mic coverage is one room per microphone. Start with a single mic on the spare
laptop; satellite mic nodes (ESP32-S3, or repurposed phones) are a later
expansion, not part of the initial build.

### 5.5 PC agent — extensible capability system

Node + Express, a small server running on **each** controllable computer.
This is where "do way more than music" lives, so the abstraction matters.

**A capability is a pluggable module.** The agent loads every capability in
`capabilities/` at startup and exposes their actions. Adding a new capability
must require zero changes to the agent core.

**Capability module interface:**

```js
export default {
  name: 'music',
  actions: {
    play:   async ({ query }) => { /* ... */ return 'Playing ...'; },
    pause:  async () => { /* ... */ },
    resume: async () => { /* ... */ },
    stop:   async () => { /* ... */ },
    next:   async () => { /* ... */ },
    status: async () => { /* ... */ },
  },
};
```

**HTTP API:**

```
POST /run
  headers: Authorization: Bearer <PC_AGENT_TOKEN>
  req:  { "capability": "music", "action": "play", "params": { "query": "f1 theme" } }
  res:  { "ok": true, "detail": "Playing F1 theme." }

GET /health -> { "ok": true, "capabilities": ["music"] }
```

**Auth:** orchestrator and agents share a secret token (`PC_AGENT_TOKEN`),
sent as a bearer header. The agent rejects unauthenticated calls. This matters
because capabilities will eventually run shell-level actions.

**First capability — `music`:**

- Actions: `play(query)`, `pause`, `resume`, `stop`, `next`, `previous`,
  `volume(level)`, `status`.
- Linux reference implementation: start playback by spawning `mpv --no-video`
  with a yt-dlp search URL (`ytdl://ytsearch1:<query>`); control playback via
  mpv's IPC socket or `playerctl`. Spotify Web API is a valid alternative if
  the user has Premium. The handler is OS-aware — implement per platform.
- The agent tracks the current player so transport actions target it.

**Capability roadmap** (build the abstraction now so these slot in later —
do NOT implement them in the initial build):

- `system` — volume, mute, lock, sleep, screenshot.
- `apps` — launch, focus, or close an application.
- `media` — transport control for whatever player is already running.
- `shell` — run a whitelisted, named script.
- `notify` — show a desktop notification.
- `files` — open a file or folder.

---

## 6. Data model

SQLite via `better-sqlite3`, owned by the orchestrator. Minimal starting
schema — expect it to grow:

```sql
-- Physical devices the orchestrator can reach.
CREATE TABLE devices (
  id        INTEGER PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,      -- e.g. 'smartswitch'
  type      TEXT NOT NULL,             -- 'esp32_switch' | 'pc_agent'
  base_url  TEXT NOT NULL              -- e.g. 'http://192.168.1.42'
);

-- Named switches mapped to a board + relay index.
CREATE TABLE switches (
  name       TEXT PRIMARY KEY,         -- 'tubelight'
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  channel    INTEGER NOT NULL,         -- 0..7
  group_name TEXT                      -- 'lights' | 'fans' | 'other'
);

-- Spoken aliases -> canonical switch/target name.
CREATE TABLE aliases (
  alias      TEXT PRIMARY KEY,         -- 'tube light', 'the tube'
  canonical  TEXT NOT NULL
);

-- Audit log of every command.
CREATE TABLE command_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  intent     TEXT,                     -- JSON
  ok         INTEGER,
  detail     TEXT
);
```

Seed `devices` with the `smartswitch` board and `switches` with the channel
map from §4. PC targets ("laptop", "htpc") are `devices` rows of type
`pc_agent`.

---

## 7. Command flow

**"jarvis, turn off the tubelight"** — voice service detects the wake word,
records and transcribes the rest, POSTs `{text:"turn off the tubelight"}` to
the orchestrator. Rule matcher produces
`{domain:"switch",action:"off",target:"tubelight"}`. Router looks up
`tubelight` → board `smartswitch`, channel `2`, calls `board.set('tubelight',
false)` → `GET /set?r=2&s=0`. Orchestrator returns `{speak:"Tubelight is
off."}`; voice service speaks it.

**"jarvis, play the f1 theme on the laptop"** — same path until intent:
`{domain:"pc",action:"play",target:"laptop",params:{query:"f1 theme"}}`.
Router finds the `laptop` PC agent's `base_url`, POSTs
`{capability:"music",action:"play",params:{query:"f1 theme"}}` with the bearer
token. The agent's `music` capability starts playback and returns a detail
string the orchestrator turns into speech.

---

## 8. Build phases

Build in order. Each phase must run and be verifiable before the next.

- **Phase 0 — Scaffold.** Repo, Node project, Express, `better-sqlite3`,
  config via `.env`, the SQLite schema, registry seeded with the ESP32 board
  and channel map. `GET /health` works.
- **Phase 1 — Switch control, typed.** Orchestrator `POST /command` with the
  rule matcher for the `switch` domain only, wired to the existing
  `esp32-switch.js` adapter with polling on.
  *Verify:* `curl -X POST .../command -d '{"text":"turn off tubelight"}'`
  flips the relay.
- **Phase 2 — Voice.** Python voice service: wake word → STT → POST `/command`
  → speak the response.
  *Verify:* "jarvis, turn off the tubelight" works by voice end to end.
- **Phase 3 — PC agent + music.** Build the PC agent with the capability
  system and the `music` capability. Add the `pc` domain to intent and
  routing.
  *Verify:* "jarvis, play \<song\> on the laptop" works.
- **Phase 4 — Gemini fallback.** Add the LLM intent fallback for commands the
  rule matcher misses, with the registry injected and strict JSON output.
- **Phase 5+ — Expand.** Further PC capabilities (§5.5 roadmap), more devices,
  multi-room voice satellites, a status dashboard.

---

## 9. Tech stack

- **Orchestrator:** Node.js (18+), Express, `better-sqlite3`. No broker, no
  ORM. `esp32-switch.js` uses only built-in `fetch` — keep dependencies lean.
- **Voice service:** Python 3.11+, `openWakeWord` (or Porcupine),
  `faster-whisper`, `piper` TTS.
- **PC agent:** Node.js (18+), Express. Music handler uses `mpv` + `yt-dlp`
  and/or `playerctl` on Linux.
- **Intent fallback:** Gemini 2.5 Flash via API, temperature 0.1, JSON output.
- **Process management:** `systemd` units for the orchestrator, voice service,
  and each PC agent.
- **Hosts:** orchestrator + voice service on the Ubuntu spare laptop; PC
  agents on each controllable machine.

---

## 10. Repo layout

```
jarvis/
  PROJECT.md
  README.md
  orchestrator/
    server.js              Express app, POST /command, /health, /state
    config.js              env + constants
    intent/
      rules.js             fast rule-based matcher
      gemini.js            LLM fallback (Phase 4)
      index.js             parse(text) -> intent
    devices/
      esp32-switch.js      EXISTS — do not rewrite
      pc-agent-client.js   talks to PC agents over HTTP
    db/
      schema.sql
      registry.js          load/seed registry, name resolution
    router.js              intent -> device action
  voice-service/
    main.py                the wake -> record -> stt -> dispatch -> tts loop
    wakeword.py
    stt.py
    tts.py
  pc-agent/
    agent.js               Express app, POST /run, capability loader
    capabilities/
      music.js             first capability
  deploy/
    *.service              systemd units
```

---

## 11. Non-goals (for now)

- No message broker (MQTT etc.) — see principle 2.
- No changes to the ESP32 firmware — see principle 4.
- No cloud hosting — JARVIS runs on the home LAN; it controls local devices.
- No multi-room mic coverage in the initial build — single mic first.
- No web dashboard until Phase 5.
- No accounts, no multi-user — single household.

---

## 12. Current status

- `esp32-switch.js` — **done.** The ESP32 adapter is written and matches the
  firmware API. Drop it into `orchestrator/devices/`.
- Everything else — to be built, starting at Phase 0.
