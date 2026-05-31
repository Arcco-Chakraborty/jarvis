# JARVIS — GPU Whisper STT + Open-Vocab Voice (design)

**Date:** 2026-05-31
**Status:** implemented
**Supersedes (operationally):** the Vosk grammar-constrained STT default. Vosk code is
kept as a selectable fallback, not deleted.

> **Update (2026-05-31, during implementation):** §4.2's Porcupine "jarvis" wake word was
> **reverted**. Picovoice requires a (free) account the user could not create, so the wake
> word stays **openWakeWord `hey_jarvis`** (bundled, fully local, no account). The
> `PorcupineWakeListener`, its test, the `pvporcupine` dependency, and the
> `picovoice_access_key` config field were removed. Everything else in this spec (GPU
> open-vocab Whisper STT) was implemented as designed.

---

## 1. Motivation

The project previously moved *away* from free-form `faster-whisper` to grammar-constrained
Vosk because Whisper hallucinated on the short, fixed command set on a CPU-only laptop. The
new host has an **NVIDIA GTX 1650 SUPER (4GB, driver 595 / CUDA 13.2)**. With a GPU we can run
a large, accurate model fast enough for a command assistant, and the goal has shifted:

**Open-vocabulary freedom.** The user wants to speak naturally — not just the fixed command
phrases — and let the orchestrator's existing Gemini fallback parse free-form intent. This
removes the reason for the Vosk grammar lock.

Scope: the **full hands-free loop** on the new PC — wake word → VAD-gated record → GPU Whisper
→ orchestrator (rules → pc → confirm → Gemini) → TTS — reinstalled and working end-to-end.

## 2. What stays the same (load-bearing, do not touch)

- The orchestrator's intent cascade already does free-form Gemini fallback (Phase 4). The
  Node side needs **no changes** for open-vocab; it already returns `intent: null` +
  "Sorry, I didn't catch that." for input it can't classify.
- `run_conversation` in `main.py` is engine-agnostic: it only needs `stt.listen(...)` to
  return `None` (silence → re-arm) / `STOP` / `""` (miss → retry) / `str` (command). It
  already treats a dispatched result whose `intent is None` as a miss, so nonsense
  transcripts bounce cleanly without a vocabulary gate. **The loop is reused unchanged.**
- ESP32 adapter, registry, routing — untouched.

## 3. Approach (selected: A)

**A — New `WhisperGpuSTT` backend with `webrtcvad` endpointing.** Recommended and chosen.
Rejected alternatives: **B** (Vosk-records / Whisper-transcribes — two models, no win) and
**C** (fixed-window record — clips long commands, wastes time on short ones).

## 4. Components

### 4.1 `WhisperSTT` (in `voice-service/stt.py`)

The existing CPU-only `FasterWhisperSTT` is generalized into one device-parameterized
`WhisperSTT` class (default `device="cuda"`) and given a streaming `listen()`. There is one
Whisper class, not two.

- Construct: `faster_whisper.WhisperModel(model, device="cuda", compute_type="int8")`,
  `language="en"`. Defaults: `model="large-v3"`, `device="cuda"`, `compute_type="int8"`
  (≈3GB VRAM; `float16` would overflow alongside the desktop).
- `listen(max_initial_silence, max_utterance)` — same signature/contract as `VoskSTT.listen`:
  1. Open the existing `arecord` raw 16k mono S16_LE stream.
  2. Feed 30ms frames (480 samples at 16k) to `webrtcvad` (aggressiveness configurable).
  3. **Endpointing:** wait for speech onset; if no speech within `max_initial_silence`,
     return `None` (silence → re-arm wake). After onset, accumulate frames until
     `vad_silence_ms` of trailing silence, bounded by `max_utterance`.
  4. Write captured frames to a temp wav; transcribe on the GPU
     (`beam_size=5`, `vad_filter=True`, `condition_on_previous_text=False`).
  5. **Hallucination/noise guard (replaces the vocabulary gate):**
     - no captured speech → `None`
     - empty transcript, or `no_speech_prob` above threshold, or `avg_logprob` below
       threshold → `""` (miss → "didn't catch that", retry)
     - else → return the transcript **verbatim** (open-vocab; no `looks_like_command` /
       `has_target` gating). Validity is decided downstream by orchestrator + Gemini.
  6. `STOP_PHRASES` ("stop" / "cancel" / "never mind") still map to the `STOP` sentinel.
- `transcribe()` delegates to `listen(max_initial_silence=record_seconds)` for `--once`-style
  single-shot use, matching the existing pattern.

**Note on the dropped gate:** `looks_like_command` / `has_target` / `STANDALONE` were Vosk-era
guards against partial grammar output. They are intentionally *not* applied to Whisper output
(they would reject novel phrases). They remain in the file for the Vosk backend.

### 4.2 `PorcupineWakeListener` (new, in `voice-service/wakeword.py`)

