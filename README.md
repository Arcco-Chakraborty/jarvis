# J.A.R.V.I.S — Self-Hosted Home Voice Assistant

A local-first voice assistant for the home. Say the wake word, give a command, and
JARVIS acts — flipping relays on a smart switch, controlling apps and media on your
PCs, answering questions, and even *looking* at things through a phone camera and
describing them. Speech recognition, wake-word detection, and text-to-speech all run
**on your own machine**; only an optional cloud fallback for hard-to-parse commands
ever leaves the LAN.

> *"jarvis, turn off the tubelight"* · *"play the F1 theme on the laptop"* ·
> *"split chrome with code"* · *"look at this, what am I holding?"* ·
> *"find out about the Chandrayaan mission"*

A standalone preview of the holographic dashboard UI lives in **[`demo.html`](demo.html)** —
open it in any browser (no backend needed) to see the interface.

---

## Highlights

- **Local-first voice loop** — openWakeWord (`hey jarvis`) → `faster-whisper` STT →
  Piper TTS, all on-device. Open-vocabulary: speak naturally.
- **Two control domains, one brain** — an **ESP32 8-relay switch** (lights, fans,
  socket) and **PC actions** (launch apps, media transport, window tiling, web
  search, shell recipes) across one or more computers on the LAN.
- **Vision** — "look at this / look at my screen" captures an image (phone IP-webcam
  or screenshot) and answers questions about it via multimodal Gemini, in character.
- **Hybrid intent** — a fast, deterministic, fully-offline rule matcher handles the
  common commands; **Gemini 2.5 Flash** is a graceful fallback (with API-key rotation)
  only for what the rules miss. No internet? Everything except the fallback still works.
- **Confirmation-gated shell** — arbitrary shell/PowerShell actions never run without a
  fresh spoken "confirm".
- **Live web dashboard** — watch wake-score, transcripts, device state, and a command
  feed in real time at `http://localhost:3000/`.
- **Lean by design** — HTTP between every component, no message broker, no ORM.

---

## Architecture

```
   [ Microphone ]
        |
        v
  [ Voice service ]  (Python — wake word, STT, TTS)
        |  POST /command {text}  <-->  {speak}
        v
  [ Orchestrator ]   (Node — the hub: intent, registry, routing, logging, dashboard)
        |              \                         \
        | HTTP          \ HTTP                    \  HTTP (intent / vision fallback)
        v                v                         v
  [ ESP32 switch ]   [ PC agents ]            [ Gemini 2.5 Flash ]
   8-channel relay    one per computer
                      (apps, media, shell, type)
```

| Component       | Runtime | Host                  | Role |
|-----------------|---------|-----------------------|------|
| Orchestrator    | Node    | Linux host (Ubuntu)   | The brain: intent, device registry, routing, logging, dashboard |
| Voice service   | Python  | Same Linux host       | Wake word → STT → command → TTS |
| ESP32 switch    | C++     | The relay board       | 8-channel relay control (firmware fixed, HTTP API) |
| PC agent        | Node    | Each controllable PC  | Runs capability actions (apps, media, shell, type) |
| Gemini 2.5 Flash| API     | Cloud (optional)      | Intent + vision fallback for what the rules can't handle |

**Design principles:** the orchestrator is the single hub; HTTP everywhere (no broker);
devices are dumb and the orchestrator owns all naming; commands are idempotent; local-first;
each process is independent and testable in isolation.

### Repo layout

```
jarvis/
  orchestrator/        Node + Express hub
    server.js            POST /command, /health, /state, dashboard, voice events
    config.js            env + constants
    intent/              rule matcher, Gemini fallback, vision, knowledge, persona
    devices/             esp32-switch.js (relay adapter), pc-agent-client.js
    pc/                  app launch, media, browser, window tiling, capture, shell
    db/                  SQLite schema + registry (name resolution)
    public/index.html    live dashboard
  voice-service/       Python wake → record → STT → dispatch → TTS loop
  pc-agent/            tiny dependency-free Node agent that runs on each controllable PC
  smart_switch/        ESP32 firmware (Arduino sketch) for the 8-relay board
  deploy/              example systemd units
  demo.html            standalone holographic UI preview (no backend)
  setup-new-pc.sh      one-command bootstrap for a fresh Ubuntu host
  run-jarvis.sh        launch orchestrator + voice loop for hands-on testing
```

