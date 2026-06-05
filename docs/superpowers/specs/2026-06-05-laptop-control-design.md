# Laptop Control — Design

**Date:** 2026-06-05
**Status:** Approved, pre-implementation
**Scope:** `orchestrator/intent/pc.js`, `orchestrator/router.js`, `orchestrator/server.js` (capability wiring), `pc-agent/` (new/extended capabilities), `.env` / `.env.example`, related tests.

## Problem & goal

The remote PC agent is currently called "desktop" and supports only: open apps, media/volume keys, and confirm-gated shell. We want to (1) rename it to **laptop** everywhere, and (2) add three new remote capabilities: **set volume to a level**, **open a website/URL**, and **type text/keystrokes**. No power/lock capability (explicitly out of scope).

The agent must stay **dependency-free** (built-in Node + PowerShell / `keybd_event` only) per the project's hard constraint.

## Part 1 — Rename desktop → laptop

The machine name originates in `.env` `PC_AGENTS=<name>=<url>`, flows into the DB (`devices.name`), and surfaces as `vocab.pcNames = registry.getPcAgents().map(a => a.name)` (server.js:330). Because `registry.seed()` now upserts, changing the name in `.env` and restarting is *almost* enough — but `name` is the conflict key, so a *new* name inserts a *second* row rather than renaming the old one.

**Decision:** change `PC_AGENTS=laptop=http://192.168.0.117:7000` in `.env` (and `.env.example`'s placeholder), and delete the stale `desktop` row from the DB once (or let a one-line migration in `seed()` remove orphaned `pc_agent` rows not present in config). To keep `seed()` simple and config-authoritative, `seed()` will **delete pc_agent rows whose name is not in the configured set** before upserting. This makes `.env` the full source of truth for which agents exist.

No firmware/ESP32 changes. The agent's own code is name-agnostic (the name lives only orchestrator-side), so the agent binary needs no rename — only its new capabilities (Part 2).

## Part 2 — Three new remote capabilities

All three follow the existing remote pattern: `pc.js` parses the command and (via `stripMachine`) tags `machine`; `router.js` dispatches `agentClient.run(base_url, { capability, action, params })`; the agent executes and returns `{ ok, detail }`.

### 2a. Set volume to a level
- **Speech:** `"set volume to 30 on the laptop"`. `pc.js` already parses `set_volume` with a numeric arg; today it's local-only. Add `set_volume` to the router's `REMOTE_MEDIA_OPS` so it dispatches remotely as `{ capability:'media', action:'set_volume', params:{ level } }`.
- **Agent:** Windows has no dependency-free absolute-volume API. The `media` capability approximates: press `VK_VOLUME_DOWN` ~50× (floor to 0), then `VK_VOLUME_UP` round(level/2)× (each step ≈ 2%). Clamp level to 0–100. Returns `{ ok:true, detail:"Volume set to <level>." }`.

### 2b. Open a website / URL
- **Speech:** `"open youtube.com on the laptop"`, `"open <site> on the laptop"`. `pc.js` `open_app` already captures the target after "open/launch/start". Add URL/site detection: if the target looks like a domain/URL (contains a dot with no spaces, or starts with http) emit `{ action:'open_url', target }` instead of `open_app`. Router dispatches `{ capability:'browser', action:'open', params:{ url } }`.
- **Agent:** new `browser` capability → `Start-Process <url>` (normalizing a bare domain to `https://`). Returns `{ ok:true, detail:"Opening <url>." }`. `/health` advertises `browser`.

### 2c. Type text / keystrokes
- **Speech:** `"type hello world on the laptop"`. New `pc.js` rule: `^type\s+(.+)$` → `{ domain:'pc', action:'type', text }`. Router dispatches `{ capability:'type', action:'send', params:{ text } }` when `machine` is set (typing is remote-only; no local typing capability).
- **Agent:** new `type` capability → PowerShell `[System.Windows.Forms.SendKeys]::SendWait()` (or WScript.Shell `SendKeys`) with the text escaped for SendKeys special chars. Returns `{ ok:true, detail:"Typed." }`. `/health` advertises `type`.

## Architecture / boundaries

- **Orchestrator:** `pc.js` gains URL detection + `type` rule; `router.js` adds `set_volume` to remote media, an `open_url` remote branch, and a `type` remote branch (all guarded by `machine` + `agentClient` + known-agent checks, mirroring existing branches). No change to confirm-gating — shell remains the only confirm-gated path.
- **Agent:** `browser` and `type` are new capability modules under `pc-agent/capabilities/`; `media` gains a `set_volume` action. `index.js` registers them; `/health` lists `["apps","media","shell","browser","type"]`.
- **Deployment:** the user pulls + restarts the agent on the Windows box (per project norm).

## Error handling

- Unreachable/῾non-2xx agent → existing `remoteSpeak` "I couldn't reach the laptop." path (unchanged).
- Unknown op on agent → agent returns `{ ok:false, detail }`; router speaks the detail.
- `set_volume` with no/garbled number → `pc.js` already declines to emit the intent (returns null), so it won't dispatch.

## Testing

- **pc.js (`pc.test.js`):** URL → `open_url`; non-URL → `open_app`; `"type ..."` → `type` intent; `set_volume` still parses; all respect `on the laptop` machine tagging.
- **router (`router.test.js`):** `set_volume`/`open_url`/`type` with `machine` dispatch the right `{capability,action,params}` (mock `agentClient`); without a known agent → "I don't know a PC called …"; unreachable → "I couldn't reach the laptop."
- **registry:** seeding deletes orphaned pc_agent rows not in config (rename leaves exactly one `laptop` row).
- **Agent capability units:** `browser`/`type`/`media.set_volume` build the correct command strings (inject a fake exec, assert the command, never actually spawn).
- Manual: pull+restart agent; `/health` lists the five capabilities; speak each new command end-to-end.

## Out of scope (YAGNI)

Power/lock/sleep/shutdown; local typing; remote window management; absolute volume via external tools (nircmd/AudioDeviceCmdlets) — the key-step approximation is intentional to honor the dependency-free constraint.
