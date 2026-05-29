import argparse
import sys

from config import load_config
from orchestrator import OrchestratorClient
from reporter import build_reporter
from stt import build_stt
from tts import build_tts
from wakeword import build_wake_listener


def handle_text(text, client, speaker):
    text = (text or "").strip()
    if not text:
        return None
    result = client.command(text)
    speaker.speak(result.speak)
    return result


def run_conversation(listen_fn, handle_fn, followup_seconds, reporter=None):
    """Take commands turn-by-turn until a silent turn (empty text), then return.
    followup_seconds <= 0 -> one-shot (handle one command, then return)."""
    while True:
        if reporter is not None:
            reporter.emit("recording")
        text = listen_fn()
        if not text:
            return
        if reporter is not None:
            reporter.emit("transcript", text=text)
        handle_fn(text)
        if followup_seconds <= 0:
            return


def run_loop(config, client=None, stt=None, wake_listener=None, speaker=None, reporter=None):
    client = client or OrchestratorClient(config.orchestrator_url, config.request_timeout_s)
    reporter = reporter or build_reporter(config)
    stt = stt or build_stt(config)
    wake_listener = wake_listener or build_wake_listener(config, reporter)
    speaker = speaker or build_tts(config)

    reporter.emit("ready")
    if config.wake_backend == "manual":
        print(f"JARVIS voice service ready. Type commands after '{config.wake_word}', Ctrl-D to exit.")
    else:
        print("JARVIS voice service ready. Say 'hey jarvis', then speak the command during the recording window.")
    while True:
        reporter.emit("listening")
        if not wake_listener.wait():
            continue
        reporter.emit("awake")
        if hasattr(stt, "listen"):
            run_conversation(
                listen_fn=lambda: stt.listen(config.followup_seconds, config.max_utterance_seconds),
                handle_fn=lambda t: handle_text(t, client, speaker),
                followup_seconds=config.followup_seconds,
                reporter=reporter,
            )
        else:
            text = stt.transcribe()
            if not text:
                break
            reporter.emit("transcript", text=text)
            handle_text(text, client, speaker)
        reporter.emit("idle")


def main(argv=None):
    parser = argparse.ArgumentParser(description="JARVIS local voice service")
    parser.add_argument("--once", metavar="TEXT", help="dispatch one transcript and exit")
    args = parser.parse_args(argv)

    config = load_config()
    client = OrchestratorClient(config.orchestrator_url, config.request_timeout_s)
    speaker = build_tts(config)

    if args.once is not None:
        result = handle_text(args.once, client, speaker)
        return 0 if result and result.ok else 1

    run_loop(config, client=client, speaker=speaker)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
