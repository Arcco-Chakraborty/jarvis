import json
import queue
import threading
from urllib.request import Request, urlopen


class NullReporter:
    def emit(self, event_type, **data):
        return None


class EventReporter:
    """Best-effort telemetry: enqueue events; a daemon thread POSTs them. Never blocks or raises."""

    def __init__(self, orchestrator_url, timeout_s=1.0, opener=urlopen, max_queue=64):
        self.url = orchestrator_url.rstrip("/") + "/voice/event"
        self.timeout_s = timeout_s
        self._opener = opener
        self._queue = queue.Queue(maxsize=max_queue)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def emit(self, event_type, **data):
        try:
            self._queue.put_nowait({"type": event_type, **data})
        except queue.Full:
            pass  # drop telemetry rather than block audio capture

    def _run(self):
        while True:
            payload = self._queue.get()
            try:
                body = json.dumps(payload).encode("utf-8")
                req = Request(self.url, data=body, headers={"content-type": "application/json"}, method="POST")
                with self._opener(req, timeout=self.timeout_s) as res:
                    res.read()
            except Exception:
                pass  # best-effort; never crash the voice loop
            finally:
                self._queue.task_done()


def build_reporter(config):
    if getattr(config, "wake_backend", "manual") != "manual":
        return EventReporter(config.orchestrator_url)
    return NullReporter()
