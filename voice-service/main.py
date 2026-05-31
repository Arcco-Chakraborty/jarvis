import argparse
import sys
import time

from config import load_config
from orchestrator import OrchestratorClient
from reporter import build_reporter
from stt import STOP, build_stt
from tts import build_tts
from wakeword import build_wake_listener


def handle_text(text, client, speaker):
    text = (text or "").strip()
    if not text:
        return None
    result = client.command(text)
    speaker.speak(result.speak)
    return result


def run_conversation(listen_fn, handle_fn, reporter=None):
    """One command per wake. listen_fn returns:
      None  -> silence (no speech): return, re-arm the wake word.
      STOP  -> user said 'stop'/'cancel'/'never mind': return.
      ""    -> heard speech but not a command: return silently (no retry, no speak).
      str   -> a command: dispatch via handle_fn, then return.
    After any single outcome the loop re-arms the wake word — it does NOT keep
    listening for follow-ups."""
    if reporter is not None:
        reporter.emit("recording")
    text = listen_fn()
    if not isinstance(text, str) or not text:
        return  # None / STOP / "" -> sleep silently until the next wake word
    if reporter is not None:
        reporter.emit("transcript", text=text)
    handle_fn(text)


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
        print("JARVIS voice service ready. Say 'jarvis', then speak your command.")
    while True:
        reporter.emit("listening")
        if not wake_listener.wait():
            continue
        reporter.emit("awake")
        if hasattr(stt, "listen"):
            run_conversation(
                listen_fn=lambda: stt.listen(
                    config.followup_seconds, config.max_utterance_seconds,
                    on_transcribing=lambda: reporter.emit("transcribing"),
                ),
                handle_fn=lambda t: handle_text(t, client, speaker),
                reporter=reporter,
            )
        else:
            text = stt.transcribe()
            if not text:
                break
            reporter.emit("transcript", text=text)
            handle_text(text, client, speaker)
        reporter.emit("idle")
        # Cooldown: let TTS audio + room echo dissipate so the wake listener
        # doesn't re-fire on Jarvis's own voice ("won't shut up" loop).
        time.sleep(config.post_conversation_cooldown_s)


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
