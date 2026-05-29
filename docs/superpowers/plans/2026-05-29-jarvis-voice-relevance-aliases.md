# JARVIS Voice Relevance + Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vosk recognize tubelight/rgb (spoken aliases) and ignore ambient/irrelevant speech (confidence gating).

**Architecture:** `grammar.py` emits real-word spoken aliases (`tubelight → "tube light"`) and normalizes them back; `VoskSTT.listen` enables word confidences and rejects any utterance below `VOICE_MIN_CONFIDENCE` (or `[unk]`/empty), in both the recording and follow-up turns.

**Tech Stack:** Python 3.12 (`vosk`), `unittest`. No new deps. Orchestrator untouched (npm test stays 77).

**Spec:** `docs/superpowers/specs/2026-05-29-jarvis-voice-relevance-aliases-design.md`
**Baseline:** 77 orchestrator tests + 15 voice tests green (HEAD 50c3038).

---

## Task 1: Spoken aliases for non-lexicon names (TDD)

**Files:** Modify `voice-service/grammar.py`, `voice-service/tests/test_grammar.py`

- [ ] **Step 1: Add assertions** to `voice-service/tests/test_grammar.py`:
  - In `test_to_spoken_numbers`, add: `self.assertEqual(to_spoken("tubelight"), "tube light")`
  - In `test_build_grammar_phrases_and_map`, add `"turn off the tube light"` to the asserted phrase list, and after the existing map asserts add: `self.assertEqual(mapping["tube light"], "tubelight")`
  - In `test_normalize_transcript`, add: `self.assertEqual(normalize_transcript("turn off the tube light", mapping), "turn off the tubelight")`

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (`to_spoken("tubelight")` returns "tubelight").

- [ ] **Step 3: Edit `voice-service/grammar.py`.** Add after `NUMBER_WORDS = {...}`:
```python
SPOKEN_OVERRIDES = {
    "tubelight": "tube light",
    "rgb light": "r g b light",
}
```
Replace `to_spoken`:
```python
def to_spoken(name):
    """Registry name -> spoken form Vosk can decode (real words only)."""
    if name in SPOKEN_OVERRIDES:
        return SPOKEN_OVERRIDES[name]
    return " ".join(NUMBER_WORDS.get(tok, tok) for tok in name.split(" "))
```

- [ ] **Step 4: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (15 tests; augmented assertions pass).

- [ ] **Step 5: Commit**
```bash
git add voice-service/grammar.py voice-service/tests/test_grammar.py
git commit -m "Spoken aliases so Vosk can decode tubelight/rgb"
```

---

## Task 2: Confidence helper (TDD)

**Files:** Modify `voice-service/stt.py`, `voice-service/tests/test_stt.py`

- [ ] **Step 1: Add tests** to `voice-service/tests/test_stt.py` — change the import to `from stt import fetch_vocab, utterance_text_conf` and append:
```python
class UtteranceConfTest(unittest.TestCase):
    def test_mean_conf_of_words(self):
        r = {"text": "turn off the tubelight", "result": [
            {"word": "turn", "conf": 0.9}, {"word": "off", "conf": 0.8},
            {"word": "the", "conf": 1.0}, {"word": "tubelight", "conf": 0.7}]}
        text, conf = utterance_text_conf(r)
        self.assertEqual(text, "turn off the tubelight")
        self.assertAlmostEqual(conf, 0.85, places=2)

    def test_low_conf(self):
        r = {"text": "fans off", "result": [{"word": "fans", "conf": 0.2}, {"word": "off", "conf": 0.3}]}
        _, conf = utterance_text_conf(r)
        self.assertAlmostEqual(conf, 0.25, places=2)

    def test_empty_result(self):
        self.assertEqual(utterance_text_conf({}), ("", 0.0))

    def test_text_without_word_confs(self):
        self.assertEqual(utterance_text_conf({"text": "lights off"}), ("lights off", 1.0))
```

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (`utterance_text_conf` not defined).

- [ ] **Step 3: Add `utterance_text_conf` to `voice-service/stt.py`** (module-level, e.g. just above `class VoskSTT`):
```python
def utterance_text_conf(result):
    """Vosk Result JSON dict -> (text, mean word confidence)."""
    words = result.get("result") or []
    text = (result.get("text") or "").strip()
    if words:
        return text, sum(float(w.get("conf", 0.0)) for w in words) / len(words)
    return text, (1.0 if text else 0.0)
```

- [ ] **Step 4: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (15 + 4 = 19 tests).

- [ ] **Step 5: Commit**
```bash
git add voice-service/stt.py voice-service/tests/test_stt.py
git commit -m "Add utterance_text_conf helper for confidence gating"
```