- `pvporcupine.create(access_key=..., keywords=["jarvis"])` — built-in "jarvis" keyword,
  true bare-"jarvis" wake (no "hey"). Runs fully offline once keyed.
- `wait()`: read `arecord` raw stream in `porcupine.frame_length` (512-sample) int16 frames;
  `porcupine.process(frame) >= 0` → wake → return True.
- Observability: Porcupine returns a **binary** detect, not openWakeWord's continuous score.
  On detect, emit `reporter.emit("awake")`. The periodic `wake_score` emission (the
  dashboard's score-bar feed) does not apply to Porcupine; the listener simply does not emit
  it. The dashboard's bar will sit idle under this backend — acceptable; a later pass can
  relabel it. openWakeWord backend keeps its score emission.
- `build_wake_listener` gains a `porcupine` branch; `manual` and `openwakeword` stay.

### 4.3 Config (`voice-service/config.py`)

New / changed fields (all env-overridable, defaults in parentheses):
- `whisper_device` (`cuda`) — `WHISPER_DEVICE`
- `whisper_model` default `large-v3` — `WHISPER_MODEL`
- `whisper_compute_type` (`int8`) — `WHISPER_COMPUTE_TYPE` (unchanged name)
- `vad_aggressiveness` (`2`, range 0–3) — `VOICE_VAD_AGGRESSIVENESS`
- `vad_silence_ms` (`800`) — `VOICE_VAD_SILENCE_MS`
- `whisper_no_speech_threshold` (`0.6`) — `VOICE_NO_SPEECH_THRESHOLD`
- `whisper_logprob_threshold` (`-1.0`) — `VOICE_LOGPROB_THRESHOLD`
- `picovoice_access_key` (`""`) — `PICOVOICE_ACCESS_KEY`

`build_stt`: `VOICE_STT_BACKEND=whisper` constructs `WhisperSTT` parameterized by
`whisper_device` (`cuda` default, `cpu` still possible). `vosk` and `manual` backends unchanged.

### 4.4 Runner + env

- `run-full.sh` defaults: `VOICE_WAKE_BACKEND=porcupine`, `VOICE_STT_BACKEND=whisper`,
  `WHISPER_MODEL=large-v3`, `WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=int8`. Keep
  `VOICE_TTS_BACKEND=piper`.
- `.env.example`: add `PICOVOICE_ACCESS_KEY=` and the new voice knobs with comments.

### 4.5 Stack reinstall on the new PC

`requirements.txt` adds `pvporcupine`. Install into the repo `.venv` (py3.12):
`faster-whisper`, `openwakeword`, `piper-tts`, `webrtcvad`, `vosk`, `pvporcupine`, plus the
CUDA-12 runtime wheels CTranslate2 needs for GPU (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`).
Driver 595 / CUDA 13.2 is backward-compatible with the CUDA-12 runtime.

## 5. Risks & fallbacks

- **GPU library loading (primary risk).** faster-whisper-on-CUDA is finicky about cuDNN/cuBLAS
  discovery. Mitigation order if `device="cuda"` fails to load: (1) ensure the `nvidia-*-cu12`
  wheels are installed and on `LD_LIBRARY_PATH`; (2) try `compute_type=int8_float16` /
  `float16`; (3) last resort `device="cpu"` — but GPU options are exhausted first, since GPU
  accuracy is the entire point. Verified, not assumed, before claiming success.
- **VRAM pressure.** 4GB with the desktop already using ~0.8GB. `int8` large-v3 ≈3GB should
  fit; if OOM, fall to `int8_float16` then `medium`.
- **Picovoice key.** Requires one free signup (user action). Until set, `porcupine` backend
  raises a clear error at construction; `manual`/`openwakeword` remain usable.

## 6. Testing

- `WhisperGpuSTT` pure logic tested with injected fakes (a fake VAD + fake model), no GPU:
  - no speech onset within window → `None`
  - speech then trailing silence → calls model, returns transcript verbatim
  - empty / high `no_speech_prob` / low `avg_logprob` → `""`
  - STOP phrase → `STOP`
  - `max_utterance` bound forces termination
- `PorcupineWakeListener` tested with a fake porcupine (process returns -1 then 0) over a fake
  audio stream → `wait()` returns True and emits `awake`.
- Existing voice + orchestrator tests stay green (Vosk path untouched).

## 7. Verification (end-to-end, on the box)

1. `nvidia-smi` shows the python process resident on the GPU during transcription.
2. "jarvis" (bare) reliably wakes via Porcupine.
3. "jarvis, turn off the tubelight" flips the real relay at `192.168.0.202`.
4. A free-form phrase the Vosk grammar could never have produced (e.g. an open request routed
   through Gemini) transcribes accurately and acts.
5. Silence after wake re-arms; noise/gibberish yields "didn't catch that" without spinning.
