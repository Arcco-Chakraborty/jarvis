import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config import load_config


class ConfigTest(unittest.TestCase):
    def test_whisper_vad_defaults(self):
        c = load_config(env={})
        self.assertEqual(c.whisper_device, "cuda")
        self.assertEqual(c.vad_aggressiveness, 2)
        self.assertEqual(c.vad_silence_ms, 600)
        self.assertEqual(c.whisper_no_speech_threshold, 0.6)
        self.assertEqual(c.whisper_logprob_threshold, -1.0)

    def test_env_overrides(self):
        c = load_config(env={
            "WHISPER_DEVICE": "cpu",
            "VOICE_VAD_AGGRESSIVENESS": "3",
            "VOICE_VAD_SILENCE_MS": "500",
            "VOICE_NO_SPEECH_THRESHOLD": "0.4",
            "VOICE_LOGPROB_THRESHOLD": "-1.5",
        })
        self.assertEqual(c.whisper_device, "cpu")
        self.assertEqual(c.vad_aggressiveness, 3)
        self.assertEqual(c.vad_silence_ms, 500)
        self.assertEqual(c.whisper_no_speech_threshold, 0.4)
        self.assertEqual(c.whisper_logprob_threshold, -1.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
