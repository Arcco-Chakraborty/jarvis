# JARVIS — Voice Observability Dashboard Design

**Date:** 2026-05-28
**Status:** Approved — ready for implementation planning
**Scope:** Make the voice pipeline visible in the web dashboard so it can be debugged (it currently
fails silently). Add voice telemetry + a richer dashboard. No changes to switch routing or firmware.
**Source of truth:** PROJECT.md. Voice service stays decoupled — it only knows the orchestrator URL
(PROJECT.md §5.4); the orchestrator remains the hub (no broker).

---

## 1. Goal

When the user runs the voice loop and says "hey jarvis", the dashboard shows — live — whether the
mic/wake registers (a wake-score meter vs threshold), what whisper heard (transcript), what intent it
became and via which layer (rules/Gemini), and the spoken reply. Plus general health (orchestrator,
board, voice-service connectivity) and a recent-command activity feed.

**Acceptance:** with the orchestrator + `run-full.sh` running, the dashboard's Voice panel shows
state transitions (listening → awake → recording → transcribing), a moving **wake-score bar** while
"hey jarvis" is spoken, the latest transcript, and the resulting intent+layer+response; the activity
feed lists recent commands (voice or dashboard) with their matched layer. Orchestrator's 64 tests
stay green.

## 2. Data flow

```
voice-service --POST /voice/event {type,...} (best-effort)--> orchestrator (in-memory telemetry store)
dashboard --GET /voice (~500ms), GET /log (~1.5s), GET /state (1.5s)--> renders panels
```

No new deps; polling (no SSE/websocket); telemetry is in-memory (not persisted) — `command_log` keeps
its existing audit role unchanged.

## 3. Orchestrator changes

### 3.1 Telemetry store (injectable, in-memory)

A `createTelemetry()` factory returning an object with a bounded ring buffer (e.g. last 50 of each):

- `recordVoiceEvent(event)` — push to the voice event buffer and update current voice fields. Maps
  `event.type` → `status`: `ready`/`listening`→`listening`, `awake`→`awake`, `recording`→`recording`,
  `transcript`→`transcribing`, `idle`→`idle`. `wake_score` updates `wakeScore`+`threshold` without
  changing `status`. Always updates `lastEventAt = Date.now()`; `transcript` sets `lastTranscript`.
- `recordCommand({ text, intent, via, ok, speak })` — push `{ ...fields, ts }` to the command buffer.
- `voiceSnapshot()` → `{ status, wakeScore, threshold, lastTranscript, lastEventAt, ageMs, events }`.
- `recentCommands(n = 50)` → newest-first list.

Injected into `buildApp` (like `onCommand`/`onSwitch`); `main()` creates the real one.

### 3.2 Endpoints (added to `buildApp`)

- `POST /voice/event` — body `{type, ...}` → `telemetry.recordVoiceEvent(body)` → `{ ok: true }`.
  (Tolerates missing telemetry by no-op, like other injected deps.)
- `GET /voice` → `telemetry.voiceSnapshot()`.
- `GET /log` → `{ commands: telemetry.recentCommands(50) }`.
- `/health`, `/state`, `/command`, `/switch`, `GET /` — unchanged.

### 3.3 Intent layer attribution (`intent/index.js`)

Add `parseWithSource(text, vocab, classify = geminiClassify)` → `{ intent, via }` where
`via = 'rules'` (matcher hit), `'gemini'` (fallback hit), or `null` (no match). Keep `parse` as a
thin wrapper returning just the intent (existing tests unaffected):

```js
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return { intent: m, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}
```

`main()`'s `onCommand` uses `parseWithSource`, then `telemetry.recordCommand({ text, intent, via, ok, speak })`
in addition to the existing `registry.logCommand(...)`. `via` flows into the `/command` response too
(`{ ok, speak, intent, via }`) — additive, existing fields unchanged.

## 4. Voice service changes

### 4.1 `reporter.py` — best-effort event reporter

`EventReporter(orchestrator_url, timeout_s=1.0)` with `emit(type, **data)`:
- Enqueues the event on an internal `queue.Queue`; a daemon worker thread POSTs `{type, **data}` JSON
  to `${url}/voice/event` via stdlib `urllib`. **All errors swallowed**; the audio loop never blocks
  or crashes if the orchestrator is down. A `NullReporter` (no-op) is used in manual mode/tests.
- Drops events if the queue is backed up (bounded), so telemetry can never stall capture.

### 4.2 Instrumentation

- `main.py`: emit `ready` at start; in the loop emit `listening` before `wait()`, `recording`
  before `transcribe()`, `transcript {text}` after, and `idle` after handling. Pass the reporter in.
- `wakeword.py` `OpenWakeWordListener`: take an injected `reporter`; while reading chunks, emit
  `wake_score {score, threshold}` **throttled to ~3×/sec** (max score since last emit); emit
  `awake {score}` on detection. `ManualWakeListener` stays a no-op w.r.t. telemetry.
- The reporter is built from config (`ORCHESTRATOR_URL`) and only active when a non-manual backend is
  used; manual/console flows use `NullReporter`.

## 5. Dashboard (`orchestrator/public/index.html`)

Add below the existing switch tiles/groups/command box:

```
JARVIS                        ● orch   ● board   ● voice (2s ago)
[ tiles + groups + command box — unchanged ]
── Voice ───────────────────────────────────────────────
 ● LISTENING        wake [█████······|···]  0.42 / thr 0.50
 heard: "turn off the tubelight"
── Activity ────────────────────────────────────────────
 17:52:03  "soket on"          on socket   [gemini]  "Socket is on."
 17:51:40  "lights off"        off lights  [rules]   "Lights are off."
```

- **Header health dots:** orchestrator (reachable), board (`/state.online`), voice
  (`/voice.ageMs < 3000`).
- **Voice panel:** status badge (color per state); a wake-score bar 0..1 with the threshold marked,
  updated from `GET /voice` every ~500ms (this is the key tool to debug silent wake); latest
  transcript.
- **Activity feed:** newest-first from `GET /log` (~1.5s): time, text, `action target`, `[via]`,
  speak; red if `ok:false`.
- Existing `/state` poll (1.5s) drives the tiles unchanged.

## 6. Testing

- **`server.test.js`:** `POST /voice/event` updates an injected telemetry stub / is reflected by
  `GET /voice`; `GET /voice` returns the snapshot; `GET /log` returns recent commands. Existing
  `/health`,`/state`,`/command`,`/switch`,`GET /` tests stay green (they don't hit `/voice`).
- **A telemetry unit test:** `recordVoiceEvent` maps types→status and updates wakeScore/transcript;
  ring buffer bounds; `recordCommand`/`recentCommands` newest-first.
- **`intent/index.test.js`:** `parseWithSource` → `via` is `rules`/`gemini`/`null`; existing `parse`
  tests unchanged.
- **Voice `reporter` python test:** `emit` enqueues + posts via a fake opener; a raising opener is
  swallowed (no exception); `NullReporter.emit` is a no-op.
- **Dashboard:** agent curl-verifies `/voice` + `/log` shapes; **user confirms the live panel in a
  browser** (agent can't run a browser).

## 7. Out of scope

SSE/websockets (polling is enough), controlling/starting voice from the dashboard (observe-only),
persisting telemetry to SQLite, a raw audio VU meter beyond wake-score, auth. No firmware/device-rule
changes.
