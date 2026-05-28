import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import handle_text
from orchestrator import CommandResult


class FakeClient:
    def __init__(self):
        self.texts = []

    def command(self, text):
        self.texts.append(text)
        return CommandResult(True, f"heard {text}", {"domain": "switch"})


class FakeSpeaker:
    def __init__(self):
        self.spoken = []

    def speak(self, text):
        self.spoken.append(text)


class HandleTextTest(unittest.TestCase):
    def test_empty_text_is_ignored(self):
        client = FakeClient()
        speaker = FakeSpeaker()
        self.assertIsNone(handle_text("   ", client, speaker))
        self.assertEqual(client.texts, [])
        self.assertEqual(speaker.spoken, [])

    def test_dispatches_and_speaks_response(self):
        client = FakeClient()
        speaker = FakeSpeaker()
        result = handle_text(" lights off ", client, speaker)
        self.assertTrue(result.ok)
        self.assertEqual(client.texts, ["lights off"])
        self.assertEqual(speaker.spoken, ["heard lights off"])


if __name__ == "__main__":
    unittest.main()

