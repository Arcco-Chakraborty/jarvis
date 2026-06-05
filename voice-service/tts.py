import subprocess
import tempfile
from pathlib import Path


class ConsoleTTS:
    def speak(self, text):
        print(f"JARVIS: {text}")


class PiperTTS:
    def __init__(
        self,
        command="piper",
        voice="",
        output_device="",
        audio_player="aplay",
        length_scale=0.8,
        sentence_silence=0.15,
        runner=subprocess.run,
    ):
        self.command = command
        self.voice = voice
        self.output_device = output_device
        self.audio_player = audio_player
        # length_scale < 1.0 speeds up speech; sentence_silence trims the gap
        # between sentences. Tuned for a crisp, JARVIS-like delivery.
        self.length_scale = length_scale
        self.sentence_silence = sentence_silence
        self.runner = runner

    def speak(self, text):
        if not self.voice:
            raise RuntimeError("PIPER_VOICE is required for VOICE_TTS_BACKEND=piper")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            self.runner(
                [
                    self.command,
                    "--model", self.voice,
                    "--length-scale", str(self.length_scale),
                    "--sentence-silence", str(self.sentence_silence),
                    "--output-file", str(path),
                ],
                input=text.encode("utf-8"),
                check=True,
            )
            player = [self.audio_player, "-q", str(path)]
            if self.output_device:
                player = [self.audio_player, "-q", "-D", self.output_device, str(path)]
            self.runner(player, check=True)
        finally:
            path.unlink(missing_ok=True)


def build_tts(config):
    if config.tts_backend == "piper":
        return PiperTTS(
            config.piper_command,
            config.piper_voice,
            config.piper_output_device,
            config.audio_player,
            config.piper_length_scale,
            config.piper_sentence_silence,
        )
    return ConsoleTTS()
