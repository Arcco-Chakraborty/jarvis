# Voice UX + Media Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "play \<song\>" actually play (YouTube via mpv), make browser search reliably open Chrome, and turn the voice loop into one-command-per-wake with a responsive recording→thinking handoff.

**Architecture:** New self-contained `orchestrator/pc/music.js` runs an `mpv` process controlled over its JSON IPC socket (no playerctl/accounts). `intent/pc.js` + `router.js` + `server.js` route `play_music`/`play_pause`/`stop_music` to it. `browser.js` launches Chrome directly. `voice-service` collapses `run_conversation` to one-shot and emits a `transcribing` event the instant VAD ends (the dashboard already renders it as THINKING).

**Tech Stack:** Node `node:test`, `node:net` IPC, `mpv` + `yt-dlp`; Python stdlib `unittest`, faster-whisper, webrtcvad.

**Spec:** `docs/superpowers/specs/2026-05-31-voice-ux-media-fixes-design.md`
**Branch:** `voice-ux-media-fixes` (already created).

**Test commands:**
- Node: `npm test` (runs `node --test`). Single file: `node --test orchestrator/pc/music.test.js`.
- Python: `.venv/bin/python voice-service/tests/<file>.py -v`; full: `( cd voice-service/tests && ../../.venv/bin/python -m unittest discover -s . -p 'test_*.py' )`.

---

## File Structure

- `orchestrator/pc/music.js` (create) — mpv player + IPC control. One responsibility: play/pause/stop music.
- `orchestrator/pc/music.test.js` (create).
- `orchestrator/intent/pc.js` (modify) — `play <q>` → `play_music`; add `stop_music`.
- `orchestrator/intent/pc.test.js` (modify) — update spotify tests, add stop_music.
- `orchestrator/router.js` (modify) — dispatch music ops; drop `spotify_search`.
- `orchestrator/router.test.js` (modify) — replace the spotify_search test.
- `orchestrator/pc/media.js` (modify) — remove `playOnSpotify`.
- `orchestrator/pc/media.test.js` (modify) — remove the 2 playOnSpotify tests.
- `orchestrator/server.js` (modify) — construct + inject `music`.
- `orchestrator/pc/browser.js` (modify) — launch configurable browser (default Chrome).
- `orchestrator/pc/browser.test.js` (modify) — expect `google-chrome`.
- `voice-service/main.py` (modify) — one-shot `run_conversation` + on_transcribing wiring.
- `voice-service/tests/test_main.py` (modify) — rewrite `RunConversationTest`.
- `voice-service/stt.py` (modify) — `on_transcribing` hook on both listen methods.
- `voice-service/tests/test_whisper.py` (modify) — on_transcribing tests.
- `voice-service/config.py` (modify) — `vad_silence_ms` default 600.
- `voice-service/tests/test_config.py` (modify) — update default assertion.

---

## Task 1: `music.js` — mpv player + IPC control

**Files:** Create `orchestrator/pc/music.js`, `orchestrator/pc/music.test.js`.

- [ ] **Step 1: Write the failing tests** — create `orchestrator/pc/music.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMusic } from './music.js';

function harness({ exists = () => true } = {}) {
  const calls = { spawn: [], writes: [] };
  const proc = { unref: () => {}, kill: () => calls.spawn.push('kill') };
  const spawn = (bin, args, opts) => { calls.spawn.push({ bin, args, opts }); return proc; };
  const sock = { on: () => {}, write: (d) => calls.writes.push(d), end: () => {} };
  const connect = () => sock;
  const m = makeMusic({ spawn, connect, exists, socket: '/tmp/test-mpv.sock' });
  return { m, calls };
}

test('play spawns mpv with a ytsearch1 url and the ipc socket', () => {
  const { m, calls } = harness();
  const res = m.play({ query: 'daft punk' });
  assert.equal(res.ok, true);
  const c = calls.spawn.find((x) => x.bin === 'mpv');
  assert.ok(c, 'mpv spawned');
  assert.ok(c.args.includes('--input-ipc-server=/tmp/test-mpv.sock'));
  assert.ok(c.args.includes('ytdl://ytsearch1:daft punk'));
  assert.match(res.speak, /playing daft punk/i);
});

test('play refuses an empty query', () => {
  const { m } = harness();
  assert.equal(m.play({ query: '   ' }).ok, false);
  assert.equal(m.play({}).ok, false);
});

test('pauseResume writes a cycle-pause command to the socket', () => {
  const { m, calls } = harness();
  const res = m.pauseResume();
  assert.equal(res.ok, true);
  assert.equal(calls.writes[0].trim(), JSON.stringify({ command: ['cycle', 'pause'] }));
});

test('stop writes a quit command', () => {
  const { m, calls } = harness();
  const res = m.stop();
  assert.equal(res.ok, true);
  assert.equal(calls.writes[0].trim(), JSON.stringify({ command: ['quit'] }));
});

test('control fails soft when nothing is playing (no socket)', () => {
  const { m } = harness({ exists: () => false });
  const r = m.pauseResume();
  assert.equal(r.ok, false);
  assert.match(r.speak, /nothing is playing/i);
  assert.equal(m.stop().ok, false);
});

test('play catches spawn errors', () => {
  const m = makeMusic({ spawn: () => { throw new Error('ENOENT'); }, connect: () => ({}), exists: () => true });
  const r = m.play({ query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test orchestrator/pc/music.test.js`. Expected: FAIL (cannot find `./music.js`).

