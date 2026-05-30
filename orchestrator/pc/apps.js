// PC capability: open_app — spawn an app from a catalog of discovered names
// (with optional aliases) or fall back to PATH for single-token names.

import { spawn as _spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverApps } from './discover.js';

const OPTS = { detached: true, stdio: 'ignore' };

export function loadAliasesSync(path = join(import.meta.dirname, 'apps-aliases.json')) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

// Deprecated: kept so server.js keeps importing this between Task 2 and Task 7,
// when the composition root migrates to buildAppCatalog(). Returns an empty
// catalog so the server boots; apps will say "I don't know how to open X"
// until Task 7 lands. Task 7 deletes this export entirely.
export function loadAllowlistSync() {
  return {};
}

// catalog = discovered apps merged with aliases. Aliases pointing to a name
// that wasn't discovered are silently dropped.
export async function buildAppCatalog({
  discover = discoverApps,
  aliases = loadAliasesSync(),
} = {}) {
  const discovered = await discover();
  const out = { ...discovered };
  for (const [alias, target] of Object.entries(aliases || {})) {
    const exec = discovered[String(target).toLowerCase()];
    if (exec) out[String(alias).toLowerCase()] = exec;
  }
  return out;
}

export function makeOpenApp({ allowlist, spawn = _spawn }) {
  return function openApp({ name } = {}) {
    const key = String(name ?? '').toLowerCase().trim();
    if (!key) return { ok: false, speak: "I don't know how to open that." };
    const cmd = allowlist[key];
    if (cmd) {
      try {
        const parts = String(cmd).trim().split(/\s+/);
        const proc = spawn(parts[0], parts.slice(1), OPTS);
        proc?.unref?.();
        return { ok: true, speak: `Opening ${key}.` };
      } catch {
        return { ok: false, speak: `I couldn't open ${key}.` };
      }
    }
    // PATH fallback: only for single-token names (otherwise this becomes a
    // surprising injection vector when users speak garbage).
    if (!key.includes(' ')) {
      try {
        const proc = spawn(key, [], OPTS);
        proc?.unref?.();
        return { ok: true, speak: `Opening ${key}.` };
      } catch {
        return { ok: false, speak: `I don't know how to open ${key}.` };
      }
    }
    return { ok: false, speak: `I don't know how to open ${key}.` };
  };
}
