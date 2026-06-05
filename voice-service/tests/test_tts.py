import os
import sys
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tts import PiperTTS, build_tts, split_sentences
from config import VoiceConfig


def _recorder():
    """Fake subprocess.run that records argv and, for a piper call, writes a
    tiny valid WAV to its --output-file so the concat path can read it."""
    calls = []

    def runner(cmd, **kwargs):
        calls.append(cmd)
        if "--output-file" in cmd:
            path = cmd[cmd.index("--output-file") + 1]
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(22050)
                w.writeframes(b"\x00\x00" * 200)
        return None

    return calls, runner


class SplitSentencesTest(unittest.TestCase):
    def test_splits_on_sentence_punctuation(self):
        self.assertEqual(split_sentences("One. Two! Three?"), ["One.", "Two!", "Three?"])

    def test_single_sentence_is_one_part(self):
        self.assertEqual(split_sentences("Just one thing here"), ["Just one thing here"])

    def test_blank_text_is_empty(self):
        self.assertEqual(split_sentences("   "), [])


class PiperTTSTest(unittest.TestCase):
    def test_single_sentence_one_synth_one_play_with_speed_flags(self):
        calls, runner = _recorder()
        PiperTTS(command="piper", voice="m.onnx", length_scale=0.8, runner=runner).speak("Hello there.")
        synth = [c for c in calls if "--output-file" in c]
        play = [c for c in calls if "--output-file" not in c]
        self.assertEqual(len(synth), 1)
        self.assertEqual(len(play), 1)
        self.assertEqual(synth[0][synth[0].index("--length-scale") + 1], "0.8")
        # Player command stays player-agnostic (no aplay-only "-q") for pw-play.
        self.assertNotIn("-q", play[0])
        self.assertTrue(play[0][-1].endswith(".wav"))

    def test_multi_sentence_synthesizes_each_separately_then_plays_once(self):
        calls, runner = _recorder()
        PiperTTS(voice="m.onnx", runner=runner).speak(
            "The laptop is muted. All systems are nominal. Shall I brief you?"
        )
        synth = [c for c in calls if "--output-file" in c]
        play = [c for c in calls if "--output-file" not in c]
        # One piper call per sentence (this is what avoids the multi-sentence clip)...
        self.assertEqual(len(synth), 3)
        # ...and a single playback of the concatenated result.
        self.assertEqual(len(play), 1)
        self.assertNotIn("-q", play[0])

    def test_build_tts_threads_speed_from_config(self):
        cfg = VoiceConfig(tts_backend="piper", piper_voice="m.onnx", piper_length_scale=0.8)
        tts = build_tts(cfg)
        self.assertEqual(tts.length_scale, 0.8)


if __name__ == "__main__":
    unittest.main()
