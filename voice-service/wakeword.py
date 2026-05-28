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


def build_wake_listener(config, reporter=None):
    if config.wake_backend == "openwakeword":
        return OpenWakeWordListener(
            model_path=config.wake_model_path or None,
            threshold=config.wake_threshold,
            sample_rate=config.sample_rate,
            reporter=reporter,
        )
    return ManualWakeListener()
