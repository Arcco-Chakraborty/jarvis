# JARVIS — Vosk Grammar STT Design

**Date:** 2026-05-29
**Status:** Approved — ready for implementation planning
**Scope:** Replace free-form Whisper STT (which hallucinated garbage on short/accented commands) with a
**constrained Vosk recognizer** whose grammar is the set of valid JARVIS commands. Voice service only.
**Source of truth:** PROJECT.md. Local-first; orchestrator owns device naming (voice service fetches it).

---

## 1. Goal & rationale

Whisper transcribes *anything* into fluent text, so a short, accented "turn off the tubelight" became
"They're not the Indian." For a **fixed command set**, the reliable approach is constrained
recognition: Vosk decodes audio against a **grammar** (list of valid phrases) and can only output one
of them (or nothing), so it picks the nearest real command instead of inventing a sentence.

**Acceptance:** with `VOICE_STT_BACKEND=vosk`, saying "hey jarvis, turn off the tubelight" yields a
clean transcript ("turn off the tubelight") that the orchestrator parses to `{off, tubelight}` and
flips the relay; gibberish yields an empty transcript → "Sorry, I didn't catch that." Orchestrator
tests stay green (+ a new `/vocab` test).

## 2. Decisions

| Decision | Choice |
|----------|--------|
| Recognizer | **Vosk** (open-source, offline) with a **grammar** built from the command vocabulary |
| Model | `vosk-model-small-en-us-0.15` (~40 MB), in `voice-service/models/` (gitignored) |
| Vocab source | New orchestrator **`GET /vocab`** → `{deviceNames, groupNames}`; voice service builds the grammar from it (orchestrator stays the naming source) |
| Recording | **Fixed-window `arecord`** (reuse existing pattern), then run Vosk on the buffer. (Stream-until-silence is a later upgrade.) |
| Number words | Grammar uses spoken forms ("fan one"); recognized text is normalized back to registry names ("fan 1") before dispatch |
| Whisper | Kept available as `VOICE_STT_BACKEND=whisper`; **default becomes `vosk`** |
| No new orchestrator deps | `/vocab` is a trivial read; `vosk` is a new **Python** dep only |

## 3. Orchestrator: `GET /vocab`

`buildApp` gains an injected `vocab` (`{deviceNames, groupNames}`); `main()` already computes it and
passes it. Route:

```js
app.get('/vocab', (req, res) => {
  res.json(vocab ?? { deviceNames: [], groupNames: [] });
});
```

`main()` passes `vocab` (the existing `{ deviceNames: registry.getSwitchNamesByChannel(), groupNames: registry.getGroupNames().filter(g => g !== 'other') }`). Other routes unchanged.

## 4. Voice service: grammar + `VoskSTT`

### 4.1 Pure grammar builder (`grammar.py`, unit-tested)

`build_grammar(vocab) -> (phrases, spoken_to_name)`:
- For each **device** `d`, spoken form `sd = to_spoken(d)` (`"fan 1"→"fan one"`, `"fan 2"→"fan two"`,
  else unchanged): emit `turn on the {sd}`, `turn off the {sd}`, `{sd} on`, `{sd} off`,
  `is the {sd} on`, `keep the {sd} on rest off`. Record `spoken_to_name[sd] = d`.
- For each **group** `g` (`lights`,`fans`): emit `turn on the {g}`, `turn off the {g}`, `{g} on`,
  `{g} off`, `keep the {g} on rest off`.
- Global: `all off`, `everything off`, `turn everything off`, `turn off everything`.
- Returns the de-duped `phrases` list and the `spoken_to_name` map. These forms match what the
  orchestrator rule matcher already parses.

`normalize_transcript(text, spoken_to_name) -> text`: replace each spoken device form with its
registry name (e.g. "turn off the fan one" → "turn off the fan 1"). Pure; unit-tested.

### 4.2 `VoskSTT` (in `stt.py`)

```python
class VoskSTT:
    def __init__(self, config, vocab=None):
        from vosk import Model, KaldiRecognizer
        vocab = vocab or fetch_vocab(config.orchestrator_url)   # GET /vocab
        self.phrases, self.spoken_to_name = build_grammar(vocab)
        self.model = Model(config.vosk_model_path)
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self._grammar = json.dumps(self.phrases + ["[unk]"])

    def transcribe(self):
        # record fixed window via arecord (same as FasterWhisperSTT), feed buffer to a
        # KaldiRecognizer(self.model, self.sample_rate, self._grammar); take Result()->text;
        # if text is empty or only "[unk]", return "".  Else normalize_transcript(text, map).
```

- `fetch_vocab(url)` does `GET {url}/vocab` via stdlib `urllib`; on failure returns
  `{deviceNames:[], groupNames:[]}` (degrades to an empty grammar → returns "" → "didn't catch that",
  never crashes).
- `build_stt(config, vocab=None)` returns `VoskSTT` when `config.stt_backend == 'vosk'`, `FasterWhisperSTT`
  when `'whisper'`, else `ManualTextInput`.

## 5. Config & launch

- `config.py`: add `vosk_model_path` (env `VOSK_MODEL_PATH`, default
  `voice-service/models/vosk-model-small-en-us-0.15`).
- `run-full.sh`: default `VOICE_STT_BACKEND=vosk` (was `whisper`); export `VOSK_MODEL_PATH`.
- `run-jarvis.sh` inherits via `run-full.sh` (unchanged).
- `requirements.txt`: add `vosk`. Install into the existing `.venv` (`uv pip install vosk`).
- Model: download `vosk-model-small-en-us-0.15.zip` from alphacephei, unzip into `voice-service/models/`.

## 6. Testing

- **Orchestrator `server.test.js`:** `GET /vocab` returns the injected `{deviceNames, groupNames}`;
  tolerates missing `vocab` (returns empty arrays). Existing tests stay green.
- **Voice `test_grammar.py`** (stdlib unittest, no audio/Vosk):
  - `build_grammar` includes `"turn off the fan one"`, `"lights off"`, `"is the tubelight on"`,
    `"everything off"`, `"keep the lights on rest off"`; `spoken_to_name["fan one"] == "fan 1"`.
  - `normalize_transcript("turn off the fan one", map) == "turn off the fan 1"`; a non-fan phrase is
    unchanged.
- **Live smoke:** user runs `run-jarvis.sh` (Vosk), says "hey jarvis" + commands; dashboard shows the
  clean transcript and correct intent. (Vosk decoding itself isn't unit-tested — needs audio.)

## 7. Out of scope

Stream-until-silence endpointing (later), Picovoice Rhino, retraining/custom Vosk models, multi-language,
changing the wake word or TTS. faster-whisper stays as an optional backend (not removed).
