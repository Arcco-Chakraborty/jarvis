# JARVIS Vosk Grammar STT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-form Whisper STT with a constrained Vosk recognizer whose grammar is JARVIS's valid command phrases, so transcripts are always real commands (no hallucination).

**Architecture:** Orchestrator exposes `GET /vocab`; the voice service fetches it, generates the command phrases (pure `grammar.py`), and constrains a Vosk `KaldiRecognizer` to that grammar. Number words are normalized back to registry names ("fan one"→"fan 1"). Whisper stays as an alternative backend.

**Tech Stack:** Node/Express + `node:test`; Python 3.12 (`vosk`, stdlib `urllib`/`subprocess`) + `unittest`. Vosk model `vosk-model-small-en-us-0.15` (~40 MB).

**Spec:** `docs/superpowers/specs/2026-05-29-jarvis-vosk-stt-design.md`
**Baseline:** 75 orchestrator tests + 7 voice tests green (HEAD 9d910ee).

---

## Task 1: Orchestrator `GET /vocab` (TDD)

**Files:** Modify `orchestrator/server.js`, `orchestrator/server.test.js`

- [ ] **Step 1: Append tests** to `orchestrator/server.test.js`:

```js
test('GET /vocab returns the injected vocab', async () => {
  const vocab = { deviceNames: ['tubelight', 'fan 1'], groupNames: ['lights', 'fans'] };
  const server = buildApp({ esp32: stubEsp32({}), vocab }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/vocab`)).json();
    assert.deepEqual(body, vocab);
  } finally {
    server.close();
  }
});

