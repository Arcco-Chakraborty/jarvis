# Multi-PC Phase 1 — "open <app> on the <PC>" (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `multipc-phase1`

## Motivation

Today every `pc` command runs locally on the orchestrator's own box. PROJECT.md §5.5 specs a **PC agent** on each controllable machine. Phase 1 is the vertical slice: a Windows PC runs an agent, and "open \<app\> on the \<pc\>" launches that app **on the remote machine**. Later phases add capabilities (media/shell/system) and more agents.

**Decisions (brainstorming):** first agent = a **Windows PC**; first capability = **open an app/game**; deviation from PROJECT.md — the agent uses Node's built-in `http` (zero deps, just `node server.js`), not Express.

**Out of scope (later phases):** media/shell/system capabilities, the remote confirm-gate, multiple agents used in one command, IP auto-discovery, capability negotiation beyond `/health`.

## Architecture

```
"open steam on the desktop"
  cascade -> pc.js matchPcCommand(text, vocab)   (vocab.pcNames knows "desktop")
     -> { domain:'pc', action:'open_app', target:'steam', machine:'desktop' }
  router: machine present -> resolve pc_agent base_url -> agentClient.run(...)
     -> POST http://<win-ip>:7000/run  (Bearer PC_AGENT_TOKEN)
        { capability:'apps', action:'open', params:{ name:'steam' } }
  agent: apps.open -> Start-Process steam -> { ok, detail:'Opening steam.' }
  -> speak detail
("open steam"  with no machine -> local openApp, unchanged)
```

### A. Windows PC agent — `pc-agent/`
Standalone Node app (stdlib `http`, zero deps). Run on the Windows machine.
- **`pc-agent/server.js`** — `makeAgent({ capabilities, token })` returns an `http` request handler (pure, injectable for tests); `start(port)` listens.
  - `GET /health` → `200 { ok:true, capabilities:[...names] }`.
  - `POST /run` — requires `Authorization: Bearer <token>`; missing/wrong → `401 { ok:false, detail:'unauthorized' }`. Body `{ capability, action, params }`; looks up `capabilities[capability].actions[action]`, calls it with `params`, returns its `{ ok, detail }`. Unknown capability/action → `200 { ok:false, detail:'unknown capability/action' }`. Body parse error → `400`.
  - Any handler throw → `500 { ok:false }` (never crashes the process).
- **`pc-agent/capabilities/apps.js`** — `makeApps({ spawn })` → `{ name:'apps', actions:{ open } }`. `open({ name })`: empty → `{ ok:false, detail:'no app name' }`; else `spawn('cmd', ['/c', 'start', '', name], { detached:true, stdio:'ignore' })` (Windows `start` resolves PATH + App Paths registry, so "chrome"/"steam"/"notepad" work), unref → `{ ok:true, detail:'Opening <name>.' }`; spawn throw → `{ ok:false, detail:"couldn't open <name>" }`. `spawn` injected → testable on Linux.
- **`pc-agent/index.js`** — boot: load `apps`, read `PC_AGENT_TOKEN`/`PORT` (default 7000) from env, `start`.
- **`pc-agent/README.md`** — Windows setup (install Node, set `PC_AGENT_TOKEN`, `node index.js`, open the firewall port).

