# JARVIS Voice Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the voice pipeline in the dashboard — live wake-score meter, voice state, transcript, and a command activity feed with matched layer — so silent-voice failures are debuggable.

**Architecture:** Voice service emits best-effort events to a new orchestrator `POST /voice/event`; an in-memory telemetry store buffers them and is exposed via `GET /voice` + `GET /log`; the dashboard polls and renders. Intent attribution (`via: rules/gemini`) is added via a small `parseWithSource`.

**Tech Stack:** Node 22 (ESM, Express), `node:test`; Python 3.12 venv (stdlib `urllib`/`threading`/`queue`), `unittest`; vanilla JS. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-voice-dashboard-design.md`
**Baseline:** 64 orchestrator tests + 4 voice python tests green (HEAD 2fd2170).

---

## Task 1: Telemetry store (TDD)

**Files:** Create `orchestrator/telemetry.js`, `orchestrator/telemetry.test.js`

- [ ] **Step 1: Write `orchestrator/telemetry.test.js`:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry } from './telemetry.js';

test('recordVoiceEvent maps type -> status and sets lastEventAt', () => {
  let t = 1000;
  const tel = createTelemetry(() => t);
  tel.recordVoiceEvent({ type: 'listening' });
  assert.equal(tel.voiceSnapshot().status, 'listening');
  assert.equal(tel.voiceSnapshot().lastEventAt, 1000);
  tel.recordVoiceEvent({ type: 'awake', score: 0.7 });
  assert.equal(tel.voiceSnapshot().status, 'awake');
  tel.recordVoiceEvent({ type: 'recording' });
  assert.equal(tel.voiceSnapshot().status, 'recording');
  tel.recordVoiceEvent({ type: 'transcript', text: 'turn off the tubelight' });
  const s = tel.voiceSnapshot();
  assert.equal(s.status, 'transcribing');
  assert.equal(s.lastTranscript, 'turn off the tubelight');
});

test('wake_score updates score/threshold without changing status', () => {
  const tel = createTelemetry();
  tel.recordVoiceEvent({ type: 'listening' });
  tel.recordVoiceEvent({ type: 'wake_score', score: 0.42, threshold: 0.5 });
  const s = tel.voiceSnapshot();
  assert.equal(s.status, 'listening');
  assert.equal(s.wakeScore, 0.42);
  assert.equal(s.threshold, 0.5);
});

test('voiceSnapshot reports ageMs from now', () => {
  let t = 1000;
  const tel = createTelemetry(() => t);
  tel.recordVoiceEvent({ type: 'listening' });
  t = 1750;
  assert.equal(tel.voiceSnapshot().ageMs, 750);
});

test('events and commands are newest-first and bounded to 50', () => {
  const tel = createTelemetry();
  for (let i = 0; i < 60; i++) tel.recordVoiceEvent({ type: 'wake_score', score: i / 100 });
  assert.equal(tel.voiceSnapshot().events.length, 50);
  for (let i = 0; i < 55; i++) tel.recordCommand({ text: `cmd ${i}`, ok: true });
  const cmds = tel.recentCommands();
  assert.equal(cmds.length, 50);
  assert.equal(cmds[0].text, 'cmd 54');
});

test('recordCommand stores fields + ts', () => {
  const tel = createTelemetry(() => 5000);
  tel.recordCommand({ text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' }, via: 'gemini', ok: true, speak: 'Socket is on.' });
  assert.deepEqual(tel.recentCommands()[0], {
    text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' },
    via: 'gemini', ok: true, speak: 'Socket is on.', ts: 5000,
  });
});
```

- [ ] **Step 2: Run → FAIL** — `node --test orchestrator/telemetry.test.js` (cannot find `./telemetry.js`).

- [ ] **Step 3: Create `orchestrator/telemetry.js`:**

