import subprocess
import tempfile
from pathlib import Path


class ConsoleTTS:
    def speak(self, text):
        print(f"JARVIS: {text}")


class PiperTTS:
    def __init__(self, command="piper", voice="", output_device="", audio_player="aplay"):
        self.command = command
        self.voice = voice
        self.output_device = output_device
        self.audio_player = audio_player

    def speak(self, text):
        if not self.voice:
            raise RuntimeError("PIPER_VOICE is required for VOICE_TTS_BACKEND=piper")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            subprocess.run(
                [self.command, "--model", self.voice, "--output-file", str(path)],
                input=text.encode("utf-8"),
                check=True,
            )
            player = [self.audio_player, "-q", str(path)]
            if self.output_device:
                player = [self.audio_player, "-q", "-D", self.output_device, str(path)]
            subprocess.run(player, check=True)
        finally:
            path.unlink(missing_ok=True)


def build_tts(config):
    if config.tts_backend == "piper":
        return PiperTTS(
            config.piper_command,
            config.piper_voice,
            config.piper_output_device,
            config.audio_player,
        )
    return ConsoleTTS()
