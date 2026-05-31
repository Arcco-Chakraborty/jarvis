# GPU Whisper Open-Vocab STT + Porcupine Wake Word — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vosk grammar-locked STT with a GPU `faster-whisper` large-v3 open-vocab backend (VAD-endpointed) and swap the wake word to Porcupine's built-in "jarvis", so the full hands-free loop runs accurately on the new GPU host.

**Architecture:** New `WhisperSTT` backend in `voice-service/stt.py` decomposed into two pure, unit-testable helpers (`capture_utterance` for VAD endpointing, `whisper_transcript` for the hallucination guard) plus a thin `arecord`+CUDA integration. A new `PorcupineWakeListener` in `wakeword.py`. Config/runner/requirements updated; Python stack reinstalled on the box. The orchestrator (Gemini free-form fallback) and `run_conversation` loop are reused unchanged.

**Tech Stack:** Python 3.12, `faster-whisper` (CTranslate2/CUDA), `webrtcvad`, `pvporcupine`, `nvidia-cublas-cu12`/`nvidia-cudnn-cu12` runtime wheels, stdlib `unittest`.

**Spec:** `docs/superpowers/specs/2026-05-31-jarvis-gpu-whisper-stt-design.md`

**Branch:** `gpu-whisper-stt` (already created).

---

## File Structure

- `voice-service/stt.py` (modify) — add `capture_utterance`, `whisper_transcript`, `WhisperSTT`, `ArecordVadRecorder`; update `build_stt`. Leave the Vosk path and the `looks_like_command`/`has_target`/`STANDALONE` helpers untouched (Vosk still uses them).
- `voice-service/wakeword.py` (modify) — add `PorcupineWakeListener`; add `porcupine` branch to `build_wake_listener`.
- `voice-service/config.py` (modify) — new whisper/VAD/picovoice fields.
- `voice-service/tests/test_whisper.py` (create) — pure-helper + `WhisperSTT.listen()` tests with fakes.
- `voice-service/tests/test_wakeword.py` (create) — `PorcupineWakeListener` test with a fake porcupine.
- `voice-service/tests/test_config.py` (create) — defaults/overrides for new fields.
- `voice-service/requirements.txt` (modify) — add `pvporcupine`.
- `voice-service/run-full.sh` (modify) — GPU/whisper/porcupine defaults + CUDA `LD_LIBRARY_PATH`.
- `.env.example` (modify) — `PICOVOICE_ACCESS_KEY` + new voice knobs.

**Test command convention:** each test file is run directly, e.g.
`.venv/bin/python voice-service/tests/test_whisper.py -v` (the files self-insert
`voice-service/` onto `sys.path`). Full voice suite:
`( cd voice-service/tests && ../../.venv/bin/python -m unittest discover -s . -p 'test_*.py' )`.

---

## Task 1: VAD endpointing helper `capture_utterance`

Pure function: given an iterable of fixed-size PCM frames and a speech predicate, capture from
speech onset until trailing silence. No audio hardware, fully unit-testable.

**Files:**
- Modify: `voice-service/stt.py`
- Test: `voice-service/tests/test_whisper.py`

- [ ] **Step 1: Write the failing test**

