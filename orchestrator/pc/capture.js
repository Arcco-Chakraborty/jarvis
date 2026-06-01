// PC capability: capture — grabs an image for the vision feature.
//   camera(): one frame from /dev/video0 via ffmpeg (scaled, JPEG, to stdout).
//   screen(): a screenshot via gnome-screenshot (GNOME-Wayland portal).
// Each returns { ok:true, data:<base64>, mime } or { ok:false, speak:<reason> }.
// Never throws.
import { execFile as _execFile } from 'node:child_process';
import { existsSync as _existsSync } from 'node:fs';
import { readFile as _readFile, unlink as _unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXEC_OPTS = { timeout: 10000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' };

export function makeCapture({
  execFile = promisify(_execFile),
  exists = _existsSync,
  readFile = _readFile,
  unlink = _unlink,
} = {}) {
  return {
    async camera() {
      if (!exists('/dev/video0')) {
        return { ok: false, speak: "I don't see a camera connected, sir." };
      }
      try {
        const { stdout } = await execFile(
          'ffmpeg',
          ['-y', '-f', 'v4l2', '-i', '/dev/video0', '-frames:v', '1',
           '-vf', 'scale=1024:-1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
          EXEC_OPTS,
        );
        return { ok: true, data: Buffer.from(stdout).toString('base64'), mime: 'image/jpeg' };
      } catch {
        return { ok: false, speak: "I couldn't get a picture from the camera." };
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
