import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reporter import EventReporter, NullReporter


class FakeResp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b""


class ReporterTest(unittest.TestCase):
    def test_emit_posts_to_voice_event(self):
        posted = []

        def opener(req, timeout=None):
            posted.append((req.full_url, json.loads(req.data)))
            return FakeResp()

        r = EventReporter("http://x:3000", opener=opener)
        r.emit("wake_score", score=0.42, threshold=0.5)
        r._queue.join()
        self.assertEqual(posted[0][0], "http://x:3000/voice/event")
        self.assertEqual(posted[0][1], {"type": "wake_score", "score": 0.42, "threshold": 0.5})

    def test_emit_swallows_opener_errors(self):
        def bad_opener(req, timeout=None):
            raise OSError("network down")

        r = EventReporter("http://x:3000", opener=bad_opener)
        r.emit("ready")
        r._queue.join()  # must not raise

    def test_null_reporter_is_noop(self):
        self.assertIsNone(NullReporter().emit("ready", x=1))


if __name__ == "__main__":
    unittest.main()
