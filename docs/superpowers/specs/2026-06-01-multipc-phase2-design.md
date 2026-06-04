# Multi-PC Phase 2 — media keys + confirm-gated shell (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `multipc-phase2`

## Motivation

Phase 1 shipped "open \<app\> on the \<pc\>". Phase 2 adds two Windows agent capabilities and generalizes targeting so **media transport** ("pause / next / volume up on the desktop") and **confirm-gated shell** ("run \<cmd\> on the desktop") route to the named PC.

**Decisions (brainstorming):** both **media** (transport keys, not "play \<song\>") and **shell** (PowerShell, gated by the orchestrator's confirm-flow). Reuses Phase 1's agent, client, registry, and `PC_AGENTS`/`PC_AGENT_TOKEN`.

**Out of scope:** playing a specific song remotely, a `system`/power capability, capability-driven vocab from `/health`, multiple agents in one command.

## Architecture

### 1. Generalize machine targeting — `intent/pc.js`
Phase 1 stripped "on the \<pc\>" only inside `open_app`. Refactor: at the top of `matchPcCommand`, strip a trailing **"on (the) \<known-pc\>"** from the whole normalized text and remember `machine`; run the existing matchers on the stripped text; attach `machine` to **open_app / media / shell** results (a `withMachine(intent)` helper). Window/search/split stay local-only (machine not attached — those don't route remotely).
- `stripMachine(text, pcNames)` → `{ text, machine }` (regex anchored to a trailing known pc name; escaped). Replaces the old `splitMachine`.
- Examples: "pause on the desktop" → `{media, op:'play_pause', machine:'desktop'}`; "volume up on the desktop" → `{media, op:'volume_up', machine:'desktop'}`; "run dir on the desktop" → `{shell, target:'dir', machine:'desktop'}`; "open steam on the desktop" → `{open_app, target:'steam', machine:'desktop'}` (unchanged behavior). Bare "pause" → no machine (local).

### 2. Agent `media` capability — `pc-agent/capabilities/media.js`
`makeMedia({ spawn })` → `{ name:'media', actions:{ play_pause, next, prev, volume_up, volume_down, mute } }`. Each action sends the matching Windows **media/volume virtual key** via PowerShell `keybd_event` (so it controls whatever app has media focus — like the Super-key media keys):
- VK map: `play_pause`=0xB3, `next`=0xB0, `prev`=0xB1, `volume_up`=0xAF, `volume_down`=0xAE, `mute`=0xAD.
- Spawns `powershell` `['-NoProfile','-Command', <script>]` where `<script>` is an `Add-Type` of `keybd_event` (user32) that calls it with the action's VK. Returns `{ ok:true, detail:'Done.' }`; spawn throw → `{ ok:false, detail:"couldn't do that" }`. `spawn` injected → tested on Linux (assert the script contains the right VK hex + `keybd_event`).

### 3. Agent `shell` capability — `pc-agent/capabilities/shell.js`
`makeShell({ spawn })` → `{ name:'shell', actions:{ run } }`. `run({ command })`: empty → `{ ok:false, detail:'no command' }`; else spawn `powershell` `['-NoProfile','-Command', command]` (detached, fire-and-forget, like the local shell) → `{ ok:true, detail:'Done.' }`; spawn throw → `{ ok:false, detail:"couldn't run that" }`. The agent only runs what an **authenticated** caller sends; the safety gate is on the orchestrator.

### 4. Agent boot — `pc-agent/index.js`
Load `apps + media + shell`; `/health` lists all three. (`server.js` agent core is unchanged.)

### 5. Orchestrator — remote media (`router.js`)
In the `media` branch: if `intent.machine`, resolve the agent (`pcAgents.get`) and `agentClient.run(baseUrl, { capability:'media', action:intent.op, params:{} })` for the transport ops (`play_pause/next/prev/volume_up/volume_down/mute`); speak its detail (unreachable → "I couldn't reach the \<machine\>."; unknown PC → "I don't know a PC called \<machine\>."). `set_volume` with a number and `play_music`/`stop_music` with a machine → polite "I can't do that on the \<pc\> yet." No machine → today's local media (unchanged).

### 6. Orchestrator — remote confirm-gated shell (`server.js makePipeline`)
- **Shell intent:** if `intent.machine`, the command is the **literal** `intent.command || intent.target` (Windows recipes aren't known locally); stash `pending = { command, machine, expiresAt }` and prompt "Should I run \<command\> on the \<pc\>? Say confirm to run." (local path unchanged: recipe lookup, no machine).
- **Confirm:** read `{ command, machine }` from pending; if `machine` → resolve the agent + `agentClient.run(baseUrl, { capability:'shell', action:'run', params:{ command } })`, speak its detail (or "I couldn't reach the \<machine\>."); else local `shell.execute`. **Nothing runs (local or remote) without a fresh spoken "confirm".**
- `makePipeline` already receives `agentClient` + `pcAgents` (Phase 1); use them in the confirm/shell handlers.

## Error handling
- Unknown PC → "I don't know a PC called \<machine\>." Unreachable agent → "I couldn't reach the \<machine\>." Remote action failure → the agent's detail (per Phase 1's router convention). Capabilities + client never throw; agent per-request try/catch.

## Testing
- **agent `media`:** each action spawns `powershell` with a script containing the right VK hex + `keybd_event`; spawn throw → ok:false.
- **agent `shell`:** `run({command:'dir'})` spawns `powershell -NoProfile -Command dir`; empty → ok:false; spawn throw → ok:false.
- **`intent/pc.js`:** "pause on the desktop" (pcNames=['desktop']) → media play_pause + machine; "volume up on the desktop" → volume_up + machine; "run dir on the desktop" → shell target 'dir' + machine; "open steam on the desktop" → open_app + machine (Phase-1 parity); bare "pause" / "run dir" → no machine; an unknown pc suffix → stays in the text.
- **`router.js`:** media op with machine → agentClient.run(media, op); play_music/set_volume with machine → polite refusal; no machine → local media.
- **`server.js` pipeline:** "run dir on the desktop" → pending with machine + "on the desktop" prompt, NOT executed; "confirm" → agentClient.run(shell, run, {command:'dir'}); a non-confirm clears pending; unknown machine on confirm → graceful.
- agent boot loads 3 capabilities (`/health`).

## Verification (live, needs the Windows PC + the Phase-1 setup)
1. Update the Windows agent (pull) and restart `node pc-agent/index.js` — `/health` shows apps, media, shell.
2. "jarvis, pause on the desktop" → media toggles on Windows. "volume up on the desktop" → volume rises.
3. "jarvis, run notepad on the desktop" → "Should I run notepad on the desktop? Say confirm." → "confirm" → notepad runs.
4. Local "pause" / "run free space" still work unchanged.
