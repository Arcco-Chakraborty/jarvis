// PC capability: open_app — spawn an allow-listed binary, detached + unref'd.
// `allowlist` is { <spoken-name>: <command-string> }. spawn is injected for tests.

import { spawn as _spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadAllowlistSync(path = join(import.meta.dirname, 'allowlist.json')) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

export function makeOpenApp({ allowlist, spawn = _spawn }) {
  return function openApp({ name } = {}) {
    const key = String(name ?? '').toLowerCase().trim();
    if (!key) {
      return { ok: false, speak: "I don't know how to open that." };
    }
    const cmd = allowlist[key];
    if (!cmd) {
      return { ok: false, speak: `I don't know how to open ${key}.` };
    }
    try {
      const parts = String(cmd).trim().split(/\s+/);
      const proc = spawn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore' });
      proc?.unref?.();
      return { ok: true, speak: `Opening ${key}.` };
    } catch {
      return { ok: false, speak: `I couldn't open ${key}.` };
    }
  };
}
