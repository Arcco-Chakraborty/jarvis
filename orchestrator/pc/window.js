// PC capability: window — drives the "Window Calls" GNOME extension over D-Bus
// (org.gnome.Shell.Extensions.Windows) via gdbus. Works on Wayland, no root.
// Methods used: List, Activate, MoveResize, Minimize, Close.
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

const DEST = 'org.gnome.Shell';
const PATH = '/org/gnome/Shell/Extensions/Windows';
const IFACE = 'org.gnome.Shell.Extensions.Windows';

// Spoken-name shortcuts for windows whose wm_class isn't an obvious substring.
const ALIASES = {
  browser: 'chrome', editor: 'code', 'vs code': 'code',
  files: 'nautilus', terminal: 'gnome-terminal',
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]/g, '');

// Pure: spoken name -> window id (or null). Matches wm_class first, then title.
export function resolve(name, windows) {
  const want = norm(ALIASES[String(name).toLowerCase().trim()] || name);
  if (!want) return null;
  for (const w of windows) {
    const cls = norm(w.wm_class);
    if (cls && (cls.includes(want) || want.includes(cls))) return w.id;
  }
  for (const w of windows) {
    if (w.title && norm(w.title).includes(want)) return w.id;
  }
  return null;
}

function pretty(wmClass) {
  return String(wmClass || '')
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function defaultGdbus(method, ...args) {
  return execFileAsync('gdbus', [
    'call', '--session', '--dest', DEST, '--object-path', PATH,
    '--method', `${IFACE}.${method}`, ...args.map(String),
  ], { timeout: 8000 }).then(({ stdout }) => stdout);
}

function defaultWorkArea() {
  const W = parseInt(process.env.WINDOW_SCREEN_W || '1920', 10);
  const H = parseInt(process.env.WINDOW_SCREEN_H || '1080', 10);
  const top = parseInt(process.env.WINDOW_TOP_BAR || '37', 10);
  const halfW = Math.floor(W / 2);
  return { left: [0, top, halfW, H - top], right: [halfW, top, W - halfW, H - top] };
}

// Frozen sentinels so a caller can never mutate the shared object.
const EXT_ERROR = Object.freeze({ ok: false, speak: "I can't control your windows — is the Window Calls extension enabled?" });
const ACTION_ERROR = Object.freeze({ ok: false, speak: "I couldn't do that to the window, sir." });

export function makeWindow({ gdbus = defaultGdbus, getWorkArea = defaultWorkArea } = {}) {
  async function windows() {
    try {
      const out = await gdbus('List');
      const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  const focusedId = (wins) => (wins.find((w) => w.focus) || {}).id;

  return {
    async focus({ name } = {}) {
      const key = String(name ?? '').trim();
      if (!key) return { ok: false, speak: 'I need a window name to focus.' };
      try {
        const wins = await windows();
        if (!wins) return EXT_ERROR;
        const id = resolve(key, wins);
        if (id == null) return { ok: false, speak: `I don't see a window for ${key}.` };
        await gdbus('Activate', String(id));
        return { ok: true, speak: `Focusing ${key}.` };
      } catch { return ACTION_ERROR; }
    },

    async snap({ dir } = {}) {
      const d = String(dir ?? '').toLowerCase();
      if (d !== 'left' && d !== 'right') return { ok: false, speak: 'I can snap left or right.' };
      try {
        const wins = await windows();
        if (!wins) return EXT_ERROR;
        const id = focusedId(wins);
        if (id == null) return { ok: false, speak: 'No window is focused.' };
        await gdbus('MoveResize', String(id), ...getWorkArea()[d].map(String));
        return { ok: true, speak: `Snapped ${d}.` };
      } catch { return ACTION_ERROR; }
    },

    async splitWith({ a, b } = {}, { openApp } = {}) {
      const A = String(a ?? '').trim();
      const B = String(b ?? '').trim();
      if (!A || !B) return { ok: false, speak: 'I need two windows to split.' };
      const area = getWorkArea();
      async function place(name, half) {
        let wins = await windows();
        if (!wins) return EXT_ERROR;
        let id = resolve(name, wins);
        if (id == null && openApp) {
          const o = openApp({ name });
          if (!o.ok) return o;
          await new Promise((r) => setTimeout(r, 1200));
          wins = await windows();
          id = wins ? resolve(name, wins) : null;
        }
        if (id == null) return { ok: false, speak: `I don't see a window for ${name}.` };
        await gdbus('MoveResize', String(id), ...area[half].map(String));
        return { ok: true };
      }
      try {
        const ra = await place(A, 'left'); if (!ra.ok) return ra;
        const rb = await place(B, 'right'); if (!rb.ok) return rb;
        return { ok: true, speak: `${A} on the left, ${B} on the right.` };
      } catch { return ACTION_ERROR; }
    },

    async minimize() {
      try {
        const wins = await windows();
        if (!wins) return EXT_ERROR;
        const id = focusedId(wins);
        if (id == null) return { ok: false, speak: 'No window is focused.' };
        await gdbus('Minimize', String(id));
        return { ok: true, speak: 'Minimized.' };
      } catch { return ACTION_ERROR; }
    },

    async close() {
      try {
        const wins = await windows();
        if (!wins) return EXT_ERROR;
        const id = focusedId(wins);
        if (id == null) return { ok: false, speak: 'No window is focused.' };
        await gdbus('Close', String(id));
        return { ok: true, speak: 'Closed.' };
      } catch { return ACTION_ERROR; }
    },

    async list() {
      const wins = await windows();
      if (!wins) return EXT_ERROR;
      const names = wins
        .filter((w) => w.in_current_workspace !== false)
        .map((w) => pretty(w.wm_class));
      if (names.length === 0) return { ok: true, speak: 'No windows are open, sir.' };
      const list = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return { ok: true, speak: `You have ${list} open, sir.` };
    },
  };
}
