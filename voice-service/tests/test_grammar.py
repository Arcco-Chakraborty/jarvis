import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from grammar import to_spoken, build_grammar, normalize_transcript

VOCAB = {
    "deviceNames": ["fan 1", "fan 2", "tubelight", "rgb light", "socket"],
    "groupNames": ["lights", "fans"],
}


class GrammarTest(unittest.TestCase):
    def test_to_spoken_numbers(self):
        self.assertEqual(to_spoken("fan 1"), "fan one")
        self.assertEqual(to_spoken("fan 2"), "fan two")
        self.assertEqual(to_spoken("tubelight"), "tube light")

    def test_build_grammar_phrases_and_map(self):
        phrases, mapping = build_grammar(VOCAB)
        for p in [
            "turn off the fan one", "fan one on", "is the tube light on",
            "turn off the tube light", "turn off the r g b light", "lights off", "turn on the lights",
            "everything off", "keep the lights on rest off",
            "switch off the tube light", "turn the tube light on",
            "switch on the lights", "turn the lights off",
            "turn off all lights except the tube light",
            "turn off all lights except tube light",
            "turn off everything except the tube light",
            "turn off all fans except fan one",
            "keep only the tube light on", "keep only the lights on",
        ]:
            self.assertIn(p, phrases)
        self.assertEqual(mapping["fan one"], "fan 1")
        self.assertEqual(mapping["fan two"], "fan 2")
        self.assertEqual(mapping["tube light"], "tubelight")
        self.assertEqual(len(phrases), len(set(phrases)))

    def test_normalize_transcript(self):
        _, mapping = build_grammar(VOCAB)
        self.assertEqual(normalize_transcript("turn off the fan one", mapping), "turn off the fan 1")
        self.assertEqual(normalize_transcript("turn off the tube light", mapping), "turn off the tubelight")
        self.assertEqual(normalize_transcript("lights off", mapping), "lights off")


if __name__ == "__main__":
    unittest.main()
