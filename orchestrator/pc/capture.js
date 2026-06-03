// PC capability: capture — grabs an image for the vision feature.
//   phone():  a snapshot from a phone running an IP-Webcam app (HTTP GET -> base64).
//   screen(): a screenshot via gnome-screenshot (GNOME-Wayland portal).
// Each returns { ok:true, data:<base64>, mime } or { ok:false, speak:<reason> }.
// Never throws.
import { execFile as _execFile } from 'node:child_process';
import { readFile as _readFile, unlink as _unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXEC_OPTS = { timeout: 10000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' };

export function makeCapture({
  execFile = promisify(_execFile),
  readFile = _readFile,
  unlink = _unlink,
  fetchFn = fetch,
  phoneUrl = '',
} = {}) {
  return {
    async phone() {
      if (!phoneUrl) return { ok: false, speak: "I don't have a phone camera set up, sir." };
      try {
        const res = await fetchFn(phoneUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, speak: "I couldn't reach your phone's camera." };
        const buf = Buffer.from(await res.arrayBuffer());
        // Strip any "; charset=..." parameter — Gemini's inlineData wants a bare MIME type.
        const mime = (res.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim();
        return { ok: true, data: buf.toString('base64'), mime };
      } catch {
        return { ok: false, speak: "I couldn't reach your phone's camera." };
      }
    },
    async screen() {
      const path = join(tmpdir(), `jarvis-screen-${Date.now()}-${randomBytes(4).toString('hex')}.png`);
      try {
        await execFile('gnome-screenshot', ['-f', path], EXEC_OPTS);
        const buf = await readFile(path);
        return { ok: true, data: Buffer.from(buf).toString('base64'), mime: 'image/png' };
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          return { ok: false, speak: "I can't see the screen — gnome-screenshot isn't installed." };
        }
        return { ok: false, speak: "I couldn't capture the screen." };
      } finally {
        try { await unlink(path); } catch { /* best effort */ }
      }
    },
  };
}
