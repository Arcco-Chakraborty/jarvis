# JARVIS Phase 2 Voice Service Implementation Plan

**Goal:** Build the first runnable voice-service slice: command text -> orchestrator -> spoken
response, with module boundaries ready for wake word, faster-whisper STT, and Piper TTS.

**Spec:** `docs/superpowers/specs/2026-05-28-jarvis-phase2-voice-design.md`

## Tasks

- [x] Create Phase 2 design/spec note.
- [x] Add dependency-free Python config and orchestrator HTTP client.
- [x] Add TTS, wake word, and STT placeholders with real backend seams.
- [x] Add `main.py` with `--once` smoke mode and manual interactive loop.
- [x] Add stdlib unit tests for dispatch, failure handling, and runner behavior.
- [x] Run tests and a safe live smoke command against the orchestrator.

## Deferred

- Install Python audio dependency toolchain (`pip`/venv, PortAudio, faster-whisper, Piper).
- Implement real microphone capture and silence/VAD stop condition.
- Implement openWakeWord/Porcupine adapter.
- Package a systemd unit after the real backend command line is stable.

