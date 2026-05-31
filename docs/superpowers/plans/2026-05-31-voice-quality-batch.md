# Voice Quality Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower the wake threshold, play real songs in Chrome via YouTube (pause/stop via playerctl), keep music phrasings local, and execute compound "do X and then Y" commands.

**Architecture:** Python config tweak; `pc/music.js` rewritten (yt-dlp resolve → open YouTube watch URL in Chrome; playerctl for transport); `pc.js` play matcher widened; new `intent/split.js` + `parseLocal` export; the server pipeline runs compound utterances clause-by-clause.

**Tech Stack:** Node ESM `node:test`, `node:child_process` (execFile/spawn), Python `unittest`.

**Spec:** `docs/superpowers/specs/2026-05-31-voice-quality-batch-design.md`
**Branch:** `voice-quality-batch` (already created).

**Test commands:** Node: `npm test` / `node --test <file>`. Python: `.venv/bin/python voice-service/tests/test_config.py -v`.

---

## File Structure
- `voice-service/config.py` (modify), `voice-service/run-full.sh` (modify), `.env.example` (modify), `voice-service/tests/test_config.py` (modify) — wake threshold.
- `orchestrator/intent/pc.js` (modify), `orchestrator/intent/pc.test.js` (modify) — music phrasings.
- `orchestrator/pc/music.js` (rewrite), `orchestrator/pc/music.test.js` (rewrite) — YouTube/Chrome + playerctl.
- `orchestrator/server.js` (modify) — inject `hasPlayerctl`; compound pipeline.
- `orchestrator/intent/split.js` (create), `orchestrator/intent/split.test.js` (create) — utterance splitter.
- `orchestrator/intent/index.js` (modify), `orchestrator/intent/index.test.js` (modify) — `parseLocal`.
- `orchestrator/server.test.js` (modify) — compound pipeline test.

---

## Task 1: Lower the wake threshold to 0.35

**Files:** `voice-service/config.py`, `voice-service/run-full.sh`, `.env.example`, `voice-service/tests/test_config.py`.

- [ ] **Step 1: Failing test** — in `voice-service/tests/test_config.py`, inside `test_whisper_vad_defaults` (the `load_config(env={})` test), add:
```python
        self.assertEqual(c.wake_threshold, 0.35)
```

- [ ] **Step 2: Run** — `.venv/bin/python voice-service/tests/test_config.py -v`. FAIL (default is 0.5).

- [ ] **Step 3: Implement**
- `voice-service/config.py`: change the dataclass field `wake_threshold: float = 0.5` → `0.35`, and the `load_config` read `wake_threshold=float(env.get("VOICE_WAKE_THRESHOLD", "0.5"))` → `"0.35"`.
- `voice-service/run-full.sh`: add an export (near the other `VOICE_*` exports):
```bash
export VOICE_WAKE_THRESHOLD="${VOICE_WAKE_THRESHOLD:-0.35}"
```
- `.env.example`: change `VOICE_WAKE_THRESHOLD=0.5` → `VOICE_WAKE_THRESHOLD=0.35`.

- [ ] **Step 4: Run** — `.venv/bin/python voice-service/tests/test_config.py -v`. PASS. And `bash -n voice-service/run-full.sh`.

- [ ] **Step 5: Commit**
```bash
git add voice-service/config.py voice-service/run-full.sh .env.example voice-service/tests/test_config.py
git commit -m "voice: lower wake threshold default 0.5 -> 0.35"
```

---

## Task 2: Keep music phrasings local

**Files:** `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/intent/pc.test.js`, in the play section, add:
```js
test('natural music phrasings stay local as play_music', () => {
  assert.deepEqual(matchPcCommand('put on daft punk'),
    { domain:'pc', action:'media', op:'play_music', arg:'daft punk' });
  assert.deepEqual(matchPcCommand('play me some jazz'),
    { domain:'pc', action:'media', op:'play_music', arg:'some jazz' });
  assert.deepEqual(matchPcCommand('i want to hear queen'),
    { domain:'pc', action:'media', op:'play_music', arg:'queen' });
});

test('"play" / "play music" still toggle (play_pause)', () => {
  assert.deepEqual(matchPcCommand('play'),       { domain:'pc', action:'media', op:'play_pause' });
  assert.deepEqual(matchPcCommand('play music'), { domain:'pc', action:'media', op:'play_pause' });
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/pc.test.js`. FAIL ("put on"/"play me"/"i want to hear" not matched).