- [ ] **Step 3: Implement** — create `orchestrator/pc/music.js`:

```js
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
```

- [ ] **Step 4: Run to verify pass** — `node --test orchestrator/pc/music.test.js`. Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/pc/music.js orchestrator/pc/music.test.js
git commit -m "pc: music capability — mpv + yt-dlp player with IPC control"
```

---

## Task 2: intent — `play <q>` → `play_music`, add `stop_music`

**Files:** Modify `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`.

- [ ] **Step 1: Update the failing tests** — in `orchestrator/intent/pc.test.js`, replace the `spotify_search` test block (the `test('"play <query>" routes to spotify_search', ...)` test, lines ~98-103) with:

```js
test('"play <query>" routes to play_music', () => {
  assert.deepEqual(matchPcCommand('play discover weekly'),
    { domain:'pc', action:'media', op:'play_music', arg:'discover weekly' });
  assert.deepEqual(matchPcCommand('play bohemian rhapsody'),
    { domain:'pc', action:'media', op:'play_music', arg:'bohemian rhapsody' });
});

test('"stop music" / "stop the music" / "stop playing" route to stop_music', () => {
  assert.deepEqual(matchPcCommand('stop music'),      { domain:'pc', action:'media', op:'stop_music' });
  assert.deepEqual(matchPcCommand('stop the music'),  { domain:'pc', action:'media', op:'stop_music' });
  assert.deepEqual(matchPcCommand('stop playing'),    { domain:'pc', action:'media', op:'stop_music' });
});

test('bare "stop" is not a pc command (it is the voice sleep word)', () => {
  assert.equal(matchPcCommand('stop'), null);
});
```

(Leave the `'"play music" / "play" stay as play_pause'` test as-is — that behavior is unchanged.)

- [ ] **Step 2: Run to verify it fails** — `node --test orchestrator/intent/pc.test.js`. Expected: FAIL (still emits `spotify_search`; no `stop_music`).

- [ ] **Step 3: Implement** — in `orchestrator/intent/pc.js`:

(a) Add a `stop_music` entry to the `MEDIA_FIXED` array (append as the last element before the closing `]`):

```js
  [/^stop(?:\s+(?:the\s+)?music|\s+playing)$/,          'stop_music'],
```

(b) Change the `play <query>` matcher's op from `spotify_search` to `play_music` (the `playQ` block):

```js
  // play <query> -> music.play (excludes literal "music" so play_pause keeps winning above)
  const playQ = norm.match(/^play\s+(?!music$)(.+)$/);
  if (playQ) {
    return { domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() };
  }
```

- [ ] **Step 4: Run to verify pass** — `node --test orchestrator/intent/pc.test.js`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent: play <q> -> play_music; add stop_music (bare 'stop' stays sleep word)"
```

---

## Task 3: router — dispatch music ops

**Files:** Modify `orchestrator/router.js`, `orchestrator/router.test.js`.

- [ ] **Step 1: Update the failing test** — in `orchestrator/router.test.js`, replace the `test('pc.media spotify_search -> media.playOnSpotify', ...)` block (lines ~202-213) with:

