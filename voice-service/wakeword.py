import struct
import subprocess
import time
from importlib import resources


class ManualWakeListener:
    """Placeholder wake listener: every entered line is treated as after wake word."""

    def wait(self):
        return True


class OpenWakeWordListener:
    def __init__(self, model_path=None, threshold=0.5, sample_rate=16000, reporter=None):
        import numpy as np
        from openwakeword.model import Model

        self.np = np
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.reporter = reporter
        self._last_emit = 0.0
        if model_path is None:
            model_path = str(
                resources.files("openwakeword")
                / "resources"
                / "models"
                / "hey_jarvis_v0.1.onnx"
            )
        kwargs = {"wakeword_model_paths": [model_path]} if model_path else {}
        self.model = Model(**kwargs)

    def wait(self):
        chunk_bytes = 1280 * 2
        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        try:
            while True:
                raw = proc.stdout.read(chunk_bytes)
                if len(raw) < chunk_bytes:
                    return False
                audio = self.np.frombuffer(raw, dtype=self.np.int16)
                scores = self.model.predict(audio)
                top = max(scores.values()) if scores else 0.0
                now = time.monotonic()
                if self.reporter is not None and now - self._last_emit >= 0.33:
                    self._last_emit = now
                    self.reporter.emit("wake_score", score=float(top), threshold=self.threshold)
                if top >= self.threshold:
                    if self.reporter is not None:
                        self.reporter.emit("awake", score=float(top))
                    return True
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()


class PorcupineWakeListener:
    """Wake on Porcupine's built-in 'jarvis' keyword. Binary detect (no score bar)."""

    def __init__(self, access_key=None, sample_rate=16000, reporter=None,
                 porcupine=None, stream_factory=None):
        if porcupine is None:
            import pvporcupine

            porcupine = pvporcupine.create(access_key=access_key, keywords=["jarvis"])
        self.porcupine = porcupine
        self.frame_length = porcupine.frame_length
        self.sample_rate = getattr(porcupine, "sample_rate", sample_rate)
        self.reporter = reporter
        self._stream_factory = stream_factory or self._default_stream

    def _default_stream(self):
        self._proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        return self._proc.stdout

    def wait(self):
        self._proc = None
        stream = self._stream_factory()
        frame_bytes = self.frame_length * 2
        try:
            while True:
                raw = stream.read(frame_bytes)
                if len(raw) < frame_bytes:
                    return False
                pcm = struct.unpack_from("<%dh" % self.frame_length, raw)
                if self.porcupine.process(pcm) >= 0:
                    if self.reporter is not None:
                        self.reporter.emit("awake")
                    return True
        finally:
            proc = getattr(self, "_proc", None)
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    proc.kill()


def build_wake_listener(config, reporter=None):
    if config.wake_backend == "porcupine":
        return PorcupineWakeListener(
            access_key=config.picovoice_access_key,
            sample_rate=config.sample_rate,
            reporter=reporter,
        )
    if config.wake_backend == "openwakeword":
        return OpenWakeWordListener(
            model_path=config.wake_model_path or None,
            threshold=config.wake_threshold,
            sample_rate=config.sample_rate,
            reporter=reporter,
        )
    return ManualWakeListener()
