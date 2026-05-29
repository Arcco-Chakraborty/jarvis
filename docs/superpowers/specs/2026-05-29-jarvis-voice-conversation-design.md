# JARVIS — Conversational Voice Loop Design

**Date:** 2026-05-29
**Status:** Approved — ready for implementation planning
**Scope:** Make the voice loop behave like a real assistant: auto speech-timing (stream + endpoint on
silence) and continued conversation (stay listening for follow-ups after one command). Voice service only.
**Source of truth:** PROJECT.md. Local-first; no new deps (Vosk's built-in endpointing).

---

## 1. Goal

Three fixes the user asked for:
1. **Auto speak-timing** — no fixed 4s window; record exactly as long as the user speaks (stream into
   Vosk, stop the instant it detects end-of-speech).
2. **Stay on for follow-ups** — wake once, then keep taking commands until a short silence, then re-arm
   the wake word (Google "continued conversation").
3. **More reactive/accurate** — streaming endpointing responds the moment you stop talking and stops
   transcribing silence padding; grammar widened with natural phrasings.

**Acceptance:** after "hey jarvis", a command is recognized as soon as you stop speaking (no 4s wait);
you can issue another command without re-waking; ~5s of silence re-arms the wake word; gibberish →
empty → "didn't catch that". Orchestrator 77 tests stay green; voice unit tests cover the turn-taking.

## 2. Decisions

| Decision | Choice |
|----------|--------|
| Endpointing | Vosk **built-in** silence endpointing (`AcceptWaveform(chunk)` returns True at end-of-utterance). No webrtcvad. |
| Capture | Continuous `arecord` raw stream fed in chunks (replaces fixed `-d <secs>` window). |
| Continued conversation | After wake, loop turns; disarm after **`VOICE_FOLLOWUP_SECONDS`** (default **5**) of silence. `0` = one-shot. |
| Guards | Initial-silence timeout (= follow-up window) → `""`; max-utterance cap **`VOICE_MAX_UTTERANCE_SECONDS`** (default 12). |
| Grammar | Widen with `switch on/off the <t>`, `turn the <t> on/off` (device + group). |
| Audio cue | None for v1 (dashboard state badge shows listening). |
| Backends | Conversation/streaming applies to **Vosk**; manual/whisper keep one-shot `transcribe()`. |

## 3. Streaming recognizer (`VoskSTT.listen`)

Add `listen(max_initial_silence, max_utterance)` to `VoskSTT` (keep `transcribe()` delegating to it
with defaults for back-compat):

```
open `arecord -q -r <rate> -c 1 -f S16_LE -t raw` (Popen, stdout=PIPE)
rec = KaldiRecognizer(model, rate, grammar)   # fresh per utterance
started = False ; t0 = monotonic()
loop:
    chunk = proc.stdout.read(4000)             # ~0.125s at 16k/16-bit mono
    if not chunk: break
    if rec.AcceptWaveform(chunk):              # end-of-utterance (silence) detected
        text = Result().text ; break
    else:
        if PartialResult().partial: started = True
        now = monotonic()
        if not started and now - t0 >= max_initial_silence: text = "" ; break
        if now - t0 >= max_utterance: text = FinalResult().text ; break
terminate arecord
text = normalize_transcript(text); return "" if empty/"[unk]" else text
```

This auto-adjusts to how long the user speaks; never blocks longer than `max_utterance`; returns `""`
when there's no speech within `max_initial_silence`.

## 4. Conversation loop

A **pure, testable** turn-taker (in `main.py`):

```python
def run_conversation(listen_fn, handle_fn, followup_seconds, reporter=None):
    while True:
        if reporter: reporter.emit("recording")
        text = listen_fn()
        if not text:
            return                      # silence within the window -> disarm
        if reporter: reporter.emit("transcript", text=text)
        handle_fn(text)
        if followup_seconds <= 0:
            return                      # one-shot mode
```

`run_loop` wiring: after `wake_listener.wait()` → `reporter.emit("awake")` → if the STT supports
streaming (`hasattr(stt, "listen")`), call `run_conversation(listen_fn=lambda: stt.listen(config.followup_seconds, config.max_utterance_seconds), handle_fn=lambda t: handle_text(t, client, speaker), followup_seconds=config.followup_seconds, reporter=reporter)`; else keep the existing single-`transcribe()` behavior. Then `reporter.emit("idle")` and loop back to the wake word.

## 5. Config

`config.py` adds:
- `followup_seconds: float = 5.0` (env `VOICE_FOLLOWUP_SECONDS`)
- `max_utterance_seconds: float = 12.0` (env `VOICE_MAX_UTTERANCE_SECONDS`)

`.env.example` documents both. `run-full.sh`/`run-jarvis.sh` need no change (config defaults apply).

## 6. Grammar widening (`grammar.py`)

In `build_grammar`, additionally emit per device `sd`: `switch on the {sd}`, `switch off the {sd}`,
`turn the {sd} on`, `turn the {sd} off`; per group `g`: `switch on the {g}`, `switch off the {g}`,
`turn the {g} on`, `turn the {g} off`. All still parse via the existing rule matcher (`switch`+`on/off`,
target). De-dupe preserved.

## 7. Testing

- **`test_main.py`** (new `run_conversation` tests, no audio): scripted `listen_fn` returning
  `["turn off the tubelight", "lights on", ""]` → `handle_fn` called twice then returns; with
  `followup_seconds=0` and `["a", "b"]` → called once then returns.
- **`test_grammar.py`**: assert a couple new phrasings present (`"switch off the tubelight"`,
  `"turn the lights on"`).
- **Live smoke (user):** after "hey jarvis", commands are picked up on stop-speaking; a follow-up works
  without re-waking; ~5s silence re-arms.
- `VoskSTT.listen` streaming itself isn't unit-tested (needs audio) — covered by live smoke.

## 8. Out of scope

Audio chime/cue, barge-in (interrupting TTS), wake-word detection *during* a conversation turn, bigger
Vosk model (fallback if accuracy still poor), webrtcvad. No orchestrator/firmware changes.