- [ ] **Step 3: Implement** — in `orchestrator/intent/pc.js`, replace the `play <query>` block:
```js
  // play <query> -> music.play (excludes literal "music" so play_pause keeps winning above)
  const playQ = norm.match(/^play\s+(?!music$)(.+)$/);
  if (playQ) {
    return { domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() };
  }
```
with:
```js
  // play / put on / play me / i want to hear <query> -> music.play
  // (the bare "play"/"play music"/"pause" cases are caught by MEDIA_FIXED above as play_pause)
  const playQ = norm.match(/^(?:play(?:\s+me)?|put\s+on|i\s+want\s+to\s+hear)\s+(?!music$)(.+)$/);
  if (playQ) {
    return { domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() };
  }
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/pc.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent: 'put on' / 'play me' / 'i want to hear' stay local as play_music"
```

---

## Task 3: Rewrite `music.js` — YouTube in Chrome + playerctl

**Files:** `orchestrator/pc/music.js` (rewrite), `orchestrator/pc/music.test.js` (rewrite).

- [ ] **Step 1: Rewrite the test** — replace the ENTIRE contents of `orchestrator/pc/music.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMusic } from './music.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args) => { calls.push({ bin, args }); return proc; };
  return { calls, spawn };
}

test('play resolves the top result and opens the YouTube watch page in the browser', async () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, resolve: async () => 'abc123', browserCmd: 'google-chrome' });
  const res = await m.play({ query: 'daft punk one more time' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'google-chrome');
  assert.equal(r.calls[0].args[0], 'https://www.youtube.com/watch?v=abc123');
  assert.match(res.speak, /playing daft punk one more time/i);
});

test('play falls back to a YouTube search page when resolve yields nothing', async () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, resolve: async () => null, browserCmd: 'google-chrome' });
  const res = await m.play({ query: 'obscure thing' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].args[0], 'https://www.youtube.com/results?search_query=obscure%20thing');
});

test('play refuses an empty query (and does not resolve)', async () => {
  let resolved = false;
  const m = makeMusic({ spawn: rec().spawn, resolve: async () => { resolved = true; return 'x'; } });
  assert.equal((await m.play({ query: '  ' })).ok, false);
  assert.equal(resolved, false);
});

test('pause/stop drive playerctl when available', () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, hasPlayerctl: true });
  assert.equal(m.pauseResume().ok, true);
  assert.deepEqual(r.calls[0], { bin: 'playerctl', args: ['play-pause'] });
  assert.equal(m.stop().ok, true);
  assert.deepEqual(r.calls[1], { bin: 'playerctl', args: ['stop'] });
});

test('pause/stop degrade gracefully without playerctl', () => {
  const m = makeMusic({ spawn: rec().spawn, hasPlayerctl: false });
  const r = m.pauseResume();
  assert.equal(r.ok, false);
  assert.match(r.speak, /playerctl/i);
  assert.equal(m.stop().ok, false);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/pc/music.test.js`. FAIL (old mpv API).

- [ ] **Step 3: Rewrite** — replace the ENTIRE contents of `orchestrator/pc/music.js`:
```js
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
```

- [ ] **Step 4: Run** — `node --test orchestrator/pc/music.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/pc/music.js orchestrator/pc/music.test.js
git commit -m "pc: music opens the real song's YouTube page in Chrome; playerctl transport"
```

---

## Task 4: Server — detect playerctl and inject `hasPlayerctl`

**Files:** `orchestrator/server.js`.

- [ ] **Step 1: Implement** — in `orchestrator/server.js`:
(a) Ensure `execFileSync` is imported from `node:child_process` (add it to the existing import if not present):
```js
import { execFileSync } from 'node:child_process';
```
(b) In the boot section, just before `const music = makeMusic();`, detect playerctl and pass it:
```js
  let hasPlayerctl = false;
  try { execFileSync('which', ['playerctl'], { stdio: 'ignore' }); hasPlayerctl = true; } catch { hasPlayerctl = false; }
  const music = makeMusic({ hasPlayerctl });
```

- [ ] **Step 2: Run** — `npm test`. All pass (music.play is async; the router already `await`s route, which returns the play promise — no change needed there). Confirm the server still boots: `node -e "import('./orchestrator/server.js').then(()=>console.log('import ok'))"`.

