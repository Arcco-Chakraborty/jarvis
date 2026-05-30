// PC capability: window — wmctrl to focus by partial title; xdotool to
// snap (Super+Left/Right) and to minimize / close the active window.

import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeWindow({ spawn = _spawn } = {}) {
  function fire(bin, args, speak, failLabel) {
    try {
      const p = spawn(bin, args, OPTS);
      p?.unref?.();
      return { ok: true, speak };
    } catch {
      return { ok: false, speak: `I couldn't ${failLabel}.` };
    }
  }

  return {
    focus({ name } = {}) {
      const key = String(name ?? '').trim();
      if (!key) return { ok: false, speak: 'I need a window name to focus.' };
      return fire('wmctrl', ['-a', key], `Focusing ${key}.`, `focus ${key}`);
    },
    snap({ dir } = {}) {
      const d = String(dir ?? '').toLowerCase();
      if (d !== 'left' && d !== 'right') {
        return { ok: false, speak: 'I can snap left or right.' };
      }
      return fire('xdotool', ['key', d === 'left' ? 'super+Left' : 'super+Right'],
                  `Snapping ${d}.`, `snap ${d}`);
    },
    minimize: () => fire('xdotool', ['getactivewindow', 'windowminimize'], 'Minimized.', 'minimize the window'),
    close:    () => fire('xdotool', ['getactivewindow', 'windowkill'],     'Closed.',    'close the window'),
  };
}
