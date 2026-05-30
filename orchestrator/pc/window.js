// PC capability: window — wmctrl to focus by partial title; xdotool to
// snap (Super+Left/Right) and to minimize / close the active window.

import { spawn as _spawn, exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';

const OPTS = { detached: true, stdio: 'ignore' };

const _execAsync = promisify(_exec);
const defaultListWindows = () => _execAsync('wmctrl -l').then(({ stdout }) => stdout);

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
    async splitWith({ a, b } = {}, { openApp, listWindows, sleep } = {}) {
      const A = String(a ?? '').trim();
      const B = String(b ?? '').trim();
      if (!A || !B) return { ok: false, speak: 'I need two apps to split.' };
      const ls = listWindows ?? defaultListWindows;
      const napFn = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      async function ensure(app, snapDir) {
        const list = await ls().catch(() => '');
        if (!list.toLowerCase().includes(app.toLowerCase())) {
          if (!openApp) return { ok: false, speak: `I don't have ${app}.` };
          const r = openApp({ name: app });
          if (!r.ok) return r;
          await napFn(900);
        }
        const f = fire('wmctrl', ['-a', app], `Focusing ${app}.`, `focus ${app}`);
        if (!f.ok) return f;
        return fire('xdotool', ['key', snapDir], `Snapped ${app}.`, `snap ${app}`);
      }
      const ra = await ensure(A, 'super+Left'); if (!ra.ok) return ra;
      const rb = await ensure(B, 'super+Right'); if (!rb.ok) return rb;
      return { ok: true, speak: `${A} on the left, ${B} on the right.` };
    },
  };
}
