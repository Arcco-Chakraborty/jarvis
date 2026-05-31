#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

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

exec .venv/bin/python voice-service/main.py "$@"