```js
// In-memory voice + command telemetry for the dashboard. Not persisted (command_log handles audit).
const MAX = 50;

const STATUS_BY_TYPE = {
  ready: 'listening',
  listening: 'listening',
  awake: 'awake',
  recording: 'recording',
  transcript: 'transcribing',
  idle: 'idle',
};

export function createTelemetry(now = Date.now) {
  const events = [];
  const commands = [];
  const current = { status: 'idle', wakeScore: 0, threshold: 0, lastTranscript: '', lastEventAt: 0 };

  function recordVoiceEvent(event = {}) {
    const type = event.type;
    current.lastEventAt = now();
    if (type === 'wake_score') {
      if (typeof event.score === 'number') current.wakeScore = event.score;
      if (typeof event.threshold === 'number') current.threshold = event.threshold;
    } else {
      if (STATUS_BY_TYPE[type]) current.status = STATUS_BY_TYPE[type];
      if (type === 'transcript' && typeof event.text === 'string') current.lastTranscript = event.text;
    }
    events.unshift({ ...event, ts: current.lastEventAt });
    if (events.length > MAX) events.length = MAX;
  }

  function recordCommand({ text, intent = null, via = null, ok = false, speak = '' } = {}) {
    commands.unshift({ text, intent, via, ok, speak, ts: now() });
    if (commands.length > MAX) commands.length = MAX;
  }

  function voiceSnapshot() {
    const { status, wakeScore, threshold, lastTranscript, lastEventAt } = current;
    return {
      status, wakeScore, threshold, lastTranscript, lastEventAt,
      ageMs: lastEventAt ? now() - lastEventAt : null,
      events: events.slice(0, MAX),
    };
  }

  function recentCommands(n = MAX) {
    return commands.slice(0, n);
  }

  return { recordVoiceEvent, recordCommand, voiceSnapshot, recentCommands };
}
```

- [ ] **Step 4: Run → PASS** — `node --test orchestrator/telemetry.test.js` (5 tests).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/telemetry.js orchestrator/telemetry.test.js
git commit -m "Add in-memory voice/command telemetry store"
```

---

## Task 2: Orchestrator voice endpoints (TDD)

**Files:** Modify `orchestrator/server.js` (buildApp), `orchestrator/server.test.js`

- [ ] **Step 1: Append tests** to `orchestrator/server.test.js` (add `import { createTelemetry } from './telemetry.js';` near the top imports):

```js
test('POST /voice/event records into telemetry; GET /voice reflects it', async () => {
  const telemetry = createTelemetry();
  const server = buildApp({ esp32: stubEsp32({}), telemetry }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = await fetch(`${base}/voice/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'transcript', text: 'lights on' }) });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true });
    const snap = await (await fetch(`${base}/voice`)).json();
    assert.equal(snap.status, 'transcribing');
    assert.equal(snap.lastTranscript, 'lights on');
  } finally { server.close(); }
});

test('GET /log returns recent commands from telemetry', async () => {
  const telemetry = createTelemetry();
  telemetry.recordCommand({ text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' }, via: 'gemini', ok: true, speak: 'Socket is on.' });
  const server = buildApp({ esp32: stubEsp32({}), telemetry }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/log`)).json();
    assert.equal(body.commands.length, 1);
    assert.equal(body.commands[0].via, 'gemini');
  } finally { server.close(); }
});