```js
test('pc.media play_music -> music.play', async () => {
  const calls = [];
  const music = { play: (a) => { calls.push(a); return { ok: true, speak: 'playing' }; } };
  const res = await route(
    { domain:'pc', action:'media', op:'play_music', arg:'daft punk' },
    { board: fakeBoard(), registry, music },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], { query: 'daft punk' });
});

test('pc.media play_pause -> music.pauseResume; stop_music -> music.stop', async () => {
  const hits = [];
  const music = {
    pauseResume: () => { hits.push('pause'); return { ok: true, speak: 'toggling' }; },
    stop:        () => { hits.push('stop');  return { ok: true, speak: 'stopping' }; },
  };
  await route({ domain:'pc', action:'media', op:'play_pause' }, { board: fakeBoard(), registry, music });
  await route({ domain:'pc', action:'media', op:'stop_music' }, { board: fakeBoard(), registry, music });
  assert.deepEqual(hits, ['pause', 'stop']);
});
```

(If `fakeBoard` / `registry` are defined earlier in the file, reuse them; do not redefine. Check the top of router.test.js.)

- [ ] **Step 2: Run to verify it fails** — `node --test orchestrator/router.test.js`. Expected: FAIL (router still has `spotify_search`, no music dispatch).

- [ ] **Step 3: Implement** — in `orchestrator/router.js`:

(a) Add `music` to the route options destructure:

```js
export async function route(intent, { board, registry, openApp, media, window: win, browser, music } = {}) {
```

(b) Replace the entire `if (intent.action === 'media') { ... }` block with:

```js
    if (intent.action === 'media') {
      const nc = (w) => ({ ok: false, speak: `${w} capability not configured.` });
      switch (intent.op) {
        case 'play_music':   return music ? music.play({ query: intent.arg }) : nc('Music');
        case 'play_pause':   return music ? music.pauseResume() : nc('Music');
        case 'stop_music':   return music ? music.stop() : nc('Music');
        case 'next':         return media ? media.next() : nc('Media');
        case 'prev':         return media ? media.prev() : nc('Media');
        case 'volume_up':    return media ? media.volumeUp() : nc('Media');
        case 'volume_down':  return media ? media.volumeDown() : nc('Media');
        case 'mute':         return media ? media.mute() : nc('Media');
        case 'set_volume':   return media ? media.setVolume(intent.arg) : nc('Media');
        default:             return { ok: false, speak: "I don't know how to do that." };
      }
    }
```

- [ ] **Step 4: Run to verify pass** — `node --test orchestrator/router.test.js`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: dispatch play_music/play_pause/stop_music to the music capability"
```

---

## Task 4: retire `playOnSpotify`; wire `music` into the server

**Files:** Modify `orchestrator/pc/media.js`, `orchestrator/pc/media.test.js`, `orchestrator/server.js`.

- [ ] **Step 1: Update media tests** — in `orchestrator/pc/media.test.js`, delete the two tests `test('playOnSpotify opens xdg-open ...', ...)` and `test('playOnSpotify refuses an empty query', ...)` (lines ~63-76).

- [ ] **Step 2: Run to verify they're gone / still green** — `node --test orchestrator/pc/media.test.js`. Expected: the remaining media tests pass (the deleted ones no longer run).

- [ ] **Step 3a: Remove `playOnSpotify`** — in `orchestrator/pc/media.js`, delete the `playOnSpotify({ query } = {}) { ... }` method (the last entry in the returned object, lines ~32-37). Ensure the object before it (`setVolume`) keeps its trailing comma valid and the `}` closes cleanly.

- [ ] **Step 3b: Construct + inject music** — in `orchestrator/server.js`:

Add the import near the other pc imports (after line 12 `import { makeMedia } ...`):

```js
import { makeMusic } from './pc/music.js';
```

Add `music = null` to the `makePipeline({...})` destructured params (the line with `openApp = null, media = null, win = null, shell = null, browser = null,`):

```js
  openApp = null, media = null, win = null, shell = null, browser = null, music = null,
```

In `makePipeline`, update the `route(...)` call to pass `music`:

```js
    const { ok, speak } = await route(intent, { board: esp32, registry, openApp, media, win, browser, music });
