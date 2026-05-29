#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3000}"
export VOICE_WAKE_BACKEND="${VOICE_WAKE_BACKEND:-openwakeword}"
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
export VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-piper}"
export VOICE_RECORD_SECONDS="${VOICE_RECORD_SECONDS:-4}"
export WHISPER_MODEL="${WHISPER_MODEL:-medium.en}"
export WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-int8}"
export PIPER_COMMAND="${PIPER_COMMAND:-.venv/bin/piper}"
export PIPER_VOICE="${PIPER_VOICE:-voice-service/models/en_US-lessac-medium.onnx}"
export AUDIO_PLAYER="${AUDIO_PLAYER:-aplay}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"

exec .venv/bin/python voice-service/main.py "$@"