---

## Task 3: Gate listen() on confidence + min_confidence config

**Files:** Modify `voice-service/stt.py`, `voice-service/config.py`

- [ ] **Step 1: Add `min_confidence` to `voice-service/config.py`.** In the `VoiceConfig` dataclass (near `max_utterance_seconds`) add:
```python
    min_confidence: float = 0.6
```
In `load_config(...)` add:
```python
        min_confidence=float(env.get("VOICE_MIN_CONFIDENCE", "0.6")),
```

- [ ] **Step 2: Store `min_conf` in `VoskSTT.__init__`.** After `self.spoken_to_name = ...` (in the constructor) add:
```python
        self.min_conf = getattr(config, "min_confidence", 0.6)
```

- [ ] **Step 3: Replace `VoskSTT.listen`** with the gated version:
```python
    def listen(self, max_initial_silence=5.0, max_utterance=12.0):
        from grammar import normalize_transcript

        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        rec = self._KaldiRecognizer(self.model, self.sample_rate, self._grammar)
        rec.SetWords(True)
        result = None
        started = False
        t0 = time.monotonic()
        try:
            while True:
                chunk = proc.stdout.read(4000)
                if not chunk:
                    break
                if rec.AcceptWaveform(chunk):
                    result = json.loads(rec.Result())
                    break
                if json.loads(rec.PartialResult()).get("partial"):
                    started = True
                elapsed = time.monotonic() - t0
                if not started and elapsed >= max_initial_silence:
                    break
                if elapsed >= max_utterance:
                    result = json.loads(rec.FinalResult())
                    break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        if not result:
            return ""
        text, conf = utterance_text_conf(result)
        if not text or text == "[unk]" or conf < self.min_conf:
            return ""  # ambient noise / irrelevant / low-confidence
        return normalize_transcript(text, self.spoken_to_name)
```

- [ ] **Step 4: Tests + import smoke**
```bash
python3 -m unittest discover -s voice-service/tests   # 19 tests, OK
.venv/bin/python -c "import sys; sys.path.insert(0,'voice-service'); from stt import VoskSTT, utterance_text_conf; print('stt ok', hasattr(VoskSTT,'listen'))"
```
Expected: 19 OK; `stt ok True`.

- [ ] **Step 5: Commit**
```bash
git add voice-service/stt.py voice-service/config.py
git commit -m "Gate Vosk listen on word confidence (ignore ambient/irrelevant)"
```

---

## Task 4: Docs, verify, push, hand off

**Files:** Modify `.env.example`, `CHECKPOINT.md`

- [ ] **Step 1: Document in `.env.example`.** Under the `# Voice service` block (near `VOICE_MAX_UTTERANCE_SECONDS=12`) add:
```
VOICE_MIN_CONFIDENCE=0.6
```

- [ ] **Step 2: Verify**
```bash
npm test                                              # 77, 0 failures
python3 -m unittest discover -s voice-service/tests   # 19 tests, OK
```

- [ ] **Step 3: Update `CHECKPOINT.md`.** After the conversational-voice-loop bullet in the TL;DR add:
```
- **Voice reliability — DONE.** Spoken aliases so Vosk can decode non-lexicon names (tubelight→"tube light", rgb→"r g b light"); confidence gating (`VOICE_MIN_CONFIDENCE`=0.6) so ambient noise / irrelevant speech in the recording + follow-up windows is ignored. 19 voice tests green.
```

- [ ] **Step 4: Commit + push**
```bash
git add .env.example CHECKPOINT.md
git commit -m "Update checkpoint + .env.example: voice reliability fixes"
git push
```

- [ ] **Step 5: Hand off (USER drives the spoken test).** User re-runs `! ./run-jarvis.sh`, says "hey jarvis, turn off the tube light" (now recognized); then verifies that talking non-commands during the follow-up window no longer fires actions. Tuning: raise `VOICE_MIN_CONFIDENCE` if noise still gets through, lower it if real commands are dropped. (Agent can't speak/hear.)

---

## Acceptance criteria

- [ ] `npm test` green (77); `python3 -m unittest discover -s voice-service/tests` green (19).
- [ ] `to_spoken("tubelight") == "tube light"`; grammar + normalize round-trip works.
- [ ] `utterance_text_conf` returns mean word confidence; `listen()` rejects empty/`[unk]`/low-confidence.
- [ ] Importing `stt.py` still needs no `vosk` (lazy import).
- [ ] User confirms by voice: "tube light" works; ambient chatter is ignored.
- [ ] Committed + pushed; `CHECKPOINT.md` updated.
```
