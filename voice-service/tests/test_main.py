import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import handle_text, run_conversation
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


class RunConversationTest(unittest.TestCase):
    def test_handles_commands_until_silence(self):
        # None signals silence (no speech) -> end the conversation.
        seq = iter(["turn off the tubelight", "lights on", None])
        handled = []
        run_conversation(lambda: next(seq), handled.append, followup_seconds=5)
        self.assertEqual(handled, ["turn off the tubelight", "lights on"])

    def test_one_shot_when_followup_zero(self):
        seq = iter(["a", "b"])
        handled = []
        run_conversation(lambda: next(seq), handled.append, followup_seconds=0)
        self.assertEqual(handled, ["a"])

    def test_returns_immediately_on_silence(self):
        handled = []
        run_conversation(lambda: None, handled.append, followup_seconds=5)
        self.assertEqual(handled, [])

    def test_unrecognized_retries_then_handles(self):
        # "" means heard-but-not-understood: say "didn't catch that" and try again,
        # don't drop back to sleep.
        seq = iter(["", "lights on", None])
        handled, misses = [], []
        run_conversation(
            lambda: next(seq), handled.append, followup_seconds=5,
            unrecognized_fn=lambda: misses.append(1), max_unrecognized=3,
        )
        self.assertEqual(handled, ["lights on"])
        self.assertEqual(len(misses), 1)

    def test_bounded_retries_on_repeated_unrecognized(self):
        # Continuous noise must not loop forever: give up after max_unrecognized misses.
        handled, misses = [], []
        run_conversation(
            lambda: "", handled.append, followup_seconds=5,
            unrecognized_fn=lambda: misses.append(1), max_unrecognized=2,
        )
        self.assertEqual(handled, [])
        self.assertEqual(len(misses), 2)


if __name__ == "__main__":
    unittest.main()