---

## Requirements

- **OS:** Ubuntu (22.04+; Debian-family should work). The setup script targets Ubuntu.
- **Node.js 22 LTS** (orchestrator + PC agent).
- **Python 3.12** with [`uv`](https://docs.astral.sh/uv/) (voice service).
- **NVIDIA GPU + driver** — the default STT is `faster-whisper large-v3` on CUDA. No
  GPU? See [Running without a GPU](#running-without-a-gpu).
- **A microphone and speaker** for the voice loop.
- **Optional hardware:** an ESP32 8-relay board for switch control, a phone running an
  IP-webcam app for vision, and any number of PCs running the PC agent.
- **Optional:** a [Google Gemini API key](https://aistudio.google.com/apikey) for the
  intent/vision fallback. Everything else runs without it.

---

## Quick start

On a fresh Ubuntu machine, one command installs system packages, Node/Python deps,
downloads the voice models, and runs the test suites:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Arcco-Chakraborty/jarvis/main/setup-new-pc.sh)
```

Already cloned the repo?

```bash
cd jarvis && ./setup-new-pc.sh
```

Useful flags: `--skip-packages` (you handle apt yourself), `--skip-models` (download
voice models manually), `--skip-tests`, `--vosk` (also fetch the offline Vosk model).
Run `./setup-new-pc.sh --help` for the full list.

The script copies `.env.example` → `.env` and pauses for you to fill it in (see below).

### Launch

```bash
./run-jarvis.sh          # starts the orchestrator (background) + voice loop (foreground)
```

Then open **http://localhost:3000/**, say **"jarvis"**, and speak a command. `Ctrl-C`
stops the voice loop; the orchestrator keeps running so the dashboard stays live
(stop it with `pkill -f orchestrator/server.js`).

You can also run the orchestrator alone and type commands into the dashboard:

```bash
npm start                                   # http://localhost:3000
curl localhost:3000/health                  # -> {"ok":true}
curl -X POST localhost:3000/command \
  -H 'content-type: application/json' \
  -d '{"text":"turn off the tubelight"}'    # -> {"ok":true,"speak":"Tubelight powered down.", ...}
```

---

## Configuration

All configuration is via `.env` (copied from `.env.example`). The keys you'll most
likely touch:

| Key | What it does |
|-----|--------------|
| `ESP32_BASE_URL` | Your relay board's IP, e.g. `http://192.168.1.50`. Give the board a static DHCP lease so it never changes. |
| `GEMINI_API_KEY` / `GEMINI_API_KEYS` | Optional intent/vision fallback. `GEMINI_API_KEYS` (comma-separated) round-robins across keys; leave blank to disable. |
| `PC_AGENTS` | Comma-separated `name=baseUrl` for each PC agent, e.g. `laptop=http://192.168.1.60:7000`. Spoken as "on the `<name>`". |
| `PC_AGENT_TOKEN` | Shared bearer secret between the orchestrator and every PC agent. |
| `PHONE_CAMERA_URL` | An IP-webcam snapshot URL (e.g. `http://<phone-ip>:8080/photo.jpg`) for vision. |
| `WEATHER_LAT` / `WEATHER_LON` | Coordinates for weather answers. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | STT model + backend. Defaults: `large-v3` / `cuda` / `int8`. |
| `PIPER_VOICE` | Piper TTS voice (`.onnx`). Default: `en_GB-alan-medium` (a British male, JARVIS-style). |
| `PIPER_LENGTH_SCALE` | Speech pace; `< 1.0` is faster (`0.8` ≈ crisp). |

The orchestrator seeds a SQLite registry on first boot with the ESP32 board and its
channel map. Per-host customization lives in:

- `orchestrator/pc/apps-aliases.json` — map spoken shortcuts to installed apps
  (e.g. `chrome` → `chromium`).
- `orchestrator/pc/shell-recipes.json` — named, confirm-gated shell recipes.

### The ESP32 smart switch

A single ESP32 board driving 8 relays over plain HTTP. The orchestrator owns all naming;
the board only knows relay indices `0–7`. Default channel map (edit in the registry):

| Index | Device | Group | | Index | Device | Group |
|---|---|---|---|---|---|---|
| 0 | Fan 1 | fans | | 4 | RGB Light | lights |
| 1 | Fan 2 | fans | | 5 | Night Light | lights |
| 2 | Tubelight | lights | | 6 | Socket | other |
| 3 | Spotlight | lights | | 7 | Spare | other |

Commands always use the board's idempotent `/set` endpoint, so a retried command never
flips state back. The board's standalone web UI keeps working independently — JARVIS is
just another HTTP client on the LAN.

The Arduino firmware lives in **[`smart_switch/`](smart_switch/)** — see
[`smart_switch/README.md`](smart_switch/README.md) for the GPIO map, the HTTP API, and
flashing instructions (set your WiFi credentials, flash via the Arduino IDE, then point
`ESP32_BASE_URL` at the IP it prints on the serial monitor).

---

## PC agents (control other computers)

Each computer you want to control runs a tiny **dependency-free Node agent**. It exposes
a bearer-gated `POST /run {capability, action, params}` and a `GET /health`. Capabilities:
`apps` (launch), `media` (play/pause/next/volume via media keys), `shell` (confirm-gated),
and `type` (send keystrokes). See **[`pc-agent/README.md`](pc-agent/README.md)** for the
Windows setup.

On the orchestrator side, register agents in `.env`:

```env
PC_AGENT_TOKEN=your-shared-secret
PC_AGENTS=laptop=http://192.168.1.60:7000,desktop=http://192.168.1.61:7000
```

Then: *"jarvis, open notepad on the desktop"*, *"pause on the laptop"*,
*"run free space on the desktop"* → "confirm".

---

## Example commands

```
turn off the tubelight                  all lights off            turn on the fan
keep only the lights on                 turn everything off
play discover weekly on the laptop      pause the music           next track
open chrome                             search for machine learning
split chrome with code                  what's open
look at this, what am I holding?        look at my screen, what's this error?
find out about the James Webb telescope what's the weather
run free space                          (recipe — asks "confirm?" before executing)
open chrome and then play lofi          (compound commands run in order)
```

---

## Running without a GPU

The default STT (`large-v3` on CUDA) needs an NVIDIA GPU. To run CPU-only, edit `.env`:

```env
WHISPER_DEVICE=cpu
WHISPER_MODEL=base          # or small — large-v3 is too slow on CPU
WHISPER_COMPUTE_TYPE=int8
```

`faster-whisper` downloads the chosen model automatically on first run. (A fully-offline
`vosk` backend is also available — `VOICE_STT_BACKEND=vosk` with `--vosk` at setup — but
it is grammar-constrained and less flexible than Whisper.)

---

## Running as a service

Example `systemd` units are in [`deploy/`](deploy/). Edit the paths/user, then:

```bash
sudo cp deploy/jarvis-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-orchestrator jarvis-voice
```

---

## Development

```bash
npm test                                          # orchestrator + pc-agent (node --test)
.venv/bin/python -m unittest discover -s voice-service/tests   # voice service
```

The orchestrator and PC agent are ESM Node with zero test frameworks (`node:test`).
The voice service uses Python `unittest`. Each process is independently testable.

---

## License

[MIT](LICENSE) © 2026 Arcco Chakraborty.
