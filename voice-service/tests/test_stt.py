import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stt import fetch_vocab, utterance_text_conf


class FakeResp:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


class FetchVocabTest(unittest.TestCase):
    def test_returns_parsed_json(self):
        def opener(url, timeout=None):
            assert url.endswith("/vocab"), url
            return FakeResp(b'{"deviceNames":["tubelight"],"groupNames":["lights"]}')

        self.assertEqual(
            fetch_vocab("http://x:3000", opener=opener),
            {"deviceNames": ["tubelight"], "groupNames": ["lights"]},
        )

    def test_error_returns_empty_vocab(self):
        def boom(url, timeout=None):
            raise OSError("down")

        self.assertEqual(fetch_vocab("http://x", opener=boom), {"deviceNames": [], "groupNames": []})


class UtteranceConfTest(unittest.TestCase):
    def test_mean_conf_of_words(self):
        r = {"text": "turn off the tubelight", "result": [
            {"word": "turn", "conf": 0.9}, {"word": "off", "conf": 0.8},
            {"word": "the", "conf": 1.0}, {"word": "tubelight", "conf": 0.7}]}
        text, conf = utterance_text_conf(r)
        self.assertEqual(text, "turn off the tubelight")
        self.assertAlmostEqual(conf, 0.85, places=2)

    def test_low_conf(self):
        r = {"text": "fans off", "result": [{"word": "fans", "conf": 0.2}, {"word": "off", "conf": 0.3}]}
        _, conf = utterance_text_conf(r)
        self.assertAlmostEqual(conf, 0.25, places=2)

    def test_empty_result(self):
        self.assertEqual(utterance_text_conf({}), ("", 0.0))

    def test_text_without_word_confs(self):
        self.assertEqual(utterance_text_conf({"text": "lights off"}), ("lights off", 1.0))


if __name__ == "__main__":
    unittest.main()
