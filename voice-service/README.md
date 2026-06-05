# JARVIS Voice Service

The local audio loop: **wake word → record → speech-to-text → POST `/command` →
speak the response**. It knows nothing about lights or computers — it only moves
audio and text. Wake word, STT, and TTS all run on-device.

Stack: openWakeWord (`hey jarvis`), `faster-whisper` STT (GPU by default), Piper TTS.

## Run

The repo-level launcher starts the orchestrator + this service together (recommended):

```bash
./run-jarvis.sh
```

Or run just the voice loop (expects the orchestrator already up on `localhost:3000`):

```bash
voice-service/run-full.sh
```

Safe one-shot, no microphone (sends one command and exits):

```bash
.venv/bin/python voice-service/main.py --once "is the tubelight on?"
```

`voice-service/diagnose.py` records one utterance and prints the mic level, transcript,
and accept/reject reason — useful when the wake word or recognition needs tuning.

## Key environment variables

Defaults below match `.env.example`; override in `.env`.

| Variable | Default | Notes |
|----------|---------|-------|
| `ORCHESTRATOR_URL` | `http://localhost:3000` | Where to POST commands. |
| `VOICE_WAKE_BACKEND` | `openwakeword` | Bundled `hey_jarvis` model, fully local. |
| `VOICE_WAKE_THRESHOLD` | `0.5` | Lower = easier to trigger. |
| `VOICE_STT_BACKEND` | `whisper` | `faster-whisper`, open vocabulary. `vosk` = offline fallback. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `large-v3` / `cuda` / `int8` | Set `WHISPER_DEVICE=cpu`, `WHISPER_MODEL=base` for no-GPU. |
| `VOICE_TTS_BACKEND` | `piper` | `console` prints instead of speaking. |
| `PIPER_VOICE` | `voice-service/models/en_GB-alan-medium.onnx` | British male, JARVIS-style. |
| `PIPER_LENGTH_SCALE` | `0.8` | Speech pace; `< 1.0` = faster. |
| `AUDIO_PLAYER` | `pw-play` | Command that plays the synthesized WAV (PipeWire; `aplay`/`paplay` also work). |
| `VOICE_RECORD_SECONDS` | `4` | Bump if commands get clipped. |
| `VOICE_REQUEST_TIMEOUT_S` | `30` | Must exceed the slowest orchestrator path (vision Gemini). |

See `voice-service/config.py` for the complete list.
