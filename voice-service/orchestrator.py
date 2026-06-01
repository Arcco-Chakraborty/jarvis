import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class CommandResult:
    ok: bool
    speak: str
    intent: dict | None = None


class OrchestratorClient:
    def __init__(self, base_url, timeout_s=5.0, opener=urlopen):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._opener = opener

    def command(self, text):
        payload = json.dumps({"text": text}).encode("utf-8")
        req = Request(
            f"{self.base_url}/command",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with self._opener(req, timeout=self.timeout_s) as res:
                body = json.loads(res.read().decode("utf-8"))
        except HTTPError:
            return CommandResult(False, "The orchestrator ran into an error, sir.", None)
        except TimeoutError:  # subclass of OSError — catch before the reach case
            return CommandResult(False, "The orchestrator took too long to respond, sir.", None)
        except (URLError, OSError) as e:
            if isinstance(getattr(e, "reason", None), TimeoutError):
                return CommandResult(False, "The orchestrator took too long to respond, sir.", None)
            return CommandResult(False, "I can't reach the orchestrator — make sure it's running, sir.", None)
        except json.JSONDecodeError:
            return CommandResult(False, "The orchestrator sent something I couldn't read, sir.", None)

        return CommandResult(
            bool(body.get("ok")),
            body.get("speak") or "Sorry, I didn't catch that.",
            body.get("intent"),
        )

