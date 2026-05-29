# JARVIS Conversational Voice Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto speech-timing (stream Vosk + endpoint on silence) and continued conversation (keep taking commands after wake until ~5s silence), plus a wider grammar.

**Architecture:** `VoskSTT.listen()` streams `arecord` chunks into a Vosk recognizer and stops on Vosk's built-in end-of-utterance; a pure `run_conversation(listen_fn, handle_fn, followup_seconds)` turn-taker drives multiple commands per wake; `run_loop` uses it for streaming backends.

**Tech Stack:** Python 3.12 (`vosk`, stdlib `subprocess`/`time`), `unittest`. No new deps. Orchestrator untouched.

**Spec:** `docs/superpowers/specs/2026-05-29-jarvis-voice-conversation-design.md`
**Baseline:** 77 orchestrator tests + 12 voice tests green (HEAD d8f0491).

---

## Task 1: Config — follow-up + max-utterance windows

**Files:** Modify `voice-service/config.py`

- [ ] **Step 1: Add fields to the `VoiceConfig` dataclass.** After `request_timeout_s: float = 5.0` add:
```python
    followup_seconds: float = 5.0
    max_utterance_seconds: float = 12.0
```

- [ ] **Step 2: Add them to `load_config`.** After the `request_timeout_s=float(env.get("VOICE_REQUEST_TIMEOUT_S", "5")),` line add:
```python
        followup_seconds=float(env.get("VOICE_FOLLOWUP_SECONDS", "5")),
        max_utterance_seconds=float(env.get("VOICE_MAX_UTTERANCE_SECONDS", "12")),
```

- [ ] **Step 3: Verify defaults load**

Run:
```bash
.venv/bin/python -c "import sys; sys.path.insert(0,'voice-service'); from config import load_config; c=load_config({}); print(c.followup_seconds, c.max_utterance_seconds)"
```
Expected: `5.0 12.0`

- [ ] **Step 4: Commit**
```bash
git add voice-service/config.py
git commit -m "Add voice follow-up + max-utterance window config"
```

---

## Task 2: Widen the grammar (TDD)

**Files:** Modify `voice-service/grammar.py`, `voice-service/tests/test_grammar.py`

- [ ] **Step 1: Add assertions** to the `test_build_grammar_phrases_and_map` test in `voice-service/tests/test_grammar.py` — extend its phrase list with the new forms:
```python
            "switch off the tubelight", "turn the tubelight on",
            "switch on the lights", "turn the lights off",
```
(Add these strings inside the existing `for p in [ ... ]:` list.)

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (new phrases not generated yet).

- [ ] **Step 3: Widen `build_grammar` in `voice-service/grammar.py`.** In the device loop, after `add(f"keep the {sd} on rest off")` add:
```python
        add(f"switch on the {sd}")
        add(f"switch off the {sd}")
        add(f"turn the {sd} on")
        add(f"turn the {sd} off")
```
In the group loop, after `add(f"keep the {g} on rest off")` add:
```python
        add(f"switch on the {g}")
        add(f"switch off the {g}")
        add(f"turn the {g} on")
        add(f"turn the {g} off")
```

- [ ] **Step 4: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (still 12 tests; the widened test passes).

- [ ] **Step 5: Commit**
```bash
git add voice-service/grammar.py voice-service/tests/test_grammar.py
git commit -m "Widen voice grammar with switch/turn-the phrasings"
```

---

## Task 3: Streaming endpointed `VoskSTT.listen`

**Files:** Modify `voice-service/stt.py`

> No unit test (needs live audio); verified by an import smoke + the live voice test.

- [ ] **Step 1: Add `import time`** to the top of `voice-service/stt.py` (with the other imports):
```python
import time
```

- [ ] **Step 2: Replace `VoskSTT.transcribe`** (the fixed-window method) with a streaming `listen` + a thin `transcribe` delegate:

```python
    def listen(self, max_initial_silence=5.0, max_utterance=12.0):
        from grammar import normalize_transcript

        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        rec = self._KaldiRecognizer(self.model, self.sample_rate, self._grammar)
        text = ""
        started = False
        t0 = time.monotonic()
        try:
            while True:
                chunk = proc.stdout.read(4000)
                if not chunk:
                    break
                if rec.AcceptWaveform(chunk):
                    text = json.loads(rec.Result()).get("text", "")
                    break
                if json.loads(rec.PartialResult()).get("partial"):
                    started = True
                elapsed = time.monotonic() - t0
                if not started and elapsed >= max_initial_silence:
                    break
                if elapsed >= max_utterance:
                    text = json.loads(rec.FinalResult()).get("text", "")
                    break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        text = (text or "").strip()
        if not text or text == "[unk]":
            return ""
        return normalize_transcript(text, self.spoken_to_name)

    def transcribe(self):
        return self.listen(max_initial_silence=self.record_seconds)
```

- [ ] **Step 3: Import smoke** (no audio; confirms syntax + lazy imports)

Run:
```bash
.venv/bin/python -c "import sys; sys.path.insert(0,'voice-service'); from stt import VoskSTT, build_stt; print('stt ok', hasattr(VoskSTT,'listen'))"
```
Expected: `stt ok True`

- [ ] **Step 4: Commit**
```bash
git add voice-service/stt.py
git commit -m "Stream Vosk with built-in endpointing (auto speak-timing)"
```

