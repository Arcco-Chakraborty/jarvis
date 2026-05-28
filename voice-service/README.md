# JARVIS Voice Service

Phase 2 Python service. It can run in manual mode or with the local audio stack.

Run a safe one-shot command:

```bash
python3 voice-service/main.py --once "is the tubelight on?"
```

Run the manual loop:

```bash
python3 voice-service/main.py
```

Environment:

- `ORCHESTRATOR_URL`, default `http://localhost:3000`
- `VOICE_WAKE_WORD`, default `jarvis`
- `VOICE_WAKE_BACKEND`, default `manual`; set `openwakeword` for local wake word
- `VOICE_WAKE_MODEL`, optional path; defaults to bundled `hey_jarvis_v0.1.onnx`
- `VOICE_WAKE_THRESHOLD`, default `0.5`
- `VOICE_STT_BACKEND`, default `manual`; set `whisper` for faster-whisper
- `VOICE_TTS_BACKEND`, default `console`; set `piper` for spoken output
- `VOICE_RECORD_SECONDS`, default `4`
- `WHISPER_MODEL`, default `base`
- `PIPER_COMMAND`, `PIPER_VOICE`, `PIPER_OUTPUT_DEVICE`, `AUDIO_PLAYER`

Example full local stack:

```bash
voice-service/run-full.sh
```

Use `VOICE_RECORD_SECONDS=6 voice-service/run-full.sh` if commands are getting clipped.
