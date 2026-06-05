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
        self.assertEqual(c.wake_threshold, 0.35)

    def test_piper_voice_speed_defaults(self):
        c = load_config(env={})
        self.assertEqual(c.piper_length_scale, 0.8)
        self.assertEqual(c.piper_sentence_silence, 0.15)
        self.assertEqual(load_config(env={"PIPER_LENGTH_SCALE": "0.9"}).piper_length_scale, 0.9)

    def test_request_timeout_covers_slow_gemini_paths(self):
        # The orchestrator's vision/knowledge/classify calls can take up to ~12s
        # (Gemini). A 5s client timeout falsely reported "couldn't reach the
        # orchestrator" on slow-but-successful commands. Default must exceed the
        # slowest server path with margin.
        c = load_config(env={})
        self.assertGreaterEqual(c.request_timeout_s, 30)
        self.assertEqual(load_config(env={"VOICE_REQUEST_TIMEOUT_S": "45"}).request_timeout_s, 45)

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
