import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tts import PiperTTS, build_tts
from config import VoiceConfig


class PiperTTSTest(unittest.TestCase):
    def _capture(self):
        calls = []

        def fake_runner(cmd, **kwargs):
            calls.append(cmd)
            return None

        return calls, fake_runner

    def test_speak_passes_length_scale_and_sentence_silence(self):
        calls, runner = self._capture()
        tts = PiperTTS(
            command="piper",
            voice="model.onnx",
            length_scale=0.8,
            sentence_silence=0.15,
            runner=runner,
        )
        tts.speak("good evening")
        piper_cmd = calls[0]
        self.assertIn("--length-scale", piper_cmd)
        self.assertEqual(piper_cmd[piper_cmd.index("--length-scale") + 1], "0.8")
        self.assertIn("--sentence-silence", piper_cmd)
        self.assertEqual(piper_cmd[piper_cmd.index("--sentence-silence") + 1], "0.15")
        # Player command must stay player-agnostic (no aplay-only "-q") so
        # AUDIO_PLAYER can be pw-play.
        player_cmd = calls[1]
        self.assertNotIn("-q", player_cmd)
        self.assertEqual(player_cmd[0], "aplay")
        self.assertTrue(player_cmd[-1].endswith(".wav"))

    def test_build_tts_threads_speed_from_config(self):
        cfg = VoiceConfig(tts_backend="piper", piper_voice="m.onnx", piper_length_scale=0.8)
        tts = build_tts(cfg)
        self.assertEqual(tts.length_scale, 0.8)


if __name__ == "__main__":
    unittest.main()
