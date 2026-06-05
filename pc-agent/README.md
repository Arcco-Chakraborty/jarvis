# JARVIS PC Agent

A tiny, **dependency-free** Node agent (`node index.js`, no `npm install`). JARVIS's
orchestrator POSTs to it to run actions on this machine. Reference target is Windows,
but the agent is plain Node `http` and portable.

Capabilities: **apps** (launch), **media** (play/pause/next/volume via media keys),
**shell** (run a command — gated behind a spoken "confirm" on the orchestrator), and
**type** (send keystrokes).

## API

```
GET  /health                      -> { "ok": true, "capabilities": ["apps","media","shell","type"] }
POST /run                         (header: Authorization: Bearer <PC_AGENT_TOKEN>)
     { "capability":"apps", "action":"open", "params":{ "name":"notepad" } }
```

## Run (Windows)

1. Install Node.js (https://nodejs.org).
2. Set the shared secret (same value as the orchestrator's `PC_AGENT_TOKEN`):
   `setx PC_AGENT_TOKEN "your-secret"` (reopen the terminal), optionally `setx PORT 7000`.
3. From this folder: `node index.js`
4. Allow the port through Windows Firewall (Node inbound, TCP 7000).
5. From the orchestrator box: `curl http://<windows-ip>:7000/health` → capability list.

## Orchestrator side

In the orchestrator `.env`:

```env
PC_AGENT_TOKEN=your-secret
PC_AGENTS=desktop=http://<windows-ip>:7000
```

Then: *"jarvis, open notepad on the desktop"*, *"pause on the desktop"*,
*"run notepad on the desktop"* → "confirm".

> The agent runs whatever an authenticated caller sends — the safety gate (the spoken
> "confirm") lives on the orchestrator. Keep `PC_AGENT_TOKEN` secret and the agent on a
> trusted LAN.