- [ ] **Step 3: Commit**
```bash
git add orchestrator/server.js
git commit -m "server: detect playerctl at boot and wire it into the music capability"
```

---

## Task 5: `intent/split.js` — utterance splitter

**Files:** Create `orchestrator/intent/split.js`, `orchestrator/intent/split.test.js`.

- [ ] **Step 1: Failing test** — create `orchestrator/intent/split.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUtterance } from './split.js';

test('splits on sequencing connectors', () => {
  assert.deepEqual(splitUtterance('turn off the light and then play music'), ['turn off the light', 'play music']);
  assert.deepEqual(splitUtterance('open chrome then play jazz'), ['open chrome', 'play jazz']);
  assert.deepEqual(splitUtterance('turn on the fan and turn off the light'), ['turn on the fan', 'turn off the light']);
  assert.deepEqual(splitUtterance('a and then b then c'), ['a', 'b', 'c']);
});

test('a plain command stays a single piece', () => {
  assert.deepEqual(splitUtterance('turn off the tubelight'), ['turn off the tubelight']);
  assert.deepEqual(splitUtterance(''), []);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/split.test.js`. FAIL (no `./split.js`).

- [ ] **Step 3: Implement** — create `orchestrator/intent/split.js`:
```js
// Splits a spoken utterance into ordered clauses on explicit sequencers.
// "and then" / "after that" / "then" / "and". Longer connectors first so
// "and then" wins over a bare "and". Whether multiple clauses are actually
// treated as a compound command is decided by the caller (it requires every
// clause to independently parse as a local command).
export function splitUtterance(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  return s
    .split(/\s+(?:and then|after that|then|and)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/split.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/split.js orchestrator/intent/split.test.js
git commit -m "intent: split.js — split an utterance into sequenced clauses"
```

---

## Task 6: `parseLocal` export in `intent/index.js`

**Files:** `orchestrator/intent/index.js`, `orchestrator/intent/index.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/intent/index.test.js`, add:
```js
test('parseLocal resolves local intents without calling Gemini', async () => {
  const vocab = { deviceNames: ['tubelight'], groupNames: ['lights'] };
  assert.deepEqual(parseLocal('turn off the tubelight', vocab), { domain: 'switch', action: 'off', target: 'tubelight' });
  assert.deepEqual(parseLocal('find out about mars', vocab), { domain: 'ask', query: 'mars' });
  assert.equal(parseLocal('hmm something vague', vocab), null);
});
```
(Add `parseLocal` to the import from `./index.js` at the top of the test file.)

- [ ] **Step 2: Run** — `node --test orchestrator/intent/index.test.js`. FAIL (no `parseLocal`).

- [ ] **Step 3: Implement** — in `orchestrator/intent/index.js`, add an exported `parseLocal` (the cascade minus Gemini):
```js
// The offline cascade only (switch -> pc -> ask -> confirm), no Gemini. Used
// for compound-command splitting where we don't want a Gemini call per clause.
export function parseLocal(text, vocab) {
  return (
    matchSwitchCommand(text, vocab) ||
    matchPcCommand(text) ||
    matchAsk(text) ||
    matchConfirm(text) ||
    null
  );
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/index.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "intent: export parseLocal (offline cascade, no Gemini)"
```

---

## Task 7: Compound execution in the pipeline