```

In the boot section, construct it next to the others (after `const media = makeMedia();`):

```js
  const music = makeMusic();
```

Pass it into `makePipeline({ ... })` (the object that already lists `openApp, media, win: winCap, shell, browser, telemetry`):

```js
    openApp, media, win: winCap, shell, browser, music, telemetry,
```

And update the boot-level `route(...)` call (the one with `win: winCap, browser`) to include music:

```js
    const { ok, speak } = await route(intent, { board: esp32, registry, openApp, media, win: winCap, browser, music });
```

- [ ] **Step 4: Run the full Node suite** — `npm test`. Expected: all pass (no remaining `spotify_search`/`playOnSpotify` references). If any test still references them, fix that test to the new behavior.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/pc/media.js orchestrator/pc/media.test.js orchestrator/server.js
git commit -m "server: wire music capability; retire media.playOnSpotify"
```

---

## Task 5: browser search opens Chrome directly

**Files:** Modify `orchestrator/pc/browser.js`, `orchestrator/pc/browser.test.js`.

- [ ] **Step 1: Update the failing tests** — in `orchestrator/pc/browser.test.js`, replace the first test (`'search() calls xdg-open ...'`) with:

```js
test('search() launches the default browser (google-chrome) with a URL-encoded google query', () => {
  const r = recorder();
  const b = makeBrowser({ spawn: r.spawn });
  const res = b.search({ query: 'RISC-V instruction set' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'google-chrome');
  assert.equal(r.calls[0].args[0], 'https://www.google.com/search?q=RISC-V%20instruction%20set');
  assert.match(res.speak, /searching the web for risc-v instruction set/i);
});

test('search() honours a custom browserCmd', () => {
  const r = recorder();
  const b = makeBrowser({ spawn: r.spawn, browserCmd: 'firefox' });
  b.search({ query: 'cats' });
  assert.equal(r.calls[0].bin, 'firefox');
});
```

(Keep the existing `'refuses an empty query'` and `'catches spawn errors'` tests.)

- [ ] **Step 2: Run to verify it fails** — `node --test orchestrator/pc/browser.test.js`. Expected: FAIL (bin is still `xdg-open`).

- [ ] **Step 3: Implement** — replace `orchestrator/pc/browser.js` with:

```js
// PC capability: browser.search — open a Google search by launching the
// browser directly (Chrome is the default here; xdg-open proved unreliable).
// Detached + unref'd. browserCmd is overridable via BROWSER_CMD.

import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeBrowser({ spawn = _spawn, browserCmd = process.env.BROWSER_CMD || 'google-chrome' } = {}) {
  return {
    search({ query } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, speak: 'I need something to search for.' };
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(q);
      try {
        const p = spawn(browserCmd, [url], OPTS);
        p?.unref?.();
        return { ok: true, speak: `Searching the web for ${q}.` };
      } catch {
        return { ok: false, speak: `I couldn't open the browser.` };
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test orchestrator/pc/browser.test.js`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/pc/browser.js orchestrator/pc/browser.test.js
git commit -m "pc: browser.search launches Chrome directly (configurable via BROWSER_CMD)"
```

---

## Task 6: voice loop — one command per wake, silent on miss

**Files:** Modify `voice-service/main.py`, `voice-service/tests/test_main.py`.

- [ ] **Step 1: Rewrite the failing tests** — in `voice-service/tests/test_main.py`, replace the ENTIRE `class RunConversationTest(unittest.TestCase): ...` block with:

```python
class RunConversationTest(unittest.TestCase):
    def test_dispatches_one_command_then_returns(self):
        handled = []
        run_conversation(lambda: "lights on", lambda t: handled.append(t))
        self.assertEqual(handled, ["lights on"])

    def test_silence_returns_without_handling(self):
        handled = []
        run_conversation(lambda: None, handled.append)
        self.assertEqual(handled, [])

    def test_not_understood_returns_silently_no_retry(self):
        calls = {"n": 0}
        def listen():
            calls["n"] += 1
            return ""
        handled, spoken = [], []
        run_conversation(listen, handled.append)
        self.assertEqual(handled, [])
        self.assertEqual(calls["n"], 1)  # exactly one attempt — no retry loop

    def test_stop_sentinel_returns_without_handling(self):
        handled = []
        run_conversation(lambda: STOP, handled.append)
        self.assertEqual(handled, [])
```