test('GET /vocab tolerates missing vocab', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/vocab`)).json(), {
      deviceNames: [], groupNames: [],
    });
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test orchestrator/server.test.js` (`/vocab` is 404).

- [ ] **Step 3: Edit `orchestrator/server.js`.** Change the signature:
```js
export function buildApp({ esp32, onCommand, onSwitch, telemetry, vocab }) {
```
Add before `return app;`:
```js
  app.get('/vocab', (req, res) => {
    res.json(vocab ?? { deviceNames: [], groupNames: [] });
  });
```
In `main()`, pass `vocab` into the build call (it's already defined there):
```js
  buildApp({ esp32, onCommand, onSwitch, telemetry, vocab }).listen(config.port, () => {
```

- [ ] **Step 4: Run → PASS** — `node --test orchestrator/server.test.js`.

- [ ] **Step 5: Full suite** — `npm test` → 77 tests, 0 failures.

- [ ] **Step 6: Commit**
```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "Add GET /vocab (device + group names) for the voice grammar"
```

---

## Task 2: Grammar builder (pure, TDD)

**Files:** Create `voice-service/grammar.py`, `voice-service/tests/test_grammar.py`

- [ ] **Step 1: Write `voice-service/tests/test_grammar.py`:**

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from grammar import to_spoken, build_grammar, normalize_transcript

VOCAB = {
    "deviceNames": ["fan 1", "fan 2", "tubelight", "rgb light", "socket"],
    "groupNames": ["lights", "fans"],
}


class GrammarTest(unittest.TestCase):
    def test_to_spoken_numbers(self):
        self.assertEqual(to_spoken("fan 1"), "fan one")
        self.assertEqual(to_spoken("fan 2"), "fan two")
        self.assertEqual(to_spoken("tubelight"), "tubelight")

    def test_build_grammar_phrases_and_map(self):
        phrases, mapping = build_grammar(VOCAB)
        for p in [
            "turn off the fan one", "fan one on", "is the tubelight on",
            "turn off the rgb light", "lights off", "turn on the lights",
            "everything off", "keep the lights on rest off",
        ]:
            self.assertIn(p, phrases)
        self.assertEqual(mapping["fan one"], "fan 1")
        self.assertEqual(mapping["fan two"], "fan 2")
        self.assertEqual(len(phrases), len(set(phrases)))  # de-duped

    def test_normalize_transcript(self):
        _, mapping = build_grammar(VOCAB)
        self.assertEqual(normalize_transcript("turn off the fan one", mapping), "turn off the fan 1")
        self.assertEqual(normalize_transcript("lights off", mapping), "lights off")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (no `grammar` module).

- [ ] **Step 3: Create `voice-service/grammar.py`:**

```python
NUMBER_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}


def to_spoken(name):
    """Registry name -> spoken form: 'fan 1' -> 'fan one'. Non-digit names unchanged."""
    return " ".join(NUMBER_WORDS.get(tok, tok) for tok in name.split(" "))


def build_grammar(vocab):
    """vocab {deviceNames, groupNames} -> (phrases list, spoken_to_name map)."""
    devices = (vocab or {}).get("deviceNames", [])
    groups = (vocab or {}).get("groupNames", [])
    phrases = []
    spoken_to_name = {}

    def add(p):
        if p not in phrases:
            phrases.append(p)

    for name in devices:
        sd = to_spoken(name)
        spoken_to_name[sd] = name
        add(f"turn on the {sd}")
        add(f"turn off the {sd}")
        add(f"{sd} on")
        add(f"{sd} off")
        add(f"is the {sd} on")
        add(f"keep the {sd} on rest off")

    for g in groups:
        add(f"turn on the {g}")
        add(f"turn off the {g}")
        add(f"{g} on")
        add(f"{g} off")
        add(f"keep the {g} on rest off")

    for p in ("all off", "everything off", "turn everything off", "turn off everything"):
        add(p)

    return phrases, spoken_to_name


def normalize_transcript(text, spoken_to_name):
    """Replace spoken device forms with registry names ('fan one' -> 'fan 1')."""
    out = text
    for spoken in sorted(spoken_to_name, key=len, reverse=True):
        name = spoken_to_name[spoken]
        if spoken != name:
            out = out.replace(spoken, name)
    return out
```

- [ ] **Step 4: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (existing 7 + 3 new = 10).

- [ ] **Step 5: Commit**
```bash
git add voice-service/grammar.py voice-service/tests/test_grammar.py
git commit -m "Add voice command grammar builder + number-word normalization"
```

---

## Task 3: Vosk STT backend + /vocab fetch (TDD for fetch_vocab)

**Files:** Modify `voice-service/stt.py`, `voice-service/config.py`; Create `voice-service/tests/test_stt.py`

- [ ] **Step 1: Write `voice-service/tests/test_stt.py`** (tests `fetch_vocab` with a fake opener — no Vosk/audio):

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stt import fetch_vocab


class FakeResp:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


class FetchVocabTest(unittest.TestCase):
    def test_returns_parsed_json(self):
        def opener(url, timeout=None):
            assert url.endswith("/vocab"), url
            return FakeResp(b'{"deviceNames":["tubelight"],"groupNames":["lights"]}')

        self.assertEqual(
            fetch_vocab("http://x:3000", opener=opener),
            {"deviceNames": ["tubelight"], "groupNames": ["lights"]},
        )

    def test_error_returns_empty_vocab(self):
        def boom(url, timeout=None):
            raise OSError("down")

        self.assertEqual(fetch_vocab("http://x", opener=boom), {"deviceNames": [], "groupNames": []})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run → FAIL** — `python3 -m unittest discover -s voice-service/tests` (`fetch_vocab` not defined).

- [ ] **Step 3: Edit `voice-service/stt.py`.** Add imports at the top (after the existing `import subprocess`/`tempfile`/`pathlib`):
```python
import json
from urllib.request import urlopen
```
Add `fetch_vocab` and `VoskSTT` (anywhere above `build_stt`):
```python
def fetch_vocab(orchestrator_url, opener=urlopen):
    """GET {url}/vocab -> {deviceNames, groupNames}; empty vocab on any failure."""
    try:
        with opener(orchestrator_url.rstrip("/") + "/vocab", timeout=5) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception:
        return {"deviceNames": [], "groupNames": []}


class VoskSTT:
    def __init__(self, config, vocab=None):
        from vosk import Model, KaldiRecognizer
        from grammar import build_grammar

        self._KaldiRecognizer = KaldiRecognizer
        if vocab is None:
            vocab = fetch_vocab(config.orchestrator_url)
        self.phrases, self.spoken_to_name = build_grammar(vocab)
        self.model = Model(config.vosk_model_path)
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self._grammar = json.dumps(self.phrases + ["[unk]"])

    def transcribe(self):
        from grammar import normalize_transcript

        proc = subprocess.run(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE",
             "-t", "raw", "-d", str(int(self.record_seconds))],
            stdout=subprocess.PIPE,
            check=True,
        )
        rec = self._KaldiRecognizer(self.model, self.sample_rate, self._grammar)
        rec.AcceptWaveform(proc.stdout)
        text = (json.loads(rec.FinalResult()).get("text") or "").strip()
        if not text or text == "[unk]":
            return ""
        return normalize_transcript(text, self.spoken_to_name)
```
Replace `build_stt` with:
```python
def build_stt(config, vocab=None):
    if config.stt_backend == "vosk":
        return VoskSTT(config, vocab=vocab)
    if config.stt_backend == "whisper":
        return FasterWhisperSTT(
            model_name=config.whisper_model,
            compute_type=config.whisper_compute_type,
            record_seconds=config.record_seconds,
            sample_rate=config.sample_rate,
        )
    return ManualTextInput()
```

- [ ] **Step 4: Add `vosk_model_path` to `voice-service/config.py`.** In the `VoiceConfig` dataclass add:
```python
    vosk_model_path: str = "voice-service/models/vosk-model-small-en-us-0.15"
```
In `load_config(...)`'s returned `VoiceConfig(...)` add:
```python
        vosk_model_path=env.get("VOSK_MODEL_PATH", "voice-service/models/vosk-model-small-en-us-0.15"),
```

- [ ] **Step 5: Run → PASS** — `python3 -m unittest discover -s voice-service/tests` (10 + 2 = 12). (Importing `stt` must not require `vosk` — the `vosk` import lives inside `VoskSTT.__init__`.)

- [ ] **Step 6: Commit**
```bash
git add voice-service/stt.py voice-service/config.py voice-service/tests/test_stt.py
git commit -m "Add VoskSTT grammar backend + /vocab fetch; vosk_model_path config"
```

---

## Task 4: Dependency, model, and launch defaults

**Files:** Modify `voice-service/requirements.txt`, `voice-service/run-full.sh`

- [ ] **Step 1: Add `vosk` to `voice-service/requirements.txt`** (append a line):
```
vosk==0.3.45
```

- [ ] **Step 2: Install vosk into the venv**

Run: `uv pip install --python .venv/bin/python vosk==0.3.45`
Expected: installs vosk (+ its deps) into `.venv`.

- [ ] **Step 3: Download + unzip the model** (background-friendly; ~40 MB)

```bash
mkdir -p voice-service/models
curl -L --fail -o /tmp/vosk-small.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
python3 -m zipfile -e /tmp/vosk-small.zip voice-service/models/
ls -d voice-service/models/vosk-model-small-en-us-0.15
```
Expected: `voice-service/models/vosk-model-small-en-us-0.15/` exists (the `VOSK_MODEL_PATH` default).

- [ ] **Step 4: Make Vosk the default backend in `voice-service/run-full.sh`.** Change:
```bash
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
```
to:
```bash
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-vosk}"
export VOSK_MODEL_PATH="${VOSK_MODEL_PATH:-voice-service/models/vosk-model-small-en-us-0.15}"
```

- [ ] **Step 5: Smoke the Vosk load + grammar** (no mic; just confirms the model loads and the grammar builds)

```bash
.venv/bin/python -c "
import sys; sys.path.insert(0,'voice-service')
from grammar import build_grammar
from vosk import Model, KaldiRecognizer
import json
ph,m = build_grammar({'deviceNames':['fan 1','tubelight','socket'],'groupNames':['lights','fans']})
model = Model('voice-service/models/vosk-model-small-en-us-0.15')
KaldiRecognizer(model, 16000, json.dumps(ph+['[unk]']))
print('vosk model + grammar ok;', len(ph), 'phrases')
"
```
Expected: `vosk model + grammar ok; <N> phrases`.

- [ ] **Step 6: Commit**
```bash
git add voice-service/requirements.txt voice-service/run-full.sh
git commit -m "Default voice STT to Vosk; add vosk dep + model path"
```

---

## Task 5: Verify + checkpoint + push + hand off

- [ ] **Step 1: Both suites green**
```bash
npm test                                   # 77, 0 failures
python3 -m unittest discover -s voice-service/tests   # 12 tests, OK
```

- [ ] **Step 2: Update `CHECKPOINT.md`** — under the TL;DR, after the voice-observability bullet, add:
```
- **STT upgraded to Vosk (grammar-constrained) — DONE.** Replaced free-form Whisper (which hallucinated on short/accented commands) with Vosk constrained to a grammar of valid commands built from `GET /vocab`; "fan one"->"fan 1" normalization; default `VOICE_STT_BACKEND=vosk` (whisper still available). Far more reliable for the fixed command set.
```

- [ ] **Step 3: Commit + push**
```bash
git add CHECKPOINT.md
git commit -m "Update checkpoint: Vosk grammar STT"
git push
```

- [ ] **Step 4: Hand off (USER drives the spoken test).** The user re-runs `! ./run-jarvis.sh` (now defaults to Vosk), opens `http://localhost:3000/`, says "hey jarvis" + a command, and confirms the transcript on the dashboard is now a clean command. (Agent can't speak/hear.)

---

## Acceptance criteria

- [ ] `npm test` green (77); `python3 -m unittest discover -s voice-service/tests` green (12).
- [ ] `GET /vocab` returns `{deviceNames, groupNames}`.
- [ ] Vosk model loads and a grammar of valid command phrases builds (Step 4.5 smoke).
- [ ] Importing `stt.py` needs no `vosk`/`faster_whisper` (lazy imports); manual/whisper backends still selectable.
- [ ] User confirms by voice: transcripts are now real commands (no "They're not the Indian"), relays flip.
- [ ] Committed + pushed; `CHECKPOINT.md` notes the Vosk STT.
```