Create `voice-service/tests/test_whisper.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stt import capture_utterance


def frames(pattern):
    # 'S' -> 30ms speech frame, '_' -> 30ms silence frame; each frame is 960 bytes.
    return [(b"\x01\x01" * 480 if c == "S" else b"\x00\x00" * 480) for c in pattern]


def is_speech(frame):
    return frame[:2] == b"\x01\x01"


class CaptureUtteranceTest(unittest.TestCase):
    def test_no_onset_within_initial_silence_returns_none(self):
        # 30ms frames; max_initial_silence 0.09s allows 3 silent frames then gives up.
        out = capture_utterance(iter(frames("______")), is_speech,
                                max_initial_silence=0.09, vad_silence_ms=60, max_utterance=5.0)
        self.assertIsNone(out)

    def test_captures_from_onset_until_trailing_silence(self):
        # speech, speech, then 60ms (2 frames) of silence ends the utterance.
        out = capture_utterance(iter(frames("__SS___S")), is_speech,
                                max_initial_silence=1.0, vad_silence_ms=60, max_utterance=5.0)
        # Captured = onset 'SS' + the two trailing silence frames that closed it = 4 frames.
        self.assertEqual(len(out), 4 * 960)

    def test_max_utterance_bound_terminates_continuous_speech(self):
        out = capture_utterance(iter(frames("S" * 100)), is_speech,
                                max_initial_silence=1.0, vad_silence_ms=300, max_utterance=0.12)
        # 0.12s / 0.03s per frame = 4 frames captured, then the bound trips.
        self.assertEqual(len(out), 4 * 960)


if __name__ == "__main__":
    unittest.main(verbosity=2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: FAIL — `ImportError: cannot import name 'capture_utterance'`.

- [ ] **Step 3: Implement `capture_utterance` in `stt.py`**

Add near the other pure helpers (after `utterance_text_conf`):

```python
def capture_utterance(frames, is_speech, sample_rate=16000, frame_ms=30,
                      max_initial_silence=5.0, vad_silence_ms=800, max_utterance=12.0):
    """Endpoint one utterance from a stream of fixed-size PCM frames.

    frames: iterable of equal-size PCM byte chunks (frame_ms each at sample_rate).
    is_speech: callable(frame_bytes) -> bool.
    Returns captured PCM bytes (onset through the trailing-silence that closed it),
    or None if no speech onset occurred within max_initial_silence.
    """
    frame_s = frame_ms / 1000.0
    silence_limit_s = vad_silence_ms / 1000.0
    collected = []
    started = False
    pre_onset_s = 0.0
    trailing_silence_s = 0.0
    for frame in frames:
        speech = is_speech(frame)
        if not started:
            if speech:
                started = True
                collected.append(frame)
            else:
                pre_onset_s += frame_s
                if pre_onset_s >= max_initial_silence:
                    return None
            continue
        collected.append(frame)
        if speech:
            trailing_silence_s = 0.0
        else:
            trailing_silence_s += frame_s
            if trailing_silence_s >= silence_limit_s:
                break
        if len(collected) * frame_s >= max_utterance:
            break
    if not started:
        return None
    return b"".join(collected)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add voice-service/stt.py voice-service/tests/test_whisper.py
git commit -m "voice: capture_utterance VAD endpointing helper"
```

---

## Task 2: Whisper hallucination-guard helper `whisper_transcript`

Pure function turning faster-whisper segments into text, dropping low-confidence / no-speech
segments. Returns `""` when everything is filtered (a "miss").

**Files:**
- Modify: `voice-service/stt.py`
- Test: `voice-service/tests/test_whisper.py`

- [ ] **Step 1: Write the failing test**

Append to `voice-service/tests/test_whisper.py` (above the `if __name__` block):

```python
from stt import whisper_transcript


class Seg:
    def __init__(self, text, no_speech_prob=0.0, avg_logprob=0.0):
        self.text = text
        self.no_speech_prob = no_speech_prob
        self.avg_logprob = avg_logprob


