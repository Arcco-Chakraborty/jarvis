import os
from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceConfig:
    orchestrator_url: str = "http://localhost:3000"
    wake_word: str = "jarvis"
    wake_backend: str = "manual"
    wake_threshold: float = 0.5
    wake_model_path: str = ""
    stt_backend: str = "manual"
    tts_backend: str = "console"
    record_seconds: float = 4.0
    sample_rate: int = 16000
    whisper_model: str = "base"
    whisper_compute_type: str = "int8"
    piper_command: str = "piper"
    piper_voice: str = ""
    piper_output_device: str = ""
    audio_player: str = "aplay"
    vosk_model_path: str = "voice-service/models/vosk-model-small-en-us-0.15"
    request_timeout_s: float = 5.0
    followup_seconds: float = 5.0
    max_utterance_seconds: float = 12.0


def load_config(env=os.environ):
    return VoiceConfig(
        orchestrator_url=env.get("ORCHESTRATOR_URL", "http://localhost:3000").rstrip("/"),
        wake_word=env.get("VOICE_WAKE_WORD", "jarvis"),
        wake_backend=env.get("VOICE_WAKE_BACKEND", "manual"),
        wake_threshold=float(env.get("VOICE_WAKE_THRESHOLD", "0.5")),
        wake_model_path=env.get("VOICE_WAKE_MODEL", ""),
        stt_backend=env.get("VOICE_STT_BACKEND", "manual"),
        tts_backend=env.get("VOICE_TTS_BACKEND", "console"),
        record_seconds=float(env.get("VOICE_RECORD_SECONDS", "4")),
        sample_rate=int(env.get("VOICE_SAMPLE_RATE", "16000")),
        whisper_model=env.get("WHISPER_MODEL", "base"),
        whisper_compute_type=env.get("WHISPER_COMPUTE_TYPE", "int8"),
        piper_command=env.get("PIPER_COMMAND", "piper"),
        piper_voice=env.get("PIPER_VOICE", ""),
        piper_output_device=env.get("PIPER_OUTPUT_DEVICE", ""),
        audio_player=env.get("AUDIO_PLAYER", "aplay"),
        vosk_model_path=env.get("VOSK_MODEL_PATH", "voice-service/models/vosk-model-small-en-us-0.15"),
        request_timeout_s=float(env.get("VOICE_REQUEST_TIMEOUT_S", "5")),
        followup_seconds=float(env.get("VOICE_FOLLOWUP_SECONDS", "5")),
        max_utterance_seconds=float(env.get("VOICE_MAX_UTTERANCE_SECONDS", "12")),
    )
