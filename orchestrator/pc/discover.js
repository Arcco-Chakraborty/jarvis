// Parse XDG .desktop files into a { lowercased Name: cleaned Exec } map.
// Spec: https://specifications.freedesktop.org/desktop-entry-spec/

import { readdir, readFile as _readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const FIELD_CODES = /\s*%[fFuUickdDnNvm]/g;

export function stripFieldCodes(exec) {
  return String(exec || '').replace(FIELD_CODES, '').replace(/%%/g, '%').trim();
}

export function parseDesktopEntry(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let inEntry = false;
  const kv = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) { inEntry = (t === '[Desktop Entry]'); continue; }
    if (!inEntry) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (kv[key] === undefined) kv[key] = val;
  }
  if (kv.Type !== 'Application') return null;
  const exec = stripFieldCodes(kv.Exec || '');
  if (!exec) return null;
  const hidden = kv.NoDisplay === 'true' || kv.Hidden === 'true';
  return { name: kv.Name || '', exec, hidden, type: kv.Type };
}

const DEFAULT_DIRS = (home) => [
  '/usr/share/applications',
  '/usr/local/share/applications',
  '/var/lib/snapd/desktop/applications',
  '/var/lib/flatpak/exports/share/applications',
  join(home, '.local/share/applications'),
];

export async function discoverApps({
  dirs,
  home = os.homedir(),
  readDir = readdir,
  readFile = _readFile,
} = {}) {
  const targetDirs = dirs ?? DEFAULT_DIRS(home);
  const out = {};
  for (const dir of targetDirs) {
    let names;
    try { names = await readDir(dir); }
    catch { continue; }   // tolerate ENOENT / EACCES
    for (const f of names) {
      if (!f.endsWith('.desktop')) continue;
      let raw;
      try { raw = await readFile(join(dir, f), 'utf8'); }
      catch { continue; }
      const entry = parseDesktopEntry(raw);
      if (!entry || entry.hidden || !entry.name) continue;
      out[entry.name.toLowerCase()] = entry.exec;
    }
  }
  return out;
}