---

## Task 4: Conversation loop (TDD)

**Files:** Modify `voice-service/main.py`, `voice-service/tests/test_main.py`

- [ ] **Step 1: Add `run_conversation` tests** to `voice-service/tests/test_main.py` — change the import to `from main import handle_text, run_conversation` and append:

```python
class RunConversationTest(unittest.TestCase):
    def test_handles_commands_until_silence(self):
        seq = iter(["turn off the tubelight", "lights on", ""])
        handled = []
        run_conversation(lambda: next(seq), handled.append, followup_seconds=5)
        self.assertEqual(handled, ["turn off the tubelight", "lights on"])

    def test_one_shot_when_followup_zero(self):
        seq = iter(["a", "b"])
        handled = []
        run_conversation(lambda: next(seq), handled.append, followup_seconds=0)
        self.assertEqual(handled, ["a"])

    def test_returns_immediately_on_silence(self):
        handled = []
        run_conversation(lambda: "", handled.append, followup_seconds=5)
        self.assertEqual(handled, [])
```

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (`run_conversation` not defined).

- [ ] **Step 3: Add `run_conversation` to `voice-service/main.py`** (above `run_loop`):

```python
def run_conversation(listen_fn, handle_fn, followup_seconds, reporter=None):
    """Take commands turn-by-turn until a silent turn (empty text), then return.
    followup_seconds <= 0 -> one-shot (handle one command, then return)."""
    while True:
        if reporter is not None:
            reporter.emit("recording")
        text = listen_fn()
        if not text:
            return
        if reporter is not None:
            reporter.emit("transcript", text=text)
        handle_fn(text)
        if followup_seconds <= 0:
            return
```

- [ ] **Step 4: Rewire `run_loop`'s `while True` body** in `voice-service/main.py`. Replace the existing loop body (from `reporter.emit("listening")` through `handle_text(text, client, speaker)` / `reporter.emit("idle")`) with:

```python
    while True:
        reporter.emit("listening")
        if not wake_listener.wait():
            continue
        reporter.emit("awake")
        if hasattr(stt, "listen"):
            run_conversation(
                listen_fn=lambda: stt.listen(config.followup_seconds, config.max_utterance_seconds),
                handle_fn=lambda t: handle_text(t, client, speaker),
                followup_seconds=config.followup_seconds,
                reporter=reporter,
            )
        else:
            text = stt.transcribe()
            if not text:
                break
            reporter.emit("transcript", text=text)
            handle_text(text, client, speaker)
        reporter.emit("idle")
```

- [ ] **Step 5: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (12 + 3 = 15 tests, OK).

- [ ] **Step 6: Commit**
```bash
git add voice-service/main.py voice-service/tests/test_main.py
git commit -m "Add continued-conversation loop (wake once, keep taking commands)"
```

---

## Task 5: Docs, verify, checkpoint, push

**Files:** Modify `.env.example`, `CHECKPOINT.md`

- [ ] **Step 1: Document the new env vars in `.env.example`.** Under the `# Voice service` block (after `VOICE_RECORD_SECONDS=4`) add:
```
VOICE_FOLLOWUP_SECONDS=5
VOICE_MAX_UTTERANCE_SECONDS=12
```

- [ ] **Step 2: Verify both suites + import smoke**
```bash
npm test                                              # 77, 0 failures (orchestrator untouched)
python3 -m unittest discover -s voice-service/tests   # 15 tests, OK
.venv/bin/python -c "import sys; sys.path.insert(0,'voice-service'); from main import run_conversation; from stt import VoskSTT; print('imports ok')"
```
Expected: orchestrator green; voice 15 OK; `imports ok`.

- [ ] **Step 3: Update `CHECKPOINT.md`.** After the Vosk STT bullet in the TL;DR, add:
```
- **Conversational voice loop — DONE.** Streaming Vosk endpointing (records exactly while you speak, stops on silence — no fixed window) + continued conversation (wake once, keep issuing commands until ~5s silence re-arms the wake word; `VOICE_FOLLOWUP_SECONDS`, `VOICE_MAX_UTTERANCE_SECONDS`). Grammar widened. 15 voice tests green.
```

- [ ] **Step 4: Commit + push**
```bash
git add .env.example CHECKPOINT.md
git commit -m "Update checkpoint + .env.example: conversational voice loop"
git push
```

- [ ] **Step 5: Hand off (USER drives the spoken test).** User re-runs `! ./run-jarvis.sh`, opens `http://localhost:3000/`, says "hey jarvis" then a command — it should respond on stop-speaking (no 4s wait), accept a follow-up command without re-waking, and re-arm after ~5s silence. (Agent can't speak/hear.)

---

## Acceptance criteria

- [ ] `npm test` green (77); `python3 -m unittest discover -s voice-service/tests` green (15).
- [ ] `VoskSTT.listen` streams + endpoints on silence (import smoke passes; live: responds on stop-speaking).
- [ ] `run_conversation` handles multiple commands per wake and exits on a silent turn / one-shot when `followup_seconds=0`.
- [ ] Grammar includes the new `switch`/`turn the` phrasings.
- [ ] User confirms by voice: auto-timing + follow-ups without re-waking + ~5s disarm.
- [ ] Committed + pushed; `CHECKPOINT.md` notes the conversational loop.
```
