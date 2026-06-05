// Agent capability: browser — open a URL in the default browser via Start-Process.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

function normalize(url) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function makeBrowser({ spawn = _spawn } = {}) {
  return {
    name: 'browser',
    actions: {
      open({ url } = {}) {
        const u = normalize(url);
        if (!u) return { ok: false, detail: 'no url' };
        const safe = u.replace(/'/g, "''");
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${safe}'`], OPTS);
          p?.unref?.();
          return { ok: true, detail: `Opening ${u}.` };
        } catch {
          return { ok: false, detail: "I couldn't open that link." };
        }
      },
    },
  };
}