### B. Orchestrator — registry + remote routing
- **`orchestrator/config.js`:** add `pcAgents: parsePcAgents(process.env.PC_AGENTS)` — a pure parser of `name=url,name=url` → `[{ name, baseUrl }]` (trimmed, drops malformed). `pcAgentToken` already exists.
- **`orchestrator/db/registry.js`:** seed the parsed agents as `pc_agent` device rows (`INSERT OR IGNORE` name/type/base_url); add `getPcAgents()` → `[{ name, base_url }]` and `getPcAgent(name)` → `{ name, base_url } | undefined`. `openRegistry({ ..., pcAgents = config.pcAgents })`.
- **`orchestrator/devices/pc-agent-client.js`:** `makePcAgentClient({ fetchFn = fetch, token = config.pcAgentToken } = {})` → `run(baseUrl, { capability, action, params })`: `POST <baseUrl>/run` with `Authorization: Bearer <token>`, JSON body, ~8s timeout; returns the parsed `{ ok, detail }`; non-ok HTTP / throw / timeout → `{ ok:false, detail:'unreachable' }`. Never throws.
- **`orchestrator/intent/pc.js`:** `matchPcCommand(text, vocab = {})`. In the `open_app` branch, run the captured target through `splitMachine(target, vocab.pcNames ?? [])` → `{ target, machine }` (machine = a trailing "on (the) \<known-pc\>", else `machine:null`). Return `{ domain:'pc', action:'open_app', target, ...(machine ? { machine } : {}) }`. Other actions unchanged (Phase 1 only wires open_app remotely).
- **`orchestrator/intent/index.js`:** pass `vocab` to `matchPcCommand` in both `parseWithSource` and `parseLocal`.
- **`orchestrator/router.js`:** in the `open_app` branch — if `intent.machine`: resolve via injected `pcAgents.get(intent.machine)`; not found → `{ ok:false, speak:"I don't know a PC called <machine>." }`; else `const r = await agentClient.run(a.base_url, { capability:'apps', action:'open', params:{ name:intent.target } }); return { ok:r.ok, speak: r.ok ? r.detail : "I couldn't reach the <machine>." }`. No `machine` → existing local `openApp`.
- **`orchestrator/server.js`:** build `vocab.pcNames = registry.getPcAgents().map(a=>a.name)`; construct `makePcAgentClient()`; inject `pcAgents: { get: registry.getPcAgent }` and `agentClient` into both `route()` call sites + `makePipeline`.

### C. Auth
Shared `PC_AGENT_TOKEN` in the orchestrator `.env` and the Windows agent's env. The agent rejects any `/run` without a matching bearer.

## Error handling
- Agent unreachable / non-200 / timeout → spoken "I couldn't reach the \<machine\>."
- Unknown PC name → "I don't know a PC called \<machine\>."
- Bad/missing token → agent 401; client surfaces it as unreachable.
- Agent never crashes (per-request try/catch → 500); client + capabilities never throw.

## Testing
- **agent server:** `/health` lists capabilities; `/run` with valid token dispatches to the capability action; missing/wrong token → 401; unknown capability/action → ok:false; injected handler throw → 500. (Use the injectable handler — no real socket.)
- **apps capability:** `open({name:'steam'})` spawns `cmd /c start "" steam`; empty name → ok:false; spawn throw → ok:false.
- **config:** `parsePcAgents('desktop=http://x:7000, htpc=http://y')` → two entries; malformed/empty → dropped/[].
- **registry:** seeds pc_agent rows; `getPcAgent('desktop')` → its base_url; unknown → undefined.
- **pc.js:** "open steam on the desktop" (vocab.pcNames=['desktop']) → `{open_app, target:'steam', machine:'desktop'}`; "open steam" → no machine; "on the" with an unknown PC → stays part of the target (no machine).
- **pc-agent-client:** `run()` posts to `<baseUrl>/run` with bearer + body, returns parsed detail; non-ok/throw → `{ok:false, detail:'unreachable'}`.
- **router:** open_app with machine → agentClient.run (remote); unknown machine → graceful; no machine → local openApp.
- **server/boot:** imports cleanly; vocab.pcNames present.

## Verification (live, needs the Windows PC)
1. On Windows: install Node, set `PC_AGENT_TOKEN`, `node pc-agent/index.js`, allow the port through the firewall. `curl http://<win-ip>:7000/health` from the Linux box → capabilities list.
2. Orchestrator `.env`: `PC_AGENTS=desktop=http://<win-ip>:7000` and the same `PC_AGENT_TOKEN`. Restart.
3. "hey jarvis, open notepad on the desktop" → Notepad opens on the Windows PC; Jarvis says "Opening notepad."
4. "open chrome" (no machine) → still opens locally.
