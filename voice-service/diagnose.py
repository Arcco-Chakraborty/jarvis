"""Standalone STT diagnostic — records utterances and shows EXACTLY what Vosk hears.

Run from the repo root (orchestrator running is best, so the grammar matches the
real vocab; it falls back to a default vocab if the orchestrator is down):

    .venv/bin/python voice-service/diagnose.py

Press Enter, speak ONE command, and read the report. Ctrl-C to quit.
Bypasses the wake word so we test recognition in isolation. Set ARECORD_DEVICE
to try a specific capture device, e.g.  ARECORD_DEVICE=plughw:1,0  ... .
"""
import json
import math
import os
import subprocess
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import load_config  # noqa: E402
from grammar import build_grammar, normalize_transcript  # noqa: E402
from stt import fetch_vocab, utterance_text_conf, looks_like_command  # noqa: E402

DEFAULT_VOCAB = {
    "deviceNames": ["fan 1", "fan 2", "tubelight", "spotlight", "rgb light", "night light", "socket", "spare"],
    "groupNames": ["lights", "fans"],
}


def record(rate, seconds):
    cmd = ["arecord", "-q", "-r", str(rate), "-c", "1", "-f", "S16_LE", "-t", "raw", "-d", str(seconds)]
    device = os.environ.get("ARECORD_DEVICE")
    if device:
        cmd += ["-D", device]
    return subprocess.run(cmd, capture_output=True).stdout


def levels(pcm):
    if not pcm:
        return 0, 0.0
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0, 0.0
    peak = max(abs(s) for s in samples)
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    return peak, rms


def decode(model, rate, pcm, grammar=None):
    from vosk import KaldiRecognizer

    rec = KaldiRecognizer(model, rate, grammar) if grammar else KaldiRecognizer(model, rate)
    rec.SetWords(True)
    rec.AcceptWaveform(pcm)
    return json.loads(rec.FinalResult())


def main():
    cfg = load_config()
    print(f"model: {cfg.vosk_model_path}   sample_rate: {cfg.sample_rate}   min_confidence: {cfg.min_confidence}")
    print(f"capture device: {os.environ.get('ARECORD_DEVICE', '(system default)')}\n")
    print("--- capture devices (arecord -l) ---")
    subprocess.run(["arecord", "-l"])
    print("-------------------------------------\n")

    from vosk import Model

    model = Model(cfg.vosk_model_path)
    vocab = fetch_vocab(cfg.orchestrator_url)
    if not vocab.get("deviceNames"):
        print("(orchestrator /vocab unavailable — using default vocab)\n")
        vocab = DEFAULT_VOCAB
    phrases, spoken_to_name = build_grammar(vocab)
    grammar = json.dumps(phrases + ["[unk]"])
    seconds = max(4, int(cfg.max_utterance_seconds // 2))

    print(f"grammar has {len(phrases)} phrases. Recording window: {seconds}s.\n")
    while True:
        try:
            input(">>> Press Enter, then speak ONE command (Ctrl-C to quit)... ")
        except (EOFError, KeyboardInterrupt):
            print("\nbye")
            return
        pcm = record(cfg.sample_rate, seconds)
        peak, rms = levels(pcm)
        peak_pct = round(100 * peak / 32768)

        print(f"\n  AUDIO     peak={peak} ({peak_pct}% of max)  rms={rms:.0f}  bytes={len(pcm)}")
        if peak < 1500:
            print("  ⚠ AUDIO VERY LOW — the mic may be muted, gain too low, or wrong device.")
            print("    Try a different ARECORD_DEVICE (see list above) or raise the mic level in alsamixer.")

        free = decode(model, cfg.sample_rate, pcm)
        print(f"  FREE      \"{(free.get('text') or '').strip()}\"   (no grammar — raw model)")

        gram = decode(model, cfg.sample_rate, pcm, grammar)
        gtext, gconf = utterance_text_conf(gram)
        norm = normalize_transcript(gtext, spoken_to_name)
        accepted = bool(gtext) and gtext != "[unk]" and gconf >= cfg.min_confidence and looks_like_command(norm)
        print(f"  GRAMMAR   \"{gtext}\"   mean_conf={gconf:.2f}")
        print(f"  NORMALIZED\"{norm}\"")
        reason = "ACCEPTED" if accepted else "REJECTED"
        if not accepted:
            if not gtext or gtext == "[unk]":
                reason += " (nothing matched the grammar)"
            elif gconf < cfg.min_confidence:
                reason += f" (confidence {gconf:.2f} < {cfg.min_confidence})"
            elif not looks_like_command(norm):
                reason += " (no on/off — treated as filler)"
        print(f"  DECISION  {reason}\n")


if __name__ == "__main__":
    main()
