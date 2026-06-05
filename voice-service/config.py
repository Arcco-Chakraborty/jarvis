import os
from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceConfig:
    orchestrator_url: str = "http://localhost:3000"
    wake_word: str = "jarvis"
    wake_backend: str = "manual"
    wake_threshold: float = 0.35
    wake_model_path: str = ""
    stt_backend: str = "manual"
    tts_backend: str = "console"
    record_seconds: float = 4.0
    sample_rate: int = 16000
    whisper_model: str = "large-v3"
    whisper_compute_type: str = "int8"
    whisper_device: str = "cuda"
    vad_aggressiveness: int = 2
    vad_silence_ms: int = 600
    whisper_no_speech_threshold: float = 0.6
    whisper_logprob_threshold: float = -1.0
    piper_command: str = "piper"
    piper_voice: str = ""
    piper_output_device: str = ""
    piper_length_scale: float = 0.8
    piper_sentence_silence: float = 0.15
    audio_player: str = "aplay"
    vosk_model_path: str = "voice-service/models/vosk-model-en-us-0.22-lgraph"
    request_timeout_s: float = 30.0
    followup_seconds: float = 5.0
    max_utterance_seconds: float = 12.0
    min_confidence: float = 0.4
    post_conversation_cooldown_s: float = 1.2


def load_config(env=os.environ):
    return VoiceConfig(
        orchestrator_url=env.get("ORCHESTRATOR_URL", "http://localhost:3000").rstrip("/"),
        wake_word=env.get("VOICE_WAKE_WORD", "jarvis"),
        wake_backend=env.get("VOICE_WAKE_BACKEND", "manual"),
        wake_threshold=float(env.get("VOICE_WAKE_THRESHOLD", "0.35")),
        wake_model_path=env.get("VOICE_WAKE_MODEL", ""),
        stt_backend=env.get("VOICE_STT_BACKEND", "manual"),
        tts_backend=env.get("VOICE_TTS_BACKEND", "console"),
        record_seconds=float(env.get("VOICE_RECORD_SECONDS", "4")),
        sample_rate=int(env.get("VOICE_SAMPLE_RATE", "16000")),
        whisper_model=env.get("WHISPER_MODEL", "large-v3"),
        whisper_compute_type=env.get("WHISPER_COMPUTE_TYPE", "int8"),
        whisper_device=env.get("WHISPER_DEVICE", "cuda"),
        vad_aggressiveness=int(env.get("VOICE_VAD_AGGRESSIVENESS", "2")),
        vad_silence_ms=int(env.get("VOICE_VAD_SILENCE_MS", "600")),
        whisper_no_speech_threshold=float(env.get("VOICE_NO_SPEECH_THRESHOLD", "0.6")),
        whisper_logprob_threshold=float(env.get("VOICE_LOGPROB_THRESHOLD", "-1.0")),
        piper_command=env.get("PIPER_COMMAND", "piper"),
        piper_voice=env.get("PIPER_VOICE", ""),
        piper_output_device=env.get("PIPER_OUTPUT_DEVICE", ""),
        piper_length_scale=float(env.get("PIPER_LENGTH_SCALE", "0.8")),
        piper_sentence_silence=float(env.get("PIPER_SENTENCE_SILENCE", "0.15")),
        audio_player=env.get("AUDIO_PLAYER", "aplay"),
        vosk_model_path=env.get("VOSK_MODEL_PATH", "voice-service/models/vosk-model-en-us-0.22-lgraph"),
        request_timeout_s=float(env.get("VOICE_REQUEST_TIMEOUT_S", "30")),
        followup_seconds=float(env.get("VOICE_FOLLOWUP_SECONDS", "5")),
        max_utterance_seconds=float(env.get("VOICE_MAX_UTTERANCE_SECONDS", "12")),
        min_confidence=float(env.get("VOICE_MIN_CONFIDENCE", "0.4")),
        post_conversation_cooldown_s=float(env.get("VOICE_COOLDOWN_S", "1.2")),
    )
