# JARVIS — Phase 2 Voice Service Design

**Date:** 2026-05-28
**Scope:** Start the Python voice service from PROJECT.md §5.4 without coupling it to switch
knowledge. The service owns audio/text movement only: wake -> transcript -> orchestrator -> speech.

## Goal

Build a testable Python service that can already dispatch command text to the orchestrator, speak
the returned sentence, and provide extension points for the real local audio stack:

- wake word: openWakeWord or Porcupine
- STT: faster-whisper
- TTS: Piper

The first runnable slice uses a manual text-input loop and console TTS so it works on this host
before audio dependencies are installed. Real microphone/STT/TTS backends can replace those modules
without changing dispatch or orchestration flow.

## Boundaries

- The voice service must not know device names, groups, relay channels, or PC targets.
- It POSTs `{ "text": transcript }` to `ORCHESTRATOR_URL/command`.
- It speaks the response's `speak` field regardless of `ok`.
- It handles network failures with a local fallback sentence instead of crashing.
- No broker, no WebSocket bus, no cloud STT/TTS.

## Initial Modules

- `config.py` reads env vars:
  - `ORCHESTRATOR_URL`, default `http://localhost:3000`
  - `VOICE_WAKE_WORD`, default `jarvis`
  - `VOICE_TTS_BACKEND`, default `console`
  - optional Piper command/voice/output-device fields for later
- `orchestrator.py` owns HTTP dispatch with stdlib `urllib`.
- `tts.py` provides `ConsoleTTS` now and `PiperTTS` command wrapper for later.
- `wakeword.py` provides a manual listener placeholder.
- `stt.py` provides manual text input placeholder.
- `main.py` wires the loop and supports `--once "text"` for smoke testing.

## Acceptance

- Unit tests run with stdlib `unittest` and no network.
- `python3 -m unittest discover -s voice-service/tests` passes.
- With the Node orchestrator running, `python3 voice-service/main.py --once "is the tubelight on?"`
  dispatches to `/command` and prints/speaks the returned sentence.
- The service can be run interactively with `python3 voice-service/main.py`, where each typed line
  acts as a spoken command after wake word detection.

