// Agent capability: apps — launch a program on this (Windows) machine.
// Windows `start "" <name>` resolves PATH + App Paths registry.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeApps({ spawn = _spawn } = {}) {
  return {
    name: 'apps',
    actions: {
      open({ name } = {}) {
        const app = String(name ?? '').trim();
        if (!app) return { ok: false, detail: 'no app name' };
        try {
          const p = spawn('cmd', ['/c', 'start', '', app], OPTS);
          p?.unref?.();
          return { ok: true, detail: `Opening ${app}.` };
        } catch {
          return { ok: false, detail: `I couldn't open ${app}.` };
        }
      },
    },
  };
}
