import subprocess
import tempfile
from pathlib import Path


class ManualTextInput:
    def transcribe(self):
        try:
            return input("You: ").strip()
        except EOFError:
            return ""


class FasterWhisperSTT:
    def __init__(self, model_name="base", compute_type="int8", record_seconds=4.0, sample_rate=16000):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model_name, device="cpu", compute_type=compute_type)
        self.record_seconds = record_seconds
        self.sample_rate = sample_rate

    def transcribe(self):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            subprocess.run(
                [
                    "arecord",
                    "-q",
                    "-r",
                    str(self.sample_rate),
                    "-c",
                    "1",
                    "-f",
                    "S16_LE",
                    "-d",
                    str(int(self.record_seconds)),
                    str(path),
                ],
                check=True,
            )
            segments, _info = self.model.transcribe(
                str(path),
                language="en",
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            return " ".join(segment.text.strip() for segment in segments).strip()
        finally:
            path.unlink(missing_ok=True)


def build_stt(config):
    if config.stt_backend == "whisper":
        return FasterWhisperSTT(
            model_name=config.whisper_model,
            compute_type=config.whisper_compute_type,
            record_seconds=config.record_seconds,
            sample_rate=config.sample_rate,
        )
    return ManualTextInput()
