// PC capability: browser.search — open a Google search by launching the
// browser directly (Chrome is the default here; xdg-open proved unreliable).
// Detached + unref'd. browserCmd is overridable via BROWSER_CMD.

import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeBrowser({ spawn = _spawn, browserCmd = process.env.BROWSER_CMD || 'google-chrome' } = {}) {
  return {
    search({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need something to search for.' };
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(q);
      try {
        const p = spawn(browserCmd, [url], OPTS);
        p?.unref?.();
        return { ok: true, speak: `Searching the web for ${q}.` };
      } catch {
        return { ok: false, speak: `I couldn't open the browser.` };
      }
    },
  };
}
