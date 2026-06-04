// Agent capability: shell — run a PowerShell command. The orchestrator gates
// this behind a spoken "confirm"; the agent only runs what an authed caller sends.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeShell({ spawn = _spawn } = {}) {
  return {
    name: 'shell',
    actions: {
      run({ command } = {}) {
        const cmd = String(command ?? '').trim();
        if (!cmd) return { ok: false, detail: 'no command' };
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', cmd], OPTS);
          p?.unref?.();
          return { ok: true, detail: 'Done.' };
        } catch {
          return { ok: false, detail: "I couldn't run that." };
        }
      },
    },
  };
}