(Keep the existing `from main import handle_text, run_conversation`, `from orchestrator import CommandResult`, and `from stt import STOP` imports. If `STOP` isn't imported at the top of the file, add `from stt import STOP`.)

- [ ] **Step 2: Run to verify it fails** — `.venv/bin/python voice-service/tests/test_main.py -v`. Expected: FAIL (old `run_conversation` signature/behavior, e.g. retries).

- [ ] **Step 3a: Rewrite `run_conversation`** — in `voice-service/main.py`, replace the entire `def run_conversation(...)` function with:

```python
def run_conversation(listen_fn, handle_fn, reporter=None):
    """One command per wake. listen_fn returns:
      None  -> silence (no speech): return, re-arm the wake word.
      STOP  -> user said 'stop'/'cancel'/'never mind': return.
      ""    -> heard speech but not a command: return silently (no retry, no speak).
      str   -> a command: dispatch via handle_fn, then return.
    After any single outcome the loop re-arms the wake word — it does NOT keep
    listening for follow-ups."""
    if reporter is not None:
        reporter.emit("recording")
    text = listen_fn()
    if not isinstance(text, str) or not text:
        return  # None / STOP / "" -> sleep silently until the next wake word
    if reporter is not None:
        reporter.emit("transcript", text=text)
    handle_fn(text)
```

- [ ] **Step 3b: Simplify the `run_loop` call site** — in `voice-service/main.py` `run_loop`, replace the `if hasattr(stt, "listen"):` branch's `run_conversation(...)` call with:

```python
        if hasattr(stt, "listen"):
            run_conversation(
                listen_fn=lambda: stt.listen(
                    config.followup_seconds, config.max_utterance_seconds,
                    on_transcribing=lambda: reporter.emit("transcribing"),
                ),
                handle_fn=lambda t: handle_text(t, client, speaker),
                reporter=reporter,
            )
```

(The `unrecognized_fn`, `cancel_fn`, and `max_unrecognized` arguments are gone. The surrounding `reporter.emit("awake")` before and `reporter.emit("idle")` + cooldown after stay unchanged.)

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python voice-service/tests/test_main.py -v`. Expected: all pass. (Note: `stt.listen` gaining `on_transcribing` is Task 7; `run_loop` isn't unit-tested, so this is fine now.)

- [ ] **Step 5: Commit**

```bash
git add voice-service/main.py voice-service/tests/test_main.py
git commit -m "voice: one command per wake, silent on miss (drop retry/follow-up loop)"
```

---

## Task 7: responsive `on_transcribing` hook + snappier VAD

**Files:** Modify `voice-service/stt.py`, `voice-service/config.py`, `voice-service/tests/test_whisper.py`, `voice-service/tests/test_config.py`.

- [ ] **Step 1: Add the failing tests** — append to `voice-service/tests/test_whisper.py` (above the `if __name__` block, reusing the existing `Seg`, `FakeConfig`, `FakeModel`, `make_stt` helpers):

```python
class OnTranscribingTest(unittest.TestCase):
    def test_fires_once_after_capture_for_a_command(self):
        fired = []
        stt = make_stt([Seg(" lights on")], pcm=b"\x00" * 960)
        stt.listen(5.0, 12.0, on_transcribing=lambda: fired.append(1))
        self.assertEqual(fired, [1])

    def test_not_fired_on_silence(self):
        fired = []
        stt = make_stt([], pcm=None)
        stt.listen(5.0, 12.0, on_transcribing=lambda: fired.append(1))
        self.assertEqual(fired, [])
```

And update `voice-service/tests/test_config.py`: change the default assertion `self.assertEqual(c.vad_silence_ms, 800)` to `self.assertEqual(c.vad_silence_ms, 600)`. (Leave the override test's `"VOICE_VAD_SILENCE_MS": "500"` / `500` assertion as-is.)

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python voice-service/tests/test_whisper.py -v` (FAIL: `listen()` takes no `on_transcribing`) and `.venv/bin/python voice-service/tests/test_config.py -v` (FAIL: default is 800).

- [ ] **Step 3a: Add the hook to `WhisperSTT.listen`** — in `voice-service/stt.py`, change the signature and fire the callback right after a non-empty capture:

```python
    def listen(self, max_initial_silence=5.0, max_utterance=12.0, on_transcribing=None):
        pcm = self.recorder(max_initial_silence, max_utterance)
        if not pcm:
            _debug("silence (no speech)")
            return None
        if on_transcribing is not None:
            on_transcribing()
```

(The rest of `listen` — temp wav, transcribe, guard, STOP/normalize — is unchanged below this point.)

- [ ] **Step 3b: Accept-and-ignore the hook on `VoskSTT.listen`** — so the shared call site works for either backend. Change the `VoskSTT.listen` signature only:

```python
    def listen(self, max_initial_silence=5.0, max_utterance=12.0, on_transcribing=None):
```

(Do not otherwise change VoskSTT; `on_transcribing` is intentionally unused there.)

- [ ] **Step 3c: Snappier default** — in `voice-service/config.py`, change the `vad_silence_ms` field default `800` → `600`, and its `load_config` read default `env.get("VOICE_VAD_SILENCE_MS", "800")` → `env.get("VOICE_VAD_SILENCE_MS", "600")`.

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python voice-service/tests/test_whisper.py -v` (all pass, incl. 2 new) and `.venv/bin/python voice-service/tests/test_config.py -v` (pass).

- [ ] **Step 5: Commit**

```bash
git add voice-service/stt.py voice-service/config.py voice-service/tests/test_whisper.py voice-service/tests/test_config.py
git commit -m "voice: on_transcribing hook (recording->thinking) + vad_silence_ms 600"
```

---

## Task 8: install players, full-suite green, e2e, finish

**Files:** none code (verification); may touch `CHECKPOINT.md`.

- [ ] **Step 1: Full Node + Python suites**

```bash
npm test
( cd voice-service/tests && ../../.venv/bin/python -m unittest discover -s . -p 'test_*.py' )
```
Expected: Node all pass; Python all pass.

- [ ] **Step 2: Install the players (host action — needs sudo; the user may run this)**

```bash
sudo apt install -y mpv yt-dlp
```
Verify: `command -v mpv && command -v yt-dlp`. (If `yt-dlp` isn't in apt on this release, `sudo wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp`.)

- [ ] **Step 3: Smoke-test mpv playback (no voice)** — confirm the player path works end to end:

```bash
mpv --no-video --no-terminal --input-ipc-server=/tmp/jarvis-mpv.sock "ytdl://ytsearch1:rick astley never gonna give you up" &
sleep 8
echo '{ "command": ["cycle", "pause"] }' | socat - /tmp/jarvis-mpv.sock   # or: pause check
echo '{ "command": ["quit"] }' | socat - /tmp/jarvis-mpv.sock 2>/dev/null || pkill mpv
```
Expected: audio plays for ~8s. (If `socat` is absent, the orchestrator's `node:net` path still works; this is just a manual probe — `pkill mpv` to stop.)

- [ ] **Step 4: End-to-end (mic + orchestrator running)** — `npm start` + `voice-service/run-full.sh`, then:
  1. "hey jarvis, play \<song\>" → audio plays. "hey jarvis, pause" toggles it. "hey jarvis, stop music" stops it.
  2. "hey jarvis, search for \<topic\>" → a Chrome window opens.
  3. Give one command → it acts, then goes quiet (no follow-up). Give none/mumble → quiet, no "didn't catch that".
  4. Watch the dashboard: `LISTENING` while you speak, flips to `THINKING` when you stop, then `RESPONDING`.

- [ ] **Step 5: Update CHECKPOINT.md** — add a dated TL;DR bullet: music now plays via mpv+yt-dlp (no account; `playerctl`/`pactl` still absent so generic transport/volume remain out of scope); browser search launches Chrome directly; voice loop is one-command-per-wake (silent on miss) with a `transcribing` event driving the dashboard THINKING state. Commit:

```bash
git add CHECKPOINT.md && git commit -m "checkpoint: mpv music, Chrome search, one-shot voice loop"
```

- [ ] **Step 6: Finish the branch** — use the superpowers:finishing-a-development-branch skill to merge `voice-ux-media-fixes` into `main`.
