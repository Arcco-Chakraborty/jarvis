import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stt import fetch_vocab


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


if __name__ == "__main__":
    unittest.main()
