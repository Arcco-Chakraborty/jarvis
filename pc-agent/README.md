# JARVIS PC Agent (Windows)

A tiny dependency-free Node agent. JARVIS's orchestrator POSTs to it to run
actions on this machine (Phase 1: launch apps).

## Run (Windows)
1. Install Node.js (https://nodejs.org).
2. Set a shared secret (same value as the orchestrator's PC_AGENT_TOKEN):
   `setx PC_AGENT_TOKEN "your-secret"` (reopen the terminal), optionally `setx PORT 7000`.
3. From this folder: `node index.js`
4. Allow the port through Windows Firewall (e.g. Node inbound, TCP 7000).
5. From the orchestrator box: `curl http://<windows-ip>:7000/health` -> capabilities list.

## Orchestrator side
In the orchestrator `.env`:
```
PC_AGENT_TOKEN=your-secret
PC_AGENTS=desktop=http://<windows-ip>:7000
```
Then: "jarvis, open notepad on the desktop".
