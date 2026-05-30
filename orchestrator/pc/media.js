// PC capability: media — playerctl for transport, pactl for volume/mute.
// Spawns are detached + unref'd; we don't wait for exit (voice UX wants fast feedback).

import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeMedia({ spawn = _spawn } = {}) {
  function fire(bin, args, speak, failLabel) {
    try {
      const p = spawn(bin, args, OPTS);
      p?.unref?.();
      return { ok: true, speak };
    } catch {
      return { ok: false, speak: `I couldn't ${failLabel}.` };
    }
  }
  const pctl = (a, sp, fl) => fire('playerctl', a, sp, fl);
  const sink = (a, sp, fl) => fire('pactl', a, sp, fl);

  return {
    playPause:  () => pctl(['play-pause'], 'Toggling playback.',    'change playback'),
    next:       () => pctl(['next'],       'Skipping ahead.',       'skip ahead'),
    prev:       () => pctl(['previous'],   'Going back.',           'go back'),
    volumeUp:   () => sink(['set-sink-volume', '@DEFAULT_SINK@', '+5%'], 'Volume up.',   'change volume'),
    volumeDown: () => sink(['set-sink-volume', '@DEFAULT_SINK@', '-5%'], 'Volume down.', 'change volume'),
    mute:       () => sink(['set-sink-mute', '@DEFAULT_SINK@', 'toggle'], 'Toggling mute.', 'toggle mute'),
    setVolume:  (pct) => {
      const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      return sink(['set-sink-volume', '@DEFAULT_SINK@', `${n}%`], `Volume at ${n} percent.`, 'set the volume');
    },
    playOnSpotify({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need a song or playlist name.' };
      const uri = 'spotify:search:' + encodeURIComponent(q);
      return fire('xdg-open', [uri], `Searching Spotify for ${q}.`, 'open Spotify');
    },
  };
}
