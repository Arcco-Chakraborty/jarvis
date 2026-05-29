# JARVIS — Voice Relevance Gating + Spoken Aliases Design

**Date:** 2026-05-29
**Status:** Approved — ready for implementation planning
**Scope:** Voice service only. Fix recognition of non-lexicon device names (tubelight/rgb), and stop
acting on ambient noise / irrelevant speech via confidence gating. Keep the small Vosk model.
**Source of truth:** PROJECT.md. Orchestrator unchanged.

---

## 1. Problems & fixes

1. **"tubelight" (and "rgb light") not recognized.** Vosk decodes only words in the model's lexicon;
   `tubelight` and `rgb` aren't real English words, so the small model has no pronunciation and can't
   hear them. **Fix:** generate grammar phrases with **spoken aliases made of real words** —
   `tubelight → "tube light"`, `rgb light → "r g b light"` — and normalize the recognized text back to
   the registry name before dispatch (same mechanism as `fan 1 → "fan one"`).
2. **Ambient noise / irrelevant speech triggers commands** (both the active recording and the
   continued-conversation follow-ups). Grammar-constrained Vosk can force noise into the nearest valid
   phrase. **Fix:** **confidence gating** — enable Vosk word confidences and only accept an utterance
   whose mean confidence clears `VOICE_MIN_CONFIDENCE` (default 0.6); otherwise return `""` (ignored as
   ambient/irrelevant). Applies to every `listen()` (recording + follow-up turns).
3. **General accuracy.** (1) and (2) help directly. Bigger Vosk model is **deferred** (user chose to
   try the small-model fixes first).

**Acceptance:** saying "turn off the tube light" toggles the tubelight; talking near the mic
(non-command chatter) during a follow-up window does **not** fire a command; `npm test` unaffected
(orchestrator untouched); new voice unit tests pass.

## 2. Spoken aliases (`grammar.py`)

Add `SPOKEN_OVERRIDES = {"tubelight": "tube light", "rgb light": "r g b light"}`. `to_spoken(name)`:
return `SPOKEN_OVERRIDES[name]` if present, else the existing digit→word mapping (`fan 1 → fan one`).
`build_grammar` already records `spoken_to_name[to_spoken(name)] = name`, and `normalize_transcript`
already reverses spoken→registry (longest-first). So the recognized `"turn off the tube light"` becomes
`"turn off the tubelight"` before dispatch, which the orchestrator parses normally.

## 3. Confidence gating (`stt.py`)

- `VoskSTT.__init__`: `self.min_conf = getattr(config, "min_confidence", 0.6)`; call `rec.SetWords(True)`
  on each recognizer so `Result()`/`FinalResult()` include per-word `conf`.
- New pure helper `utterance_text_conf(result)`:
  ```python
  def utterance_text_conf(result):
      words = result.get("result") or []
      text = (result.get("text") or "").strip()
      if words:
          return text, sum(float(w.get("conf", 0.0)) for w in words) / len(words)
      return text, (1.0 if text else 0.0)
  ```
- `listen()` keeps the **parsed result dict** at its break points (endpoint `Result()`, max-utterance
  `FinalResult()`; initial-silence → no result). After the loop:
  ```python
  if not result: return ""
  text, conf = utterance_text_conf(result)
  if not text or text == "[unk]" or conf < self.min_conf: return ""   # ambient / irrelevant
  return normalize_transcript(text, self.spoken_to_name)
  ```

## 4. Config (`config.py`)

Add `min_confidence: float = 0.6` (env `VOICE_MIN_CONFIDENCE`). Document in `.env.example`.
Tuning note: raise it if ambient noise still triggers commands; lower it if real commands get dropped.

## 5. Testing

- **`test_grammar.py`**: `to_spoken("tubelight") == "tube light"`; grammar includes
  `"turn off the tube light"`; `spoken_to_name["tube light"] == "tubelight"`;
  `normalize_transcript("turn off the tube light", map) == "turn off the tubelight"`.
- **`test_stt.py`**: `utterance_text_conf` — high-conf words → (text, high); low-conf → (text, low);
  empty/`[unk]` handled. (The accept/reject threshold is exercised here conceptually; `listen()` itself
  needs audio → live smoke.)
- **Live (user):** "turn off the tube light" works; ambient chatter in the follow-up window is ignored.

## 6. Out of scope

Large Vosk model (deferred), per-turn wake-word requirement, webrtcvad energy gating, orchestrator
changes. faster-whisper backend untouched.