class WhisperTranscriptTest(unittest.TestCase):
    def test_joins_good_segments(self):
        segs = [Seg(" turn off"), Seg(" the tubelight ")]
        self.assertEqual(
            whisper_transcript(segs, no_speech_threshold=0.6, logprob_threshold=-1.0),
            "turn off the tubelight",
        )

    def test_drops_high_no_speech_prob(self):
        segs = [Seg(" Thank you.", no_speech_prob=0.9)]
        self.assertEqual(
            whisper_transcript(segs, no_speech_threshold=0.6, logprob_threshold=-1.0), "")

    def test_drops_low_avg_logprob(self):
        segs = [Seg(" mumble", avg_logprob=-2.5)]
        self.assertEqual(
            whisper_transcript(segs, no_speech_threshold=0.6, logprob_threshold=-1.0), "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: FAIL — `cannot import name 'whisper_transcript'`.

- [ ] **Step 3: Implement `whisper_transcript` in `stt.py`**

```python
def whisper_transcript(segments, no_speech_threshold=0.6, logprob_threshold=-1.0):
    """Join faster-whisper segments into text, dropping hallucinated / no-speech ones.

    Returns the cleaned transcript, or "" if every segment is filtered out.
    """
    kept = []
    for s in segments:
        nsp = getattr(s, "no_speech_prob", None)
        if nsp is not None and nsp > no_speech_threshold:
            continue
        alp = getattr(s, "avg_logprob", None)
        if alp is not None and alp < logprob_threshold:
            continue
        text = (s.text or "").strip()
        if text:
            kept.append(text)
    return " ".join(kept).strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add voice-service/stt.py voice-service/tests/test_whisper.py
git commit -m "voice: whisper_transcript hallucination guard"
```

---

## Task 3: Config fields for Whisper/VAD/Porcupine

**Files:**
- Modify: `voice-service/config.py`
- Test: `voice-service/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

Create `voice-service/tests/test_config.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config import load_config


class ConfigTest(unittest.TestCase):
    def test_whisper_vad_defaults(self):
        c = load_config(env={})
        self.assertEqual(c.whisper_device, "cuda")
        self.assertEqual(c.vad_aggressiveness, 2)
        self.assertEqual(c.vad_silence_ms, 800)
        self.assertEqual(c.whisper_no_speech_threshold, 0.6)
        self.assertEqual(c.whisper_logprob_threshold, -1.0)
        self.assertEqual(c.picovoice_access_key, "")

    def test_env_overrides(self):
        c = load_config(env={
            "WHISPER_DEVICE": "cpu",
            "VOICE_VAD_AGGRESSIVENESS": "3",
            "VOICE_VAD_SILENCE_MS": "500",
            "VOICE_NO_SPEECH_THRESHOLD": "0.4",
            "VOICE_LOGPROB_THRESHOLD": "-1.5",
            "PICOVOICE_ACCESS_KEY": "abc123",
        })
        self.assertEqual(c.whisper_device, "cpu")
        self.assertEqual(c.vad_aggressiveness, 3)
        self.assertEqual(c.vad_silence_ms, 500)
        self.assertEqual(c.whisper_no_speech_threshold, 0.4)
        self.assertEqual(c.whisper_logprob_threshold, -1.5)
        self.assertEqual(c.picovoice_access_key, "abc123")


if __name__ == "__main__":
    unittest.main(verbosity=2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python voice-service/tests/test_config.py -v`
Expected: FAIL — `AttributeError: ... 'whisper_device'`.

- [ ] **Step 3: Add fields to `VoiceConfig` and `load_config`**

In the `@dataclass`, change `whisper_model` default from `"base"` to `"large-v3"`, and add after
`whisper_compute_type`:

```python
    whisper_device: str = "cuda"
    vad_aggressiveness: int = 2
    vad_silence_ms: int = 800
    whisper_no_speech_threshold: float = 0.6
    whisper_logprob_threshold: float = -1.0
    picovoice_access_key: str = ""
```

Also change its `whisper_model` read default to `"large-v3"`
(`whisper_model=env.get("WHISPER_MODEL", "large-v3")`). In `load_config(...)` add the matching
reads:

```python
        whisper_device=env.get("WHISPER_DEVICE", "cuda"),
        vad_aggressiveness=int(env.get("VOICE_VAD_AGGRESSIVENESS", "2")),
        vad_silence_ms=int(env.get("VOICE_VAD_SILENCE_MS", "800")),
        whisper_no_speech_threshold=float(env.get("VOICE_NO_SPEECH_THRESHOLD", "0.6")),
        whisper_logprob_threshold=float(env.get("VOICE_LOGPROB_THRESHOLD", "-1.0")),
        picovoice_access_key=env.get("PICOVOICE_ACCESS_KEY", ""),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python voice-service/tests/test_config.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add voice-service/config.py voice-service/tests/test_config.py
git commit -m "voice: config fields for GPU whisper, VAD, picovoice"
```

---

## Task 4: `WhisperSTT` class + `build_stt` wiring

`WhisperSTT.listen()` composes the recorder + model + guard. The recorder and model are
injectable so `listen()` is tested with fakes (no GPU, no mic). `build_stt` routes the
`whisper` backend to it.

**Files:**
- Modify: `voice-service/stt.py`
- Test: `voice-service/tests/test_whisper.py`

- [ ] **Step 1: Write the failing test**

Append to `voice-service/tests/test_whisper.py`:

```python
from stt import WhisperSTT, STOP


class FakeConfig:
    vad_aggressiveness = 2
    vad_silence_ms = 800
    sample_rate = 16000
    record_seconds = 4.0
    whisper_no_speech_threshold = 0.6
    whisper_logprob_threshold = -1.0


class FakeModel:
    def __init__(self, segments):
        self._segments = segments
        self.calls = []

    def transcribe(self, path, **kw):
        self.calls.append(path)
        return iter(self._segments), object()


def make_stt(segments, pcm):
    stt = WhisperSTT(FakeConfig(), model=FakeModel(segments),
                     recorder=lambda a, b: pcm)
    return stt


class WhisperSTTListenTest(unittest.TestCase):
    def test_silence_returns_none(self):
        stt = make_stt([], pcm=None)
        self.assertIsNone(stt.listen(5.0, 12.0))

    def test_command_returns_lowercased_text(self):
        stt = make_stt([Seg(" Turn off the tubelight.")], pcm=b"\x00" * 960)
        self.assertEqual(stt.listen(5.0, 12.0), "turn off the tubelight")

    def test_filtered_segments_return_empty_miss(self):
        stt = make_stt([Seg(" Thank you.", no_speech_prob=0.95)], pcm=b"\x00" * 960)
        self.assertEqual(stt.listen(5.0, 12.0), "")

    def test_stop_phrase_returns_stop_sentinel(self):
        stt = make_stt([Seg(" Stop.")], pcm=b"\x00" * 960)
        self.assertIs(stt.listen(5.0, 12.0), STOP)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: FAIL — `cannot import name 'WhisperSTT'`.

- [ ] **Step 3: Implement `WhisperSTT` and `ArecordVadRecorder` in `stt.py`**

Add a module-level helper to strip surrounding punctuation, then the recorder and class:

```python
import wave

_PUNCT_STRIP = ".,!?;: "


class ArecordVadRecorder:
    """Default recorder: arecord raw stream -> webrtcvad endpointing -> PCM bytes."""

    def __init__(self, config):
        import webrtcvad

        self._vad = webrtcvad.Vad(config.vad_aggressiveness)
        self.sample_rate = config.sample_rate
        self.vad_silence_ms = config.vad_silence_ms
        self.frame_bytes = int(self.sample_rate * 0.03) * 2  # 30ms mono S16_LE

    def _is_speech(self, frame):
        return len(frame) == self.frame_bytes and self._vad.is_speech(frame, self.sample_rate)

    def _frames(self, proc):
        while True:
            chunk = proc.stdout.read(self.frame_bytes)
            if len(chunk) < self.frame_bytes:
                return
            yield chunk

    def __call__(self, max_initial_silence, max_utterance):
        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        try:
            return capture_utterance(
                self._frames(proc), self._is_speech,
                sample_rate=self.sample_rate, frame_ms=30,
                max_initial_silence=max_initial_silence,
                vad_silence_ms=self.vad_silence_ms,
                max_utterance=max_utterance,
            )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()


class WhisperSTT:
    def __init__(self, config, vocab=None, model=None, recorder=None):
        self.config = config
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self.no_speech_threshold = config.whisper_no_speech_threshold
        self.logprob_threshold = config.whisper_logprob_threshold
        if model is None:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                getattr(config, "whisper_model", "large-v3"),
                device=getattr(config, "whisper_device", "cuda"),
                compute_type=getattr(config, "whisper_compute_type", "int8"),
            )
        self.model = model
        self.recorder = recorder or ArecordVadRecorder(config)

    def listen(self, max_initial_silence=5.0, max_utterance=12.0):
        pcm = self.recorder(max_initial_silence, max_utterance)
        if not pcm:
            _debug("silence (no speech)")
            return None
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            with wave.open(str(path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.sample_rate)
                wf.writeframes(pcm)
            segments, _info = self.model.transcribe(
                str(path), language="en", beam_size=5,
                vad_filter=True, condition_on_previous_text=False,
            )
            text = whisper_transcript(
                segments,
                no_speech_threshold=self.no_speech_threshold,
                logprob_threshold=self.logprob_threshold,
            )
        finally:
            path.unlink(missing_ok=True)
        if not text:
            _debug("REJECT empty/low-confidence transcript")
            return ""
        norm = text.lower().strip(_PUNCT_STRIP)
        if norm in STOP_PHRASES:
            _debug(f"STOP heard={norm!r}")
            return STOP
        _debug(f"ACCEPT {norm!r}")
        return norm

    def transcribe(self):
        return self.listen(max_initial_silence=self.record_seconds)
```

- [ ] **Step 4: Route `build_stt` to `WhisperSTT`**

Replace the `whisper` branch in `build_stt`:

```python
    if config.stt_backend == "whisper":
        return WhisperSTT(config, vocab=vocab)
```

Delete the old `FasterWhisperSTT` class (superseded by `WhisperSTT`, which covers `device="cpu"`
via `whisper_device`). Confirm no other references: `grep -rn FasterWhisperSTT voice-service`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python voice-service/tests/test_whisper.py -v`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add voice-service/stt.py voice-service/tests/test_whisper.py
git commit -m "voice: WhisperSTT GPU open-vocab backend with VAD recorder"
```

---

## Task 5: `PorcupineWakeListener` + `build_wake_listener` branch

**Files:**
- Modify: `voice-service/wakeword.py`
- Test: `voice-service/tests/test_wakeword.py`

- [ ] **Step 1: Write the failing test**

Create `voice-service/tests/test_wakeword.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wakeword import PorcupineWakeListener


class FakePorcupine:
    frame_length = 512
    sample_rate = 16000

    def __init__(self, hits):
        self._hits = list(hits)  # e.g. [-1, -1, 0] -> wake on the 3rd frame

    def process(self, frame):
        return self._hits.pop(0) if self._hits else -1


class FakeStream:
    """Yields enough raw bytes for N frames, then EOF."""

    def __init__(self, n_frames, frame_length=512):
        self._data = b"\x00\x00" * frame_length * n_frames
        self._pos = 0

    def read(self, n):
        chunk = self._data[self._pos:self._pos + n]
        self._pos += n
        return chunk


class FakeReporter:
    def __init__(self):
        self.events = []

    def emit(self, name, **kw):
        self.events.append((name, kw))


class PorcupineWakeTest(unittest.TestCase):
    def test_wakes_on_keyword_hit(self):
        reporter = FakeReporter()
        listener = PorcupineWakeListener(
            porcupine=FakePorcupine([-1, -1, 0]),
            reporter=reporter,
            stream_factory=lambda: FakeStream(5),
        )
        self.assertTrue(listener.wait())
        self.assertIn("awake", [n for n, _ in reporter.events])

    def test_returns_false_on_stream_eof_without_hit(self):
        listener = PorcupineWakeListener(
            porcupine=FakePorcupine([-1, -1, -1]),
            stream_factory=lambda: FakeStream(3),
        )
        self.assertFalse(listener.wait())


if __name__ == "__main__":
    unittest.main(verbosity=2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python voice-service/tests/test_wakeword.py -v`
Expected: FAIL — `cannot import name 'PorcupineWakeListener'`.

- [ ] **Step 3: Implement `PorcupineWakeListener` in `wakeword.py`**

Add `import struct` at the top of the file (alongside the existing imports), then the class:

```python
class PorcupineWakeListener:
    """Wake on Porcupine's built-in 'jarvis' keyword. Binary detect (no score bar)."""

    def __init__(self, access_key=None, sample_rate=16000, reporter=None,
                 porcupine=None, stream_factory=None):
        if porcupine is None:
            import pvporcupine

            porcupine = pvporcupine.create(access_key=access_key, keywords=["jarvis"])
        self.porcupine = porcupine
        self.frame_length = porcupine.frame_length
        self.sample_rate = getattr(porcupine, "sample_rate", sample_rate)
        self.reporter = reporter
        self._stream_factory = stream_factory or self._default_stream

    def _default_stream(self):
        self._proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        return self._proc.stdout

    def wait(self):
        self._proc = None
        stream = self._stream_factory()
        frame_bytes = self.frame_length * 2
        try:
            while True:
                raw = stream.read(frame_bytes)
                if len(raw) < frame_bytes:
                    return False
                pcm = struct.unpack_from("<%dh" % self.frame_length, raw)
                if self.porcupine.process(pcm) >= 0:
                    if self.reporter is not None:
                        self.reporter.emit("awake")
                    return True
        finally:
            proc = getattr(self, "_proc", None)
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    proc.kill()
```

- [ ] **Step 4: Add the `porcupine` branch to `build_wake_listener`**

In `build_wake_listener`, before the `openwakeword` branch:

```python
    if config.wake_backend == "porcupine":
        return PorcupineWakeListener(
            access_key=config.picovoice_access_key,
            sample_rate=config.sample_rate,
            reporter=reporter,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python voice-service/tests/test_wakeword.py -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add voice-service/wakeword.py voice-service/tests/test_wakeword.py
git commit -m "voice: PorcupineWakeListener for bare 'jarvis' wake word"
```

---

## Task 6: Requirements, runner, and env defaults

**Files:**
- Modify: `voice-service/requirements.txt`, `voice-service/run-full.sh`, `.env.example`

- [ ] **Step 1: Add `pvporcupine` to requirements**

Append to `voice-service/requirements.txt`:

```
pvporcupine==3.0.5
```

- [ ] **Step 2: Update `run-full.sh` defaults + CUDA library path**

Replace the export block in `voice-service/run-full.sh` so the defaults are GPU/whisper/porcupine
and CTranslate2 can find the CUDA-12 runtime wheels:

```bash
export ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3000}"
export VOICE_WAKE_BACKEND="${VOICE_WAKE_BACKEND:-porcupine}"
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
export WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
export WHISPER_DEVICE="${WHISPER_DEVICE:-cuda}"
export WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-int8}"
export VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-piper}"
export PIPER_COMMAND="${PIPER_COMMAND:-.venv/bin/piper}"
export PIPER_VOICE="${PIPER_VOICE:-voice-service/models/en_US-lessac-medium.onnx}"
export AUDIO_PLAYER="${AUDIO_PLAYER:-aplay}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"

# CTranslate2 (faster-whisper GPU) needs the pip-installed CUDA-12 runtime libs on the path.
CUDA_LIBS="$(.venv/bin/python - <<'PY'
import os
paths = []
for mod in ("nvidia.cublas.lib", "nvidia.cudnn.lib"):
    try:
        m = __import__(mod, fromlist=["__file__"])
        paths.append(os.path.dirname(m.__file__))
    except Exception:
        pass
print(":".join(paths))
PY
)"
export LD_LIBRARY_PATH="${CUDA_LIBS}:${LD_LIBRARY_PATH:-}"
```

(Leave the trailing `exec .venv/bin/python voice-service/main.py "$@"` line as-is.)

- [ ] **Step 3: Update `.env.example`**

Add to `.env.example`:

```
# Wake word (Porcupine "jarvis"): get a free key at https://console.picovoice.ai
PICOVOICE_ACCESS_KEY=
VOICE_WAKE_BACKEND=porcupine
# STT: GPU faster-whisper, open vocabulary
VOICE_STT_BACKEND=whisper
WHISPER_MODEL=large-v3
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=int8
VOICE_VAD_AGGRESSIVENESS=2
VOICE_VAD_SILENCE_MS=800
VOICE_NO_SPEECH_THRESHOLD=0.6
VOICE_LOGPROB_THRESHOLD=-1.0
```

- [ ] **Step 4: Commit**

```bash
git add voice-service/requirements.txt voice-service/run-full.sh .env.example
git commit -m "voice: GPU whisper + porcupine defaults in runner, requirements, env"
```

---

## Task 7: Install the Python stack on the GPU host (environment, not TDD)

This task installs into the repo `.venv` and verifies CUDA actually loads. It is the spec's
primary risk (§5); do not declare success until `device="cuda"` loads a model.

**Files:** none (environment).

- [ ] **Step 1: Install voice deps + CUDA runtime wheels**

```bash
.venv/bin/pip install -r voice-service/requirements.txt
.venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

- [ ] **Step 2: Verify imports**

```bash
.venv/bin/python -c "import faster_whisper, webrtcvad, pvporcupine, openwakeword; print('imports ok')"
```
Expected: `imports ok`.

- [ ] **Step 3: Verify GPU model load (the risk gate)**

```bash
CUDA_LIBS="$(.venv/bin/python - <<'PY'
import os
for mod in ("nvidia.cublas.lib","nvidia.cudnn.lib"):
    m=__import__(mod,fromlist=["__file__"]); print(os.path.dirname(m.__file__))
PY
)"
LD_LIBRARY_PATH="$(echo "$CUDA_LIBS" | tr '\n' ':')$LD_LIBRARY_PATH" \
  .venv/bin/python -c "from faster_whisper import WhisperModel; m=WhisperModel('large-v3', device='cuda', compute_type='int8'); print('cuda model loaded')"
```
Expected: model downloads on first run, then `cuda model loaded`. While it loads, `nvidia-smi`
in another shell shows a python process resident.
**If it fails:** follow spec §5 fallback ladder — confirm the `nvidia-*-cu12` wheels are on
`LD_LIBRARY_PATH`, then try `compute_type=int8_float16`, then `float16`, then `device=cpu` as a
last resort. Record which worked.

- [ ] **Step 4: Verify Porcupine key (requires the user's free key in `.env`)**

```bash
.venv/bin/python -c "import os,pvporcupine; pvporcupine.create(access_key=os.environ['PICOVOICE_ACCESS_KEY'], keywords=['jarvis']); print('porcupine ok')"
```
Expected: `porcupine ok`. (If `PICOVOICE_ACCESS_KEY` is unset, this is the one user action —
pause and ask the user to add it to `.env`.)

- [ ] **Step 5: Commit any captured fallback changes**

If Step 3 required a non-default `compute_type`, update `run-full.sh`/`.env.example` defaults and:

```bash
git add -A && git commit -m "voice: pin working CUDA compute_type for this host"
```
(If no change was needed, skip — nothing to commit.)

---

## Task 8: Full-suite green + end-to-end verification

**Files:** none (verification); may touch `CHECKPOINT.md`.

- [ ] **Step 1: Run the whole voice test suite**

```bash
( cd voice-service/tests && ../../.venv/bin/python -m unittest discover -s . -p 'test_*.py' )
```
Expected: OK, all tests pass (existing Vosk/main/grammar/reporter/orchestrator tests + the 3 new
files).

- [ ] **Step 2: Run the orchestrator test suite (no regressions)**

```bash
npm test
```
Expected: all Node tests pass.

- [ ] **Step 3: End-to-end on the box (manual, with mic + orchestrator running)**

Start the orchestrator (`npm start`) and the voice service (`voice-service/run-full.sh`). Then:
1. Say **"jarvis"** (bare) — confirm Porcupine wakes (console "awake").
2. "turn off the tubelight" — relay at `192.168.0.202` flips; Jarvis speaks confirmation.
3. A free-form phrase that the old Vosk grammar could not produce — confirm Whisper transcribes
   it accurately and the orchestrator (via Gemini) acts or declines gracefully.
4. Stay silent after wake — confirm it re-arms (no hang). Make noise — confirm "didn't catch
   that" without an infinite loop.
5. `nvidia-smi` during a command shows the python process on the GPU.

- [ ] **Step 4: Update CHECKPOINT.md**

Add a TL;DR bullet recording the STT swap (GPU large-v3 open-vocab, Vosk now fallback) and the
Porcupine "jarvis" wake word, and note the working `compute_type` for this host. Commit:

```bash
git add CHECKPOINT.md && git commit -m "checkpoint: GPU whisper open-vocab STT + porcupine wake"
```

- [ ] **Step 5: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide merge/PR/cleanup for
`gpu-whisper-stt`.
