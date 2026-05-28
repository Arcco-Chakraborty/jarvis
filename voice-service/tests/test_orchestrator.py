import json
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orchestrator import OrchestratorClient


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self.body


class OrchestratorClientTest(unittest.TestCase):
    def test_command_posts_text_and_returns_result(self):
        calls = []

        def opener(req, timeout):
            calls.append((req, timeout))
            body = json.dumps({
                "ok": True,
                "speak": "The tubelight is on.",
                "intent": {"domain": "switch", "action": "status", "target": "tubelight"},
            }).encode("utf-8")
            return FakeResponse(body)

        client = OrchestratorClient("http://jarvis.local/", timeout_s=3, opener=opener)
        result = client.command("is the tubelight on?")

        self.assertTrue(result.ok)
        self.assertEqual(result.speak, "The tubelight is on.")
        self.assertEqual(result.intent["target"], "tubelight")
        req, timeout = calls[0]
        self.assertEqual(timeout, 3)
        self.assertEqual(req.full_url, "http://jarvis.local/command")
        self.assertEqual(json.loads(req.data.decode("utf-8")), {"text": "is the tubelight on?"})

    def test_command_failure_returns_speakable_error(self):
        def opener(req, timeout):
            raise OSError("down")

        client = OrchestratorClient("http://jarvis.local", opener=opener)
        result = client.command("hello")

        self.assertFalse(result.ok)
        self.assertEqual(result.speak, "I couldn't reach the orchestrator.")
        self.assertIsNone(result.intent)


if __name__ == "__main__":
    unittest.main()
