# JARVIS

Self-hosted home voice orchestrator. See `PROJECT.md` for the full system spec and
`CHECKPOINT.md` for build status.

## Orchestrator (Phase 0)

Requires Node 18+ (uses global `fetch`, `AbortSignal.timeout`, and `--env-file`).

### Setup

    cp .env.example .env        # then edit .env: set ESP32_BASE_URL to the board's IP
    npm install

### Run

    npm start                   # boots the orchestrator on $PORT (default 3000)
    curl localhost:3000/health  # -> {"ok":true}
    curl localhost:3000/state   # -> cached ESP32 relay states (debug)

### Test

    npm test
