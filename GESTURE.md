# JARVIS — Gesture & Holographic HUD Subsystem

## 0. Context for the agent

This extends an existing project, **JARVIS**, a self-hosted voice assistant. Read this alongside the provided `gesture_service.py` and, if present, the main JARVIS `PROJECT.md`. **Do not re-implement anything `gesture_service.py` already does** — it is the Phase 1–2 deliverable and is included to save tokens.

Core principle (inherited from JARVIS, unchanged): **a gesture is just another way to emit an intent.** The gesture service is a *third input service* alongside the voice service; both feed the same orchestrator `/command` endpoint. Downstream routing, the SQLite device registry, and the ESP32 / PC-agent adapters already exist and are reused as-is.

This subsystem adds two outputs:
1. **World intents** — discrete hand poses POST to the orchestrator `/command` to control the real room. Reuses existing routing.
2. **Holographic HUD** — continuous hand state streams over WebSocket to a fullscreen Three.js interface you grab, drag, zoom, and rotate with your hands.

---

## 1. Current state — already built, do NOT rewrite

`gesture_service.py` (Phases 1–2 complete):
- MediaPipe Hands, up to 2 hands, `model_complexity=0`, mirrored webcam.
- One-euro filter on every landmark, per axis — the jitter smoother.
- `classify()` → one of `FIST`, `OPEN_PALM`, `PINCH`, `PEACE`, `POINT`, `NEUTRAL`.
- Stability buffer (5 frames, majority ≥4) + **edge-triggered** firing + per-gesture cooldown, so a held pose fires exactly once.
- `send_intent(command_text)` — currently prints; contains the commented `requests.post` block for Phase 3.
- Tuning constants at top: `THUMB_THRESH`, `PINCH_THRESH`, `STABILITY_FRAMES`, `STABILITY_MIN`, `EVENT_COOLDOWN`, `CAM_INDEX`.
- Debug window: skeleton, cursor dot on the index tip, gesture label, FPS, last event.

Your work starts at Phase 3.

---

## 2. Gesture taxonomy — the contract everything relies on

Two categories. Keeping them separate is the key design decision for the integrated system.

**Discrete world intents** (edge-triggered → orchestrator POST):

| Gesture | Intent text | Routes to |
|---|---|---|
| `FIST` | `"lights off"` | ESP32 light channels |
| `OPEN_PALM` | `"lights on"` | ESP32 light channels |
| `PEACE` | `"next track"` | PC-agent music capability |

**Continuous HUD signals** (per-frame → WebSocket, NOT intents):
- `cursor` = smoothed index-tip `(x, y)`, per hand
- `pinch` = bool, per hand (grab / release)
- two-hand distance + angle → zoom / rotate (derived HUD-side from the two cursors)
- `POINT` = aim/cursor pose, silent

> **Migration note:** the Phase-1 script currently has `PINCH` inside `GESTURE_COMMANDS` firing a discrete `"select"` intent. When you build the HUD (Phase 4), **remove `PINCH` from `GESTURE_COMMANDS`** and expose it only as the continuous `pinch` flag in the WS payload. Pinch is a grab, not a world command.

---

## 3. Build phases — each must run and be verifiable before the next

### Phase 3 — World intents live
- Enable the POST inside `send_intent`; point `ORCH_URL` at the orchestrator. Posts carry `"source": "gesture"`.
- Orchestrator side: ensure the gesture vocabulary (`lights off`, `lights on`, `next track`) is handled by the **rule matcher**, never the Gemini fallback (gestures must be low-latency and deterministic).
- Registry: add a `lights` group mapping which of the 8 channels on the `smartswitch` board are lights vs fans, so `lights off` leaves the fans alone.
- POST is fire-and-forget with a short timeout — never block the CV loop on the network.

**Verify:** a fist turns the room lights off through the existing ESP32 adapter; a peace sign skips the track on the playing PC agent.

### Phase 4 — Holographic HUD
- Add `ws_server.py`: a WebSocket broadcaster running in a **background thread** inside the gesture process. The CV loop stays on the main thread (OpenCV display requirement); hand off frames via a thread-safe queue.
- Each frame, broadcast a `hands` message (schema §4). Throttle to ~30 Hz.
- Build `hud/` — a fullscreen Vite + Three.js + Framer Motion app. It connects to the WS server and renders floating panels. Pinch over a panel grabs it; hand motion drags it; opening the pinch releases. Two hands both pinching → their distance controls zoom, the line's angle controls rotation of the focused object.

**Verify:** with the gesture service running, you can pinch-drag a panel across the HUD and two-hand-zoom a model, smoothly, on the HTPC.