test('voice routes tolerate missing telemetry', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/voice/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/voice`)).json(), {});
    assert.deepEqual(await (await fetch(`${base}/log`)).json(), { commands: [] });
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test orchestrator/server.test.js` (`/voice` etc. are 404).

- [ ] **Step 3: Edit `orchestrator/server.js`** — change the `buildApp` signature to include `telemetry` and add the three routes just before `return app;`:

Change `export function buildApp({ esp32, onCommand, onSwitch }) {` to:
```js
export function buildApp({ esp32, onCommand, onSwitch, telemetry }) {
```
Add before `return app;`:
```js
  // Voice telemetry: voice service reports events here; dashboard reads /voice and /log.
  app.post('/voice/event', (req, res) => {
    telemetry?.recordVoiceEvent(req.body ?? {});
    res.json({ ok: true });
  });
  app.get('/voice', (req, res) => {
    res.json(telemetry ? telemetry.voiceSnapshot() : {});
  });
  app.get('/log', (req, res) => {
    res.json({ commands: telemetry ? telemetry.recentCommands(50) : [] });
  });
```

- [ ] **Step 4: Run → PASS** — `node --test orchestrator/server.test.js` (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "Add /voice/event, /voice, /log telemetry endpoints"
```

---

## Task 3: Intent layer attribution (TDD)

**Files:** Modify `orchestrator/intent/index.js`, `orchestrator/intent/index.test.js`

- [ ] **Step 1: Edit `index.test.js`** — change the import to `import { parse, parseWithSource } from './index.js';` and append:

```js
test('parseWithSource: rules hit -> via rules', async () => {
  assert.deepEqual(await parseWithSource('turn off the tubelight', VOCAB), {
    intent: { domain: 'switch', action: 'off', target: 'tubelight' }, via: 'rules',
  });
});
test('parseWithSource: rules miss + classify hit -> via gemini', async () => {
  const spy = async () => ({ domain: 'switch', action: 'off', target: 'tubelight' });
  assert.deepEqual(await parseWithSource('lites off', VOCAB, spy), {
    intent: { domain: 'switch', action: 'off', target: 'tubelight' }, via: 'gemini',
  });
});
test('parseWithSource: rules miss + classify null -> via null', async () => {
  const noop = async () => null;
  assert.deepEqual(await parseWithSource('make me a sandwich', VOCAB, noop), { intent: null, via: null });
});
```

- [ ] **Step 2: Run → FAIL** — `node --test orchestrator/intent/index.test.js` (`parseWithSource` not exported).

- [ ] **Step 3: Replace `orchestrator/intent/index.js`:**

```js
import { matchSwitchCommand } from './rules.js';
import { geminiClassify } from './gemini.js';

// Parse + report which layer matched. Cascade: fuzzy rules (offline) -> Gemini fallback.
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return { intent: m, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}

// Intent only (back-compat).
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}
```

- [ ] **Step 4: Run → PASS** — `node --test orchestrator/intent/index.test.js` (existing 4 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/intent/index.js orchestrator/intent/index.test.js
git commit -m "Add parseWithSource to report matched intent layer (rules/gemini)"
```

---

## Task 4: Wire telemetry into main() (no unit test; full-suite gate)

**Files:** Modify `orchestrator/server.js` (`main()` only)

- [ ] **Step 1: Update imports** in `orchestrator/server.js`:
  - change `import { parse } from './intent/index.js';` to `import { parseWithSource } from './intent/index.js';`
  - add `import { createTelemetry } from './telemetry.js';`

- [ ] **Step 2: In `main()`**, create telemetry and rewrite `runIntent`/`onCommand`/`onSwitch` to record + carry `via`. Replace the existing `runIntent`/`onCommand`/`onSwitch` block with:

```js
  const telemetry = createTelemetry();

  const runIntent = async (intent, rawText, via) => {
    const { ok, speak } = await route(intent, { board: esp32, registry });
    registry.logCommand({ raw_text: rawText, intent, ok: ok ? 1 : 0, detail: speak });
    telemetry.recordCommand({ text: rawText, intent, via, ok, speak });
    return { ok, speak, intent, via };
  };

  const onCommand = async (text) => {
    const { intent, via } = await parseWithSource(text, vocab);
    if (!intent) {
      registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
      telemetry.recordCommand({ text, intent: null, via: null, ok: false, speak: "Sorry, I didn't catch that." });
      return { ok: false, speak: "Sorry, I didn't catch that.", intent: null, via: null };
    }
    return runIntent(intent, text, via);
  };

  const onSwitch = async ({ target, action } = {}) => {
    let intent;
    if (action === 'all_off') intent = { domain: 'switch', action: 'all_off' };
    else if ((action === 'on' || action === 'off') && knownTargets.has(target)) {
      intent = { domain: 'switch', action, target };
    } else {
      return { ok: false, speak: "I don't know how to do that.", intent: null, via: 'ui' };
    }
    return runIntent(intent, `[ui] ${action}${target ? ' ' + target : ''}`, 'ui');
  };
```

- [ ] **Step 3: Pass telemetry into buildApp** — change the `buildApp({ esp32, onCommand, onSwitch }).listen(...)` call in `main()` to `buildApp({ esp32, onCommand, onSwitch, telemetry }).listen(...)`.

- [ ] **Step 4: Full suite** — `npm test`
Expected: PASS — 75 tests (64 baseline + 5 telemetry + 3 server + 3 index), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/server.js
git commit -m "Wire telemetry + via into the command pipeline"
```

---

## Task 5: Voice event reporter (TDD, Python)

**Files:** Create `voice-service/reporter.py`, `voice-service/tests/test_reporter.py`

- [ ] **Step 1: Write `voice-service/tests/test_reporter.py`:**

```python
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reporter import EventReporter, NullReporter


class FakeResp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b""


class ReporterTest(unittest.TestCase):
    def test_emit_posts_to_voice_event(self):
        posted = []

        def opener(req, timeout=None):
            posted.append((req.full_url, json.loads(req.data)))
            return FakeResp()

        r = EventReporter("http://x:3000", opener=opener)
        r.emit("wake_score", score=0.42, threshold=0.5)
        r._queue.join()
        self.assertEqual(posted[0][0], "http://x:3000/voice/event")
        self.assertEqual(posted[0][1], {"type": "wake_score", "score": 0.42, "threshold": 0.5})

    def test_emit_swallows_opener_errors(self):
        def bad_opener(req, timeout=None):
            raise OSError("network down")

        r = EventReporter("http://x:3000", opener=bad_opener)
        r.emit("ready")
        r._queue.join()  # must not raise

    def test_null_reporter_is_noop(self):
        self.assertIsNone(NullReporter().emit("ready", x=1))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (cannot import `reporter`).

- [ ] **Step 3: Create `voice-service/reporter.py`:**

```python
import json
import queue
import threading
from urllib.request import Request, urlopen


class NullReporter:
    def emit(self, event_type, **data):
        return None


class EventReporter:
    """Best-effort telemetry: enqueue events; a daemon thread POSTs them. Never blocks or raises."""

    def __init__(self, orchestrator_url, timeout_s=1.0, opener=urlopen, max_queue=64):
        self.url = orchestrator_url.rstrip("/") + "/voice/event"
        self.timeout_s = timeout_s
        self._opener = opener
        self._queue = queue.Queue(maxsize=max_queue)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def emit(self, event_type, **data):
        try:
            self._queue.put_nowait({"type": event_type, **data})
        except queue.Full:
            pass  # drop telemetry rather than block audio capture

    def _run(self):
        while True:
            payload = self._queue.get()
            try:
                body = json.dumps(payload).encode("utf-8")
                req = Request(self.url, data=body, headers={"content-type": "application/json"}, method="POST")
                with self._opener(req, timeout=self.timeout_s) as res:
                    res.read()
            except Exception:
                pass  # best-effort; never crash the voice loop
            finally:
                self._queue.task_done()


def build_reporter(config):
    if getattr(config, "wake_backend", "manual") != "manual":
        return EventReporter(config.orchestrator_url)
    return NullReporter()
```

- [ ] **Step 4: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (existing 4 + 3 new = 7).

- [ ] **Step 5: Commit**

```bash
git add voice-service/reporter.py voice-service/tests/test_reporter.py
git commit -m "Add best-effort voice EventReporter (daemon thread, swallows errors)"
```

---

## Task 6: Instrument the voice loop & wake listener

**Files:** Modify `voice-service/main.py`, `voice-service/wakeword.py`, and (if needed) `voice-service/tests/test_main.py`

- [ ] **Step 1: Edit `voice-service/wakeword.py`** — give `OpenWakeWordListener` a `reporter` and emit throttled scores. Replace the class + `build_wake_listener`:

```python
import subprocess
import time
from importlib import resources


class ManualWakeListener:
    """Placeholder wake listener: every entered line is treated as after wake word."""

    def wait(self):
        return True


class OpenWakeWordListener:
    def __init__(self, model_path=None, threshold=0.5, sample_rate=16000, reporter=None):
        import numpy as np
        from openwakeword.model import Model

        self.np = np
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.reporter = reporter
        self._last_emit = 0.0
        if model_path is None:
            model_path = str(
                resources.files("openwakeword") / "resources" / "models" / "hey_jarvis_v0.1.onnx"
            )
        kwargs = {"wakeword_model_paths": [model_path]} if model_path else {}
        self.model = Model(**kwargs)

    def wait(self):
        chunk_bytes = 1280 * 2
        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        try:
            while True:
                raw = proc.stdout.read(chunk_bytes)
                if len(raw) < chunk_bytes:
                    return False
                audio = self.np.frombuffer(raw, dtype=self.np.int16)
                scores = self.model.predict(audio)
                top = max(scores.values()) if scores else 0.0
                now = time.monotonic()
                if self.reporter is not None and now - self._last_emit >= 0.33:
                    self._last_emit = now
                    self.reporter.emit("wake_score", score=float(top), threshold=self.threshold)
                if top >= self.threshold:
                    if self.reporter is not None:
                        self.reporter.emit("awake", score=float(top))
                    return True
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()


def build_wake_listener(config, reporter=None):
    if config.wake_backend == "openwakeword":
        return OpenWakeWordListener(
            model_path=config.wake_model_path or None,
            threshold=config.wake_threshold,
            sample_rate=config.sample_rate,
            reporter=reporter,
        )
    return ManualWakeListener()
```

- [ ] **Step 2: Edit `voice-service/main.py`** — import the reporter and emit lifecycle events. Replace `run_loop`:

```python
from reporter import build_reporter
```
(add to the imports at the top), and replace `run_loop` with:

```python
def run_loop(config, client=None, stt=None, wake_listener=None, speaker=None, reporter=None):
    client = client or OrchestratorClient(config.orchestrator_url, config.request_timeout_s)
    reporter = reporter or build_reporter(config)
    stt = stt or build_stt(config)
    wake_listener = wake_listener or build_wake_listener(config, reporter)
    speaker = speaker or build_tts(config)

    reporter.emit("ready")
    if config.wake_backend == "manual":
        print(f"JARVIS voice service ready. Type commands after '{config.wake_word}', Ctrl-D to exit.")
    else:
        print("JARVIS voice service ready. Say 'hey jarvis', then speak the command during the recording window.")
    while True:
        reporter.emit("listening")
        if not wake_listener.wait():
            continue
        reporter.emit("recording")
        text = stt.transcribe()
        if not text:
            break
        reporter.emit("transcript", text=text)
        handle_text(text, client, speaker)
        reporter.emit("idle")
```

- [ ] **Step 3: Keep voice tests green.** Run `python3 -m unittest discover -s voice-service/tests`. If `test_main.py`'s `run_loop` test breaks because it passes no `reporter` and its config uses a non-manual `wake_backend` (which would try real network), open `voice-service/tests/test_main.py` and pass `reporter=NullReporter()` (import `from reporter import NullReporter`) into the `run_loop(...)` call. Re-run until green (7 tests).

- [ ] **Step 4: Commit**

```bash
git add voice-service/main.py voice-service/wakeword.py voice-service/tests/test_main.py
git commit -m "Emit voice telemetry: lifecycle events + throttled wake score"
```

---

## Task 7: Dashboard — Voice panel, activity feed, health dots

**Files:** Modify `orchestrator/public/index.html` (full replacement)

- [ ] **Step 1: Replace `orchestrator/public/index.html` with:**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JARVIS</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background:#111; color:#eee; }
  header { display:flex; align-items:center; gap:1rem; padding:1rem 1.25rem; border-bottom:1px solid #333; flex-wrap:wrap; }
  header h1 { font-size:1.2rem; margin:0; letter-spacing:.18em; }
  .dots { display:flex; gap:1rem; margin-left:auto; font-size:.8rem; color:#888; }
  .dots span { display:flex; align-items:center; gap:.35rem; }
  .dot { width:.7rem; height:.7rem; border-radius:50%; background:#666; display:inline-block; }
  .dot.ok { background:#3fb950; }
  .dot.bad { background:#f85149; }
  main { padding:1.25rem; max-width:820px; margin:0 auto; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.12em; color:#888; margin:1.5rem 0 .6rem; border-top:1px solid #2a2a2a; padding-top:1rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:.7rem; }
  .tile { padding:.9rem; border:1px solid #333; border-radius:.6rem; background:#1b1b1b; cursor:pointer; text-align:left; color:#eee; font:inherit; }
  .tile:hover { border-color:#555; }
  .tile .name { display:block; font-weight:600; text-transform:capitalize; }
  .tile .st { font-size:.85rem; color:#888; }
  .tile.on { background:#16301c; border-color:#2ea043; }
  .tile.on .st { color:#3fb950; }
  .row { display:flex; flex-wrap:wrap; gap:.5rem; margin:1rem 0; }
  button.act { padding:.5rem .8rem; border:1px solid #333; border-radius:.5rem; background:#1b1b1b; color:#eee; cursor:pointer; font:inherit; }
  button.act:hover { border-color:#555; }
  .cmd { display:flex; gap:.5rem; margin-top:1rem; }
  .cmd input { flex:1; padding:.55rem .7rem; border:1px solid #333; border-radius:.5rem; background:#1b1b1b; color:#eee; font:inherit; }
  .say { margin-top:1rem; min-height:1.4em; color:#9ecbff; }
  body.offline .grid { opacity:.45; pointer-events:none; }
  .vstate { display:flex; align-items:center; gap:.6rem; }
  .badge { padding:.15rem .6rem; border-radius:1rem; background:#1b1b1b; border:1px solid #333; font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; }
  .badge.listening { background:#10243a; border-color:#1f6feb; color:#79c0ff; }
  .badge.awake, .badge.recording, .badge.transcribing { background:#3a2d10; border-color:#9e6a00; color:#f0c674; }
  .meter { position:relative; flex:1; height:1.2rem; background:#1b1b1b; border:1px solid #333; border-radius:.4rem; overflow:hidden; min-width:180px; }
  .meter .fill { height:100%; background:#3fb950; width:0%; transition:width .15s linear; }
  .meter .thr { position:absolute; top:0; bottom:0; width:2px; background:#f0c674; }
  .meter .num { position:absolute; right:.4rem; top:0; line-height:1.2rem; font-size:.7rem; color:#ddd; }
  .heard { margin-top:.6rem; color:#9ecbff; min-height:1.3em; }
  .feed { font-size:.85rem; }
  .feed .item { display:flex; gap:.7rem; padding:.35rem 0; border-bottom:1px solid #222; }
  .feed .item.bad .meta { color:#f0a0a0; }
  .feed time { color:#666; white-space:nowrap; }
  .feed .meta { color:#9aa; }
</style>
</head>
<body>
<header>
  <h1>JARVIS</h1>
  <div class="dots">
    <span><i id="dot-orch" class="dot"></i>orch</span>
    <span><i id="dot-board" class="dot"></i>board</span>
    <span><i id="dot-voice" class="dot"></i>voice</span>
  </div>
</header>
<main>
  <div id="tiles" class="grid"></div>
  <div class="row">
    <button class="act" onclick="sw('lights','on')">Lights On</button>
    <button class="act" onclick="sw('lights','off')">Lights Off</button>
    <button class="act" onclick="sw('fans','on')">Fans On</button>
    <button class="act" onclick="sw('fans','off')">Fans Off</button>
    <button class="act" onclick="allOff()">All Off</button>
  </div>
  <form class="cmd" onsubmit="return runCmd(event)">
    <input id="cmd" placeholder="turn off the tubelight" autocomplete="off" />
    <button class="act" type="submit">Send</button>
  </form>
  <div id="say" class="say"></div>

  <h2>Voice</h2>
  <div class="vstate">
    <span id="vbadge" class="badge">idle</span>
    <div class="meter"><div id="wfill" class="fill"></div><div id="wthr" class="thr"></div><span id="wnum" class="num">0.00</span></div>
  </div>
  <div id="heard" class="heard"></div>

  <h2>Activity</h2>
  <div id="feed" class="feed"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const setDot = (id, ok) => { $(id).className = 'dot ' + (ok ? 'ok' : 'bad'); };

  async function post(path, body) {
    try {
      const r = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (j && j.speak) $('say').textContent = '▸ ' + j.speak;
    } catch { $('say').textContent = '▸ (request failed)'; }
    refresh(); pollLog();
  }
  const sw = (target, action) => post('/switch', { target, action });
  const allOff = () => post('/switch', { action: 'all_off' });
  function runCmd(e) { e.preventDefault(); const t = $('cmd').value.trim(); if (t) post('/command', { text: t }); $('cmd').value=''; return false; }

  function renderState(state) {
    setDot('dot-board', !!state.online);
    document.body.classList.toggle('offline', !state.online);
    const sm = state.smartswitch || {};
    const tiles = $('tiles');
    tiles.innerHTML = '';
    for (const [name, on] of Object.entries(sm)) {
      const b = document.createElement('button');
      b.className = 'tile' + (on ? ' on' : '');
      const nameEl = document.createElement('span'); nameEl.className = 'name'; nameEl.textContent = name;
      const stEl = document.createElement('span'); stEl.className = 'st'; stEl.textContent = on ? 'on' : 'off';
      b.append(nameEl, stEl);
      b.onclick = () => sw(name, on ? 'off' : 'on');
      tiles.appendChild(b);
    }
  }
  async function refresh() {
    try { const r = await fetch('/state'); setDot('dot-orch', true); renderState(await r.json()); }
    catch { setDot('dot-orch', false); document.body.classList.add('offline'); }
  }

  function renderVoice(v) {
    const status = v.status || 'idle';
    const badge = $('vbadge'); badge.textContent = status; badge.className = 'badge ' + status;
    const score = Number(v.wakeScore || 0), thr = Number(v.threshold || 0);
    $('wfill').style.width = Math.max(0, Math.min(1, score)) * 100 + '%';
    $('wthr').style.left = Math.max(0, Math.min(1, thr)) * 100 + '%';
    $('wnum').textContent = score.toFixed(2) + (thr ? ' / ' + thr.toFixed(2) : '');
    $('heard').textContent = v.lastTranscript ? 'heard: "' + v.lastTranscript + '"' : '';
    setDot('dot-voice', v.ageMs != null && v.ageMs < 3000);
  }
  async function pollVoice() {
    try { renderVoice(await (await fetch('/voice')).json()); }
    catch { setDot('dot-voice', false); }
  }

  function intentText(it) {
    if (!it) return '—';
    if (it.action === 'all_off') return 'all off';
    return it.action + (it.target ? ' ' + it.target : '');
  }
  async function pollLog() {
    try {
      const { commands = [] } = await (await fetch('/log')).json();
      const feed = $('feed');
      feed.innerHTML = '';
      for (const c of commands) {
        const div = document.createElement('div');
        div.className = 'item' + (c.ok ? '' : ' bad');
        const tm = document.createElement('time'); tm.textContent = new Date(c.ts).toLocaleTimeString();
        const txt = document.createElement('span'); txt.textContent = '"' + (c.text || '') + '"';
        const meta = document.createElement('span'); meta.className = 'meta';
        meta.textContent = intentText(c.intent) + (c.via ? ' [' + c.via + ']' : '') + (c.speak ? '  → ' + c.speak : '');
        div.append(tm, txt, meta);
        feed.appendChild(div);
      }
    } catch {}
  }

  refresh(); setInterval(refresh, 1500);
  pollVoice(); setInterval(pollVoice, 500);
  pollLog(); setInterval(pollLog, 1500);
</script>
</body>
</html>
```

- [ ] **Step 2: Confirm `GET /` still serves it** — `node --test orchestrator/server.test.js` (the existing `GET /` test matches `/JARVIS/`; still passes).

- [ ] **Step 3: Commit**

```bash
git add orchestrator/public/index.html
git commit -m "Dashboard: voice panel (wake meter, transcript), activity feed, health dots"
```

---

## Task 8: Live smoke + checkpoint + push

> Verification (no commit for smoke), then checkpoint + push.

- [ ] **Step 1: Restart orchestrator fresh** (one may be running on :3000)

```bash
pkill -f "orchestrator/server.js" 2>/dev/null; sleep 1
npm start > /tmp/jarvis-voice-dash.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:3000/health >/dev/null 2>&1 && break; sleep 0.3; done
```

- [ ] **Step 2: Endpoint shapes**

```bash
echo "-- post a voice event --"; curl -s -X POST localhost:3000/voice/event -H 'content-type: application/json' -d '{"type":"wake_score","score":0.42,"threshold":0.5}'; echo
echo "-- GET /voice --"; curl -s localhost:3000/voice; echo
echo "-- a command, then GET /log --"; curl -s -X POST localhost:3000/command -H 'content-type: application/json' -d '{"text":"is the tubelight on"}' >/dev/null; curl -s localhost:3000/log; echo
echo "-- GET / has JARVIS --"; curl -s localhost:3000/ | grep -o JARVIS | head -1
```
Expected: `/voice/event`→`{"ok":true}`; `/voice` shows `wakeScore:0.42, threshold:0.5`; `/log` lists the command with a `via`; `/` prints `JARVIS`.

- [ ] **Step 3: Hand off to user** — open `http://localhost:3000/`, then run `! voice-service/run-full.sh` and say "hey jarvis"; watch the **wake-score bar** move and the state/transcript update. (Agent cannot speak/hear.)

- [ ] **Step 4: Update `CHECKPOINT.md`** — under the TL;DR, after the dashboard bullet, add:

```
- **Voice observability — DONE.** Voice service emits events (incl. live wake-score) to `/voice/event`; dashboard shows a Voice panel (state, wake meter, transcript), an activity feed (per-command intent + matched layer), and orch/board/voice health dots.
```

- [ ] **Step 5: Commit + push**

```bash
git add CHECKPOINT.md
git commit -m "Update checkpoint: voice observability dashboard done"
git push
```

---

## Acceptance criteria

- [ ] `npm test` green — 75 tests, 0 failures.
- [ ] `python3 -m unittest discover -s voice-service/tests` green — 7 tests.
- [ ] `POST /voice/event` updates `GET /voice`; `GET /log` lists commands with `via`; `GET /` still serves the dashboard.
- [ ] Voice service emits telemetry best-effort (never crashes if orchestrator is down).
- [ ] User confirms in-browser: wake-score bar moves on "hey jarvis", state + transcript + activity update live.
- [ ] Committed + pushed; `CHECKPOINT.md` notes voice observability.
```
