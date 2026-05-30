// PC capability: shell — runs a pre-registered recipe via `sh -c`. The
// orchestrator wraps it in a confirmation flow so nothing executes until
// the user explicitly says "confirm" / "go ahead" / "do it".

import { spawn as _spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPTS = { detached: true, stdio: 'ignore' };

export function loadRecipesSync(path = join(import.meta.dirname, 'shell-recipes.json')) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

export function makeShell({ recipes = {}, spawn = _spawn } = {}) {
  return {
    lookup(name) {
      const key = String(name ?? '').toLowerCase().trim();
      return recipes[key] ?? null;
    },
    execute(command) {
      const cmd = String(command ?? '').trim();
      if (!cmd) return { ok: false, speak: 'There was no command to run.' };
      try {
        const p = spawn('sh', ['-c', cmd], OPTS);
        p?.unref?.();
        return { ok: true, speak: `Done.` };
      } catch {
        return { ok: false, speak: `I couldn't run that.` };
      }
    },
  };
}
