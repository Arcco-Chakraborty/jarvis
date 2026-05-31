// PC capability: music — plays the real song by opening its YouTube watch page
// in the browser (yt-dlp resolves the top result). Transport (pause/stop) goes
// through playerctl (MPRIS), which controls the browser tab and Spotify alike.
import { spawn as _spawn, execFile as _execFile } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

// Default resolver: yt-dlp --get-id "ytsearch1:<query>" -> the top video id.
function defaultResolve(query) {
  return new Promise((resolve) => {
    _execFile('yt-dlp', ['--no-warnings', '--get-id', `ytsearch1:${query}`], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const id = String(stdout).trim().split('\n')[0].trim();
      resolve(id || null);
    });
  });
}

export function makeMusic({
  spawn = _spawn,
  resolve = defaultResolve,
  browserCmd = process.env.BROWSER_CMD || 'google-chrome',
  hasPlayerctl = true,
} = {}) {
  function open(url, speak) {
    try { const p = spawn(browserCmd, [url], OPTS); p?.unref?.(); return { ok: true, speak }; }
    catch { return { ok: false, speak: "I couldn't open the browser." }; }
  }
  function transport(arg, speak) {
    if (!hasPlayerctl) return { ok: false, speak: "I can't control playback yet — playerctl isn't installed." };
    try { const p = spawn('playerctl', [arg], OPTS); p?.unref?.(); return { ok: true, speak }; }
    catch { return { ok: false, speak: "I couldn't control playback." }; }
  }
  return {
    async play({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need a song name.' };
      const id = await resolve(q);
      const url = id
        ? `https://www.youtube.com/watch?v=${id}`
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      return open(url, `Playing ${q}.`);
    },
    pauseResume() { return transport('play-pause', 'Toggling playback.'); },
    stop() { return transport('stop', 'Stopping the music.'); },
  };
}
