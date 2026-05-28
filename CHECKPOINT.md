# JARVIS — Build Checkpoint / Handoff

**Last updated:** 2026-05-28
**Audience:** any AI agent (or human) picking up this project mid-stream.
**Source of truth:** `PROJECT.md`. This file tracks *state*; PROJECT.md defines *the spec*.
If the two ever conflict, **PROJECT.md wins** — then fix this file.

---

## TL;DR — where things stand

- **Phase 0 (Scaffold) — DONE.** ESM Node project, seeded SQLite registry, ESP32 adapter wired with polling, `GET /health` + `GET /state` live. `npm test` green.
- **Phase 1 (Switch control) — DONE.** `POST /command {text}` parses → routes → flips the real relay → returns `{ok, speak, intent}`. 35 tests green.
- **Web dashboard (Phase 5, pulled forward) — DONE.** `GET /` serves a static control panel; buttons hit `POST /switch`, free text hits `/command`; live state via `/state` polling. 38 tests green.
- **Toolchain installed** (verified 2026-05-28): node v22, npm, git, gh, python 3.14. The old blocker is cleared.
- **Workflow:** the build is driven by the **superpowers** plugin (obra). Use its flow — `/brainstorm` (scope) → `/write-plan` → `/execute-plan`. *If you are a fresh session that just restarted to load superpowers:* read `PROJECT.md`, then this file, then begin Phase 0 via superpowers.
- **GitHub:** push to a **private** repo named `jarvis` (decided 2026-05-28). Needs `gh auth login` (interactive) first.
- Repo holds the Phase 0–1 orchestrator under `orchestrator/` (config, registry, intent, router, server + tests), specs/plans under `docs/superpowers/`, plus `PROJECT.md` and this file. Pushed to the private `jarvis` repo on GitHub.

## Host / environment

**This machine IS the production host** from PROJECT.md — the "Ubuntu spare laptop" that runs the orchestrator + voice service. So local dev == the deploy box.

- **OS:** Ubuntu 26.04 LTS  •  **Host:** `arcco-chakraborty-Latitude-5490` (Dell Latitude 5490)
- **LAN:** this host is `192.168.1.167` (`192.168.1.x`). The ESP32 `smartswitch` is at **`192.168.0.202`** — a *different* /24 (`192.168.0.x`), yet reachable from the host (cross-subnet routing works). Its base URL is in `.env`. (`smartswitch.local` won't resolve — no mDNS.)
- **Toolchain:** not installed. `sudo` needs a password, so the *user* runs:
  `sudo apt update && sudo apt install -y nodejs npm git gh` — then confirm `node --version` ≥ 18.
- PC agents (Phase 3) run on *other* machines on this same LAN.

## What's in the repo right now

| Path | Status | Notes |
|------|--------|-------|
| `PROJECT.md` | spec, stable | Full system design. **Read it fully before writing code.** |
| `esp32-switch.js` | **done — do not rewrite** | At repo root. Per PROJECT.md §5.2 / §10 it must move to `orchestrator/devices/esp32-switch.js`. **Not moved yet.** |
| `CHECKPOINT.md` | this file | Handoff/state. Keep it current. |

Not yet a git repo. No `package.json`, `node_modules`, SQLite DB, or `.env`. Phases 1–5 untouched.

## Immediate next actions (Phase 0 — Scaffold)

Per PROJECT.md §8, Phase 0 ships a runnable skeleton whose only behavior is `GET /health`. Drive it with superpowers (a quick `/write-plan`, then `/execute-plan`).

0. **Install the toolchain** (user, needs sudo): `sudo apt update && sudo apt install -y nodejs npm git gh`; confirm `node --version` ≥ 18. *Nothing below can run until this is done.*
1. `git init` — the project is not under version control.
2. Create the directory layout from PROJECT.md §10 (`orchestrator/`, `voice-service/`, `pc-agent/`, `deploy/`).
3. **Move** `esp32-switch.js` → `orchestrator/devices/esp32-switch.js`. Do not edit it.
4. `npm init`; add `express` + `better-sqlite3`. Requires **Node 18+** (the adapter uses global `fetch` and `AbortSignal.timeout`).
5. Add `.env` + `orchestrator/config.js` (PROJECT.md §9): ESP32 base URL, Gemini key, `PC_AGENT_TOKEN`, server port. Add `.gitignore` (ignore `.env`, `node_modules/`, `*.db`).
6. Create `orchestrator/db/schema.sql` (PROJECT.md §6) and `orchestrator/db/registry.js` to load + seed it.
7. Seed `devices` with the `smartswitch` board and `switches` with the §4 channel map (table below).
8. `orchestrator/server.js` with `GET /health -> {ok:true}`. Boot sequence per §5.1.

**Verify Phase 0:** `node orchestrator/server.js` boots and `curl localhost:<port>/health` returns `{"ok":true}`.

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
- [ ] **Phase 2 — Voice.** Python service: wake word → record → STT → `POST /command` → TTS. *Verify:* "jarvis, turn off the tubelight" works by voice, end to end.
- [ ] **Phase 3 — PC agent + music.** Capability loader + `music` capability; add the `pc` domain to intent + routing. *Verify:* "jarvis, play \<song\> on the laptop" works.
- [ ] **Phase 4 — Gemini fallback.** LLM intent for commands the rules miss, registry injected, strict JSON output, graceful failure.
- [ ] **Phase 5+ — Expand.** More PC capabilities (§5.5 roadmap), more devices, multi-room voice satellites, status dashboard.

---

*Keep this file current: when you finish a phase, tick its box, update the TL;DR, and note anything the next agent would trip over.*
