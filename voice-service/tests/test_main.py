import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import handle_text, run_conversation
from orchestrator import CommandResult
from stt import STOP


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
    def test_dispatches_one_command_then_returns(self):
        handled = []
        run_conversation(lambda: "lights on", lambda t: handled.append(t))
        self.assertEqual(handled, ["lights on"])

    def test_silence_returns_without_handling(self):
        handled = []
        run_conversation(lambda: None, handled.append)
        self.assertEqual(handled, [])

    def test_not_understood_returns_silently_no_retry(self):
        calls = {"n": 0}
        def listen():
            calls["n"] += 1
            return ""
        handled = []
        run_conversation(listen, handled.append)
        self.assertEqual(handled, [])
        self.assertEqual(calls["n"], 1)  # exactly one attempt — no retry loop

    def test_stop_sentinel_returns_without_handling(self):
        handled = []
        run_conversation(lambda: STOP, handled.append)
        self.assertEqual(handled, [])


if __name__ == "__main__":
    unittest.main()

