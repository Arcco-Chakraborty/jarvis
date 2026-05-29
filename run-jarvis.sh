#!/usr/bin/env bash
# One command for hands-on voice testing: starts the orchestrator (background) + the
# full voice loop (foreground). Wake threshold defaults to 0.3 here.
#
# IMPORTANT: launch this YOURSELF (e.g.  ! ./run-jarvis.sh ) so the processes persist in
# your session. Agent-started background processes get killed between turns.
#
# Open http://localhost:3000/ in a browser to watch the dashboard while you speak.
# Say "hey jarvis", then your command. Ctrl-C stops the voice loop (orchestrator keeps
# running so the dashboard stays live; stop it with: pkill -f orchestrator/server.js).
set -uo pipefail
cd "$(dirname "$0")"

# Clean up any previous instances so they don't fight over the mic / port.
pkill -f "orchestrator/server.js" 2>/dev/null
pkill -f "voice-service/main.py" 2>/dev/null
sleep 1

nohup node --env-file=.env orchestrator/server.js > /tmp/jarvis-orch.log 2>&1 &
echo "orchestrator starting (log: /tmp/jarvis-orch.log) ..."
for i in $(seq 1 40); do curl -sf localhost:3000/health >/dev/null 2>&1 && break; sleep 0.3; done
if curl -sf localhost:3000/health >/dev/null 2>&1; then
  echo "orchestrator up -> http://localhost:3000"
else
  echo "WARNING: orchestrator did not come up; check /tmp/jarvis-orch.log"
fi

export VOICE_WAKE_THRESHOLD="${VOICE_WAKE_THRESHOLD:-0.3}"
echo "voice wake threshold = $VOICE_WAKE_THRESHOLD ; say 'hey jarvis', then a command. Ctrl-C to stop."
exec voice-service/run-full.sh
