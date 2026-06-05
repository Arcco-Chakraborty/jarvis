// Agent capability: type — send keystrokes to the focused window via SendKeys.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

// SendKeys treats + ^ % ~ ( ) { } [ ] as control chars; wrap each in braces.
function escapeSendKeys(text) {
  return String(text ?? '').replace(/[+^%~(){}\[\]]/g, (ch) => `{${ch}}`);
}

export function makeType({ spawn = _spawn } = {}) {
  return {
    name: 'type',
    actions: {
      send({ text } = {}) {
        const raw = String(text ?? '').trim();
        if (!raw) return { ok: false, detail: 'no text' };
        const keys = escapeSendKeys(raw).replace(/'/g, "''");
        const script =
          'Add-Type -AssemblyName System.Windows.Forms;' +
          `[System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
          p?.unref?.();
          return { ok: true, detail: 'Typed.' };
        } catch {
          return { ok: false, detail: "I couldn't type that." };
        }
      },
    },
  };
}
