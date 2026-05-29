import json
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


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


def fetch_vocab(orchestrator_url, opener=urlopen):
    """GET {url}/vocab -> {deviceNames, groupNames}; empty vocab on any failure."""
    try:
        with opener(orchestrator_url.rstrip("/") + "/vocab", timeout=5) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception:
        return {"deviceNames": [], "groupNames": []}


def utterance_text_conf(result):
    """Vosk Result JSON dict -> (text, mean word confidence)."""
    words = result.get("result") or []
    text = (result.get("text") or "").strip()
    if words:
        return text, sum(float(w.get("conf", 0.0)) for w in words) / len(words)
    return text, (1.0 if text else 0.0)


class VoskSTT:
    def __init__(self, config, vocab=None):
        from vosk import Model, KaldiRecognizer
        from grammar import build_grammar

        self._KaldiRecognizer = KaldiRecognizer
        if vocab is None:
            vocab = fetch_vocab(config.orchestrator_url)
        self.phrases, self.spoken_to_name = build_grammar(vocab)
        self.model = Model(config.vosk_model_path)
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self._grammar = json.dumps(self.phrases + ["[unk]"])

    def listen(self, max_initial_silence=5.0, max_utterance=12.0):
        from grammar import normalize_transcript

        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        rec = self._KaldiRecognizer(self.model, self.sample_rate, self._grammar)
        text = ""
        started = False
        t0 = time.monotonic()
        try:
            while True:
                chunk = proc.stdout.read(4000)
                if not chunk:
                    break
                if rec.AcceptWaveform(chunk):
                    text = json.loads(rec.Result()).get("text", "")
                    break
                if json.loads(rec.PartialResult()).get("partial"):
                    started = True
                elapsed = time.monotonic() - t0
                if not started and elapsed >= max_initial_silence:
                    break
                if elapsed >= max_utterance:
                    text = json.loads(rec.FinalResult()).get("text", "")
                    break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        text = (text or "").strip()
        if not text or text == "[unk]":
            return ""
        return normalize_transcript(text, self.spoken_to_name)

    def transcribe(self):
        return self.listen(max_initial_silence=self.record_seconds)


def build_stt(config, vocab=None):
    if config.stt_backend == "vosk":
        return VoskSTT(config, vocab=vocab)
    if config.stt_backend == "whisper":
        return FasterWhisperSTT(
            model_name=config.whisper_model,
            compute_type=config.whisper_compute_type,
            record_seconds=config.record_seconds,
            sample_rate=config.sample_rate,
        )
    return ManualTextInput()
