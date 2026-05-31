#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3000}"
export VOICE_WAKE_BACKEND="${VOICE_WAKE_BACKEND:-openwakeword}"
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
export WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
export WHISPER_DEVICE="${WHISPER_DEVICE:-cuda}"
export WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-int8}"
export VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-piper}"
export PIPER_COMMAND="${PIPER_COMMAND:-.venv/bin/piper}"
export PIPER_VOICE="${PIPER_VOICE:-voice-service/models/en_US-lessac-medium.onnx}"
export AUDIO_PLAYER="${AUDIO_PLAYER:-aplay}"
export VOICE_WAKE_THRESHOLD="${VOICE_WAKE_THRESHOLD:-0.35}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"

# CTranslate2 (faster-whisper GPU) needs the pip-installed CUDA-12 runtime libs on the
# path. The nvidia-*-cu12 wheels are namespace packages (no __file__), so glob the lib
# dirs directly rather than importing them.
CUDA_LIBS="$(ls -d .venv/lib/python*/site-packages/nvidia/*/lib 2>/dev/null | paste -sd:)"
export LD_LIBRARY_PATH="${CUDA_LIBS}:${LD_LIBRARY_PATH:-}"

exec .venv/bin/python voice-service/main.py "$@"