### Phase 5 — Multimodal fusion
- Voice sets a target, gesture adjusts it. `"jarvis, volume"` arms a volume context in the orchestrator (with a timeout); a subsequent vertical hand drag sets the value.
- Define the arming/timeout handshake across voice service → orchestrator → gesture service.

**Verify:** `"jarvis, volume"` then a hand drag changes system volume on the target PC.

---

## 4. WebSocket contract (gesture service → HUD)

Server: the gesture service, default `ws://<hub>:8765`. The HUD is the client. JSON, one message per `type`.

**Per-frame hand state** (~30 Hz max):
```json
{
  "type": "hands",
  "t": 1730800000.123,
  "hands": [
    {
      "id": 0,
      "handedness": "Right",
      "gesture": "POINT",
      "pinch": false,
      "cursor": [0.62, 0.41],
      "landmarks": [[0.6,0.4], "... 21 pairs, normalized 0..1, origin top-left"]
    }
  ]
}
```

**Discrete gesture event** (mirrors what also went to the orchestrator; HUD may react with a ripple/flash):
```json
{ "type": "event", "t": 1730800000.123, "gesture": "FIST", "command": "lights off" }
```

Coordinates are normalized and already mirrored (selfie view). The HUD maps `[0..1]` → screen space. Two-hand zoom/rotate is computed HUD-side from the two `cursor` points and their `pinch` states; the service does **not** send a zoom value.

---

## 5. Orchestrator integration — existing service, small additions only

- `POST /command {text, source}` already exists; gesture posts set `source = "gesture"`.
- Extend the rule matcher to deterministically map `lights off`, `lights on`, `next track`. These must never fall through to Gemini.
- Add the `lights` group to the registry (channel indices that are lights on the `smartswitch` board).
- **No firmware changes** (inherited non-goal). The `esp32-switch.js` adapter and its index-based control are reused unchanged.

---

## 6. Honest constraints — design around these from the start

- **One 2D webcam has weak depth.** MediaPipe estimates z, but toward/away is the least reliable axis. Build gestures around in-plane motion and finger pose, not precise depth.
- **"Point at *that specific* light" is the hard problem** with a single camera — do not start there. v1 world gestures are global (fist = all lights off); fine-grained targeting comes from voice (Phase 5).
- **Pinch vs fist** is the classification pair most likely to need tuning — `THUMB_THRESH` and `PINCH_THRESH` are the knobs.
- **OpenCV windowing is main-thread** on macOS / some Linux — keep the WS server off the main thread.
- Latency: world intents should fire within a couple of frames of a stable pose; the CV loop must never stall on I/O.

---

## 7. Tech stack

- **Gesture service:** Python 3.11+, `mediapipe`, `opencv-python`, `websockets` (Phase 4), `requests` (fire-and-forget HTTP).
- **HUD:** Vite + Three.js + Framer Motion (same kit as the GearIt site). Plain WebSocket client, no backend of its own.
- **Orchestrator / voice service / PC agents / ESP32:** unchanged, per the main JARVIS spec.
- **Process management:** a `systemd` unit `gesture-service.service` on whichever host owns the webcam (the Ubuntu hub or the HTPC). The HUD runs fullscreen on the HTPC.

---

## 8. Repo layout — additions to the existing `jarvis/` repo

```
jarvis/
  gesture-service/
    gesture_service.py     # EXISTS (Phases 1-2). Tracking, classify, debounce, intent POST.
    ws_server.py           # Phase 4. WebSocket broadcaster, background thread.
    config.py              # Phase 4. Constants extracted from gesture_service.py.
    requirements.txt
  hud/                     # Phase 4. Vite + Three.js + Framer Motion.
    index.html
    src/
      main.js              # WS client + scene setup
      panels.js            # pinch-grab / drag
      controls.js          # two-hand zoom / rotate
  deploy/
    gesture-service.service
  orchestrator/            # EXISTS — Phase 3 touches rules + registry only
  voice-service/           # EXISTS
  pc-agent/                # EXISTS
```

---

## 9. Non-goals (v1)

- No firmware changes to the ESP32.
- No depth camera, Leap Motion, or any new hardware — plain webcam only.
- No spatial "point at the real object to control it" — global or voice-targeted gestures only.
- No gesture "modes" — continuous HUD signals and discrete world poses coexist without a switch. Modes are a stretch goal.
- No multi-camera / multi-room gesture coverage.

---

**Definition of done:** a fist and an open palm control the real room lights, a peace sign skips a track, and on the HTPC you can pinch-drag and two-hand-zoom holographic panels driven by your hands — voice and gesture both flowing through the one orchestrator.
