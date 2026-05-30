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
    def test_exits_after_one_successful_command(self):
        # One command per wake: after a successful dispatch, immediately
        # re-arm the wake word — do NOT wait for follow-ups.
        seq = iter(["lights on", "should-not-be-consumed"])
        handled = []
        run_conversation(lambda: next(seq), lambda t: handled.append(t))
        self.assertEqual(handled, ["lights on"])

    def test_returns_immediately_on_silence(self):
        handled = []
        run_conversation(lambda: None, handled.append)
        self.assertEqual(handled, [])

    def test_unrecognized_retries_then_handles(self):
        # Heard-but-not-understood ("") -> retry. Success on the retry exits.
        seq = iter(["", "lights on"])
        handled, misses = [], []
        run_conversation(
            lambda: next(seq), lambda t: handled.append(t),
            unrecognized_fn=lambda: misses.append(1), max_unrecognized=3,
        )
        self.assertEqual(handled, ["lights on"])
        self.assertEqual(len(misses), 1)

    def test_bounded_retries_on_repeated_unrecognized(self):
        # Continuous noise must not loop forever: give up after max_unrecognized misses.
        handled, misses = [], []
        run_conversation(
            lambda: "", handled.append,
            unrecognized_fn=lambda: misses.append(1), max_unrecognized=3,
        )
        self.assertEqual(handled, [])
        self.assertEqual(len(misses), 3)  # speaks "didn't catch that" 3 times, then sleeps

    def test_orchestrator_null_intent_counts_as_a_miss(self):
        # An orchestrator "Sorry I didn't catch that" (intent is None) also counts.
        class R:
            def __init__(self, intent):
                self.intent = intent
        results = iter([R(intent=None), R(intent=None), R(intent=None)])
        seq = iter(["a", "b", "c"])
        handled = []
        def hf(t):
            handled.append(t)
            return next(results)
        run_conversation(lambda: next(seq), hf, max_unrecognized=3)
        # Stops after 3 null-intent dispatches.
        self.assertEqual(len(handled), 3)

    def test_stop_command_exits_without_dispatching(self):
        # The STOP sentinel from STT means user said "stop" / "cancel" /
        # "never mind" -> end the conversation immediately, optionally speak
        # an acknowledgment via cancel_fn. handle_fn must NOT be called.
        from stt import STOP
        handled, canceled = [], []
        run_conversation(
            lambda: STOP, lambda t: handled.append(t),
            cancel_fn=lambda: canceled.append(1),
        )
        self.assertEqual(handled, [])
        self.assertEqual(canceled, [1])


if __name__ == "__main__":
    unittest.main()

