// PC capability: music — plays a YouTube search result via mpv + yt-dlp,
// controlled over mpv's JSON IPC socket. No accounts, no playerctl.
import { spawn as _spawn } from 'node:child_process';
import { connect as _connect } from 'node:net';
import { existsSync as _existsSync } from 'node:fs';

const SOCKET = '/tmp/jarvis-mpv.sock';
const OPTS = { detached: true, stdio: 'ignore' };

export function makeMusic({ spawn = _spawn, connect = _connect, exists = _existsSync, socket = SOCKET } = {}) {
  let proc = null;

  function send(command, speak) {
    if (!exists(socket)) return { ok: false, speak: 'Nothing is playing.' };
    try {
      const sock = connect(socket);
      sock.on?.('error', () => {});             // swallow async socket errors
      sock.write(JSON.stringify({ command }) + '\n');
      sock.end?.();
      return { ok: true, speak };
    } catch {
      return { ok: false, speak: 'Nothing is playing.' };
    }
  }

  return {
    play({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need a song name.' };
      try {
        if (proc) { try { proc.kill?.(); } catch {} }
        proc = spawn('mpv', ['--no-video', '--no-terminal', `--input-ipc-server=${socket}`, `ytdl://ytsearch1:${q}`], OPTS);
        proc?.unref?.();
        return { ok: true, speak: `Playing ${q}.` };
      } catch {
        return { ok: false, speak: "I couldn't play that." };
      }
    },
    pauseResume() { return send(['cycle', 'pause'], 'Toggling playback.'); },
    stop() {
      const r = send(['quit'], 'Stopping the music.');
      proc = null;
      return r;
    },
  };
}
