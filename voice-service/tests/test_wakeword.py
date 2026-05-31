import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wakeword import PorcupineWakeListener


class FakePorcupine:
    frame_length = 512
    sample_rate = 16000

    def __init__(self, hits):
        self._hits = list(hits)  # e.g. [-1, -1, 0] -> wake on the 3rd frame

    def process(self, frame):
        return self._hits.pop(0) if self._hits else -1


class FakeStream:
    """Yields enough raw bytes for N frames, then EOF."""

    def __init__(self, n_frames, frame_length=512):
        self._data = b"\x00\x00" * frame_length * n_frames
        self._pos = 0

    def read(self, n):
        chunk = self._data[self._pos:self._pos + n]
        self._pos += n
        return chunk


class FakeReporter:
    def __init__(self):
        self.events = []

    def emit(self, name, **kw):
        self.events.append((name, kw))


class PorcupineWakeTest(unittest.TestCase):
    def test_wakes_on_keyword_hit(self):
        reporter = FakeReporter()
        listener = PorcupineWakeListener(
            porcupine=FakePorcupine([-1, -1, 0]),
            reporter=reporter,
            stream_factory=lambda: FakeStream(5),
        )
        self.assertTrue(listener.wait())
        self.assertIn("awake", [n for n, _ in reporter.events])

    def test_returns_false_on_stream_eof_without_hit(self):
        listener = PorcupineWakeListener(
            porcupine=FakePorcupine([-1, -1, -1]),
            stream_factory=lambda: FakeStream(3),
        )
        self.assertFalse(listener.wait())


if __name__ == "__main__":
    unittest.main(verbosity=2)