**Files:** `orchestrator/server.js`, `orchestrator/server.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/server.test.js`, add a compound test. `makePipeline` will gain injectable `splitUtterance` + `parseLocal` (defaulting to the real ones); inject them here to keep the test self-contained, with a `route` that records intents:
```js
test('pipeline: a compound utterance routes each clause in order', async () => {
  const routed = [];
  const route = async (intent) => { routed.push(intent); return { ok: true, speak: `did ${intent.action}` }; };
  const splitUtterance = (t) => t.split(' AND ');
  const parseLocal = (clause) => (
    clause === 'off' ? { domain: 'switch', action: 'off', target: 'tubelight' } :
    clause === 'play' ? { domain: 'pc', action: 'media', op: 'play_music', arg: 'x' } : null
  );
  const p = makePipeline({ parse: async () => ({ intent: null, via: null }), vocab: {}, route, splitUtterance, parseLocal });
  const r = await p.onCommand('off AND play');
  assert.equal(routed.length, 2);
  assert.deepEqual(routed.map((i) => i.action), ['off', 'media']);
  assert.equal(r.ok, true);
  assert.match(r.speak, /did off/);
  assert.match(r.speak, /did media/);
});

test('pipeline: not-all-clauses-parse falls back to single-command handling', async () => {
  let singleParsed = false;
  const route = async () => ({ ok: true, speak: 'single' });
  const splitUtterance = (t) => t.split(' AND ');
  const parseLocal = (clause) => (clause === 'off' ? { domain: 'switch', action: 'off', target: 'tubelight' } : null);
  const parse = async () => { singleParsed = true; return { intent: { domain: 'switch', action: 'off', target: 'tubelight' }, via: 'rules' }; };
  const p = makePipeline({ parse, vocab: {}, route, splitUtterance, parseLocal });
  const r = await p.onCommand('off AND gibberish');
  assert.equal(singleParsed, true);   // fell through to the single-command parse
  assert.equal(r.speak, 'single');
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/server.test.js`. FAIL (no compound handling).

- [ ] **Step 3: Implement** — in `orchestrator/server.js`:
(a) Add imports at the top (near the other intent imports):
```js
import { parseLocal as _parseLocal } from './intent/index.js';
import { splitUtterance as _splitUtterance } from './intent/split.js';
```
(b) Add to the `makePipeline({...})` destructure params (with defaults so production uses the real ones):
```js
  splitUtterance = _splitUtterance, parseLocal = _parseLocal,
```
(c) Factor the route deps into a single object inside `makePipeline` (so compound and single share it). Where the existing `route(intent, { board: esp32, registry, openApp, media, win, browser, music, knowledge, persona })` call is, introduce just above `onCommand`:
```js
  const routeDeps = { board: esp32, registry, openApp, media, win, browser, music, knowledge, persona };
```
and change the existing single-command route call to `await route(intent, routeDeps)`.
(d) At the TOP of `onCommand(text)` (before the `parse` call), add the compound branch:
```js
    const clauses = splitUtterance(text);
    if (clauses.length > 1 && clauses.length <= 5) {
      const intents = clauses.map((c) => parseLocal(c, vocab));
      const compound = intents.every(
        (i) => i && i.domain !== 'confirm' && !(i.domain === 'pc' && i.action === 'shell'),
      );
      if (compound) {
        if (pending) pending = null;
        const speaks = [];
        for (let k = 0; k < clauses.length; k++) {
          const { ok, speak } = await route(intents[k], routeDeps);
          log(clauses[k], intents[k], 'rules', ok, speak);
          speaks.push(speak);
        }
        return { ok: true, speak: speaks.join(' '), intent: { domain: 'compound', count: clauses.length }, via: 'rules' };
      }
    }
```
(Leave the rest of `onCommand` — the confirm/shell/single-route flow — unchanged below this block.)

- [ ] **Step 4: Run** — `node --test orchestrator/server.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "server: execute compound 'X and then Y' utterances clause-by-clause"
```

---

## Task 8: Full suite, checkpoint, finish

**Files:** none code (verification); `CHECKPOINT.md`.

- [ ] **Step 1: Full suites** — `npm test` (all pass) and `( cd voice-service/tests && ../../.venv/bin/python -m unittest discover -s . -p 'test_*.py' )` (all pass).

- [ ] **Step 2: Update CHECKPOINT.md** — dated bullet: wake threshold 0.35; music now opens the real song's YouTube page in Chrome (yt-dlp resolve) with pause/stop via playerctl (needs `sudo apt install -y playerctl`); "put on"/"play me"/"i want to hear" stay local; compound "X and then Y" runs each clause in order (local-only, shell/confirm clauses excluded). Note Wayland window control is the next cycle. Commit:
```bash
git add CHECKPOINT.md && git commit -m "checkpoint: wake threshold, music->YouTube, compound commands"
```

- [ ] **Step 3: Finish the branch** — use superpowers:finishing-a-development-branch to merge `voice-quality-batch` into `main`.

- [ ] **Step 4: Hand off live e2e** (needs the user, restart + optional `sudo apt install -y playerctl`): wake fires more easily; "play \<song\>" opens the song in Chrome; "pause"/"stop music" (with playerctl) control it; "put on \<song\>" instant; "turn off the tubelight and then play \<song\>" does both.
