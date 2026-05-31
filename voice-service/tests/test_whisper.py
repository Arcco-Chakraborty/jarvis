import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stt import capture_utterance


def frames(pattern):
    # 'S' -> 30ms speech frame, '_' -> 30ms silence frame; each frame is 960 bytes.
    return [(b"\x01\x01" * 480 if c == "S" else b"\x00\x00" * 480) for c in pattern]


def is_speech(frame):
    return frame[:2] == b"\x01\x01"


class CaptureUtteranceTest(unittest.TestCase):
    def test_no_onset_within_initial_silence_returns_none(self):
        # 30ms frames; max_initial_silence 0.09s allows 3 silent frames then gives up.
        out = capture_utterance(iter(frames("______")), is_speech,
                                max_initial_silence=0.09, vad_silence_ms=60, max_utterance=5.0)
        self.assertIsNone(out)

    def test_captures_from_onset_until_trailing_silence(self):
        # speech, speech, then 60ms (2 frames) of silence ends the utterance.
        out = capture_utterance(iter(frames("__SS___S")), is_speech,
                                max_initial_silence=1.0, vad_silence_ms=60, max_utterance=5.0)
        # Captured = onset 'SS' + the two trailing silence frames that closed it = 4 frames.
        self.assertEqual(len(out), 4 * 960)

    def test_max_utterance_bound_terminates_continuous_speech(self):
        out = capture_utterance(iter(frames("S" * 100)), is_speech,
                                max_initial_silence=1.0, vad_silence_ms=300, max_utterance=0.12)
        # 0.12s / 0.03s per frame = 4 frames captured, then the bound trips.
        self.assertEqual(len(out), 4 * 960)


if __name__ == "__main__":
    unittest.main(verbosity=2)
