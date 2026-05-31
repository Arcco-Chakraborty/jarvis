import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from urllib.request import urlopen

_COMMAND_VERBS = re.compile(
    r"\b("
    r"on|off|"                                    # switch
    r"open|launch|start|focus|"                   # pc apps + window focus
    r"play|pause|next|skip|previous|"             # media transport
    r"volume|louder|quieter|mute|unmute|set|"     # media volume
    r"snap|minimize|close|"                       # window ops
    r"run|"                                       # shell
    r"confirm|confirmed|go|do"                    # confirmation
    r")\b"
)
# Complete command phrases that don't name a device/app/recipe (the has_target
# check would otherwise reject them). Vosk grammar mode only ever emits these
# as full decoded phrases, so trusting the literal match here is safe.
STANDALONE = frozenset({
    "play", "pause", "play music", "pause music", "play pause",
    "next", "skip", "next song",
    "previous", "previous song", "go back",
    "volume up", "louder", "volume down", "quieter",
    "mute", "unmute",
    "minimize", "minimize window", "close window",
    "snap left", "snap right",
    "confirm", "confirmed", "go ahead", "do it", "yes confirm",
})
_DEBUG = bool(os.environ.get("VOICE_DEBUG"))

# Sentinel returned by listen() when the user said "stop" / "cancel" / "never mind".
# Distinct object so the conversation loop tells it apart from a string command.
STOP = object()
STOP_PHRASES = {"stop", "cancel", "never mind"}


def _debug(msg):
    if _DEBUG:
        print(f"[stt] {msg}", file=sys.stderr, flush=True)


def looks_like_command(text):
    """A real command always contains one of the recognized command verbs.
    Rejects stray filler the recognizer emits from noise (e.g. 'the')."""
    if not text:
        return False
    return bool(_COMMAND_VERBS.search(text))


def is_standalone(text):
    """Phrases that don't need a target (media/window/confirm)."""
    if not text:
        return False
    if text in STANDALONE:
        return True
    return text.startswith("set volume to ")


def has_target(text, targets):
    """A real command also names what to act on: a device, a group, or a global
    word like 'everything'/'all'. Rejects partial Vosk outputs like "off" or
    "the off" that would otherwise be dispatched to the orchestrator and come
    back as "Sorry I didn't catch that" (causing the conversation loop to spin)."""
    if not text or not targets:
        return False
    return any(t in text for t in targets)


class ManualTextInput:
    def transcribe(self):
        try:
            return input("You: ").strip()
        except EOFError:
            return ""



def fetch_vocab(orchestrator_url, opener=urlopen):
    """GET {url}/vocab -> {deviceNames, groupNames}; empty vocab on any failure."""
    try:
        with opener(orchestrator_url.rstrip("/") + "/vocab", timeout=5) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception:
        return {"deviceNames": [], "groupNames": []}


def utterance_text_conf(result):
    """Vosk Result JSON dict -> (text, mean word confidence)."""
    words = result.get("result") or []
    text = (result.get("text") or "").strip()
    if words:
        return text, sum(float(w.get("conf", 0.0)) for w in words) / len(words)
    return text, (1.0 if text else 0.0)


def capture_utterance(frames, is_speech, sample_rate=16000, frame_ms=30,
                      max_initial_silence=5.0, vad_silence_ms=800, max_utterance=12.0):
    """Endpoint one utterance from a stream of fixed-size PCM frames.

    frames: iterable of equal-size PCM byte chunks (frame_ms each at sample_rate).
    is_speech: callable(frame_bytes) -> bool.
    Returns captured PCM bytes (onset through the trailing-silence that closed it),
    or None if no speech onset occurred within max_initial_silence.
    """
    frame_s = frame_ms / 1000.0
    silence_limit_s = vad_silence_ms / 1000.0
    collected = []
    started = False
    pre_onset_s = 0.0
    trailing_silence_s = 0.0
    for frame in frames:
        speech = is_speech(frame)
        if not started:
            if speech:
                started = True
                collected.append(frame)
            else:
                pre_onset_s += frame_s
                if pre_onset_s >= max_initial_silence:
                    return None
            continue
        collected.append(frame)
        if speech:
            trailing_silence_s = 0.0
        else:
            trailing_silence_s += frame_s
            if trailing_silence_s >= silence_limit_s:
                break
        if len(collected) * frame_s >= max_utterance:
            break
    if not started:
        return None
    return b"".join(collected)


def whisper_transcript(segments, no_speech_threshold=0.6, logprob_threshold=-1.0):
    """Join faster-whisper segments into text, dropping hallucinated / no-speech ones.

    Returns the cleaned transcript, or "" if every segment is filtered out.
    """
    kept = []
    for s in segments:
        nsp = getattr(s, "no_speech_prob", None)
        if nsp is not None and nsp > no_speech_threshold:
            continue
        alp = getattr(s, "avg_logprob", None)
        if alp is not None and alp < logprob_threshold:
            continue
        text = (s.text or "").strip()
        if text:
            kept.append(text)
    return " ".join(kept).strip()


class VoskSTT:
    def __init__(self, config, vocab=None):
        from vosk import Model, KaldiRecognizer
        from grammar import build_grammar

        self._KaldiRecognizer = KaldiRecognizer
        if vocab is None:
            vocab = fetch_vocab(config.orchestrator_url)
        self.phrases, self.spoken_to_name = build_grammar(vocab)
        self.model = Model(config.vosk_model_path)
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self._grammar = json.dumps(self.phrases + ["[unk]"])
        self.min_conf = getattr(config, "min_confidence", 0.6)
        devices = (vocab.get("deviceNames") or [])
        groups = (vocab.get("groupNames") or [])
        apps = (vocab.get("appNames") or [])
        recipes = (vocab.get("shellRecipes") or [])
        self._targets = (
            {d.lower() for d in devices}
            | {g.lower() for g in groups}
            | {a.lower() for a in apps}
            | {r.lower() for r in recipes}
            | {"everything", "all"}
        )

    def listen(self, max_initial_silence=5.0, max_utterance=12.0, on_transcribing=None):
        from grammar import normalize_transcript

        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        rec = self._KaldiRecognizer(self.model, self.sample_rate, self._grammar)
        rec.SetWords(True)
        result = None
        started = False
        t0 = time.monotonic()
        try:
            while True:
                chunk = proc.stdout.read(4000)
                if not chunk:
                    break
                if rec.AcceptWaveform(chunk):
                    result = json.loads(rec.Result())
                    break
                if json.loads(rec.PartialResult()).get("partial"):
                    started = True
                elapsed = time.monotonic() - t0
                if not started and elapsed >= max_initial_silence:
                    break
                if elapsed >= max_utterance:
                    result = json.loads(rec.FinalResult())
                    break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        if not result:
            _debug("silence (no speech)")
            return None  # no speech detected -> silence, end the conversation
        text, conf = utterance_text_conf(result)
        if not text or text == "[unk]" or conf < self.min_conf:
            _debug(f"REJECT heard={text!r} conf={conf:.2f} (min {self.min_conf})")
            return ""  # heard ambient noise / low-confidence -> not understood, retry
        norm = normalize_transcript(text, self.spoken_to_name)
        if norm in STOP_PHRASES:
            _debug(f"STOP heard={norm!r} conf={conf:.2f}")
            return STOP
        if not looks_like_command(norm) or (
            not has_target(norm, self._targets) and not is_standalone(norm)
        ):
            _debug(f"REJECT no-command/no-target heard={text!r} conf={conf:.2f}")
            return ""  # partial Vosk output ("the", "off", "the off") -> not a command, retry
        _debug(f"ACCEPT {norm!r} conf={conf:.2f}")
        return norm

    def transcribe(self):
        return self.listen(max_initial_silence=self.record_seconds)


_PUNCT_STRIP = ".,!?;: "


class ArecordVadRecorder:
    """Default recorder: arecord raw stream -> webrtcvad endpointing -> PCM bytes."""

    def __init__(self, config):
        import webrtcvad

        self._vad = webrtcvad.Vad(config.vad_aggressiveness)
        self.sample_rate = config.sample_rate
        self.vad_silence_ms = config.vad_silence_ms
        self.frame_bytes = int(self.sample_rate * 0.03) * 2  # 30ms mono S16_LE

    def _is_speech(self, frame):
        return len(frame) == self.frame_bytes and self._vad.is_speech(frame, self.sample_rate)

    def _frames(self, proc):
        while True:
            chunk = proc.stdout.read(self.frame_bytes)
            if len(chunk) < self.frame_bytes:
                return
            yield chunk

    def __call__(self, max_initial_silence, max_utterance):
        proc = subprocess.Popen(
            ["arecord", "-q", "-r", str(self.sample_rate), "-c", "1", "-f", "S16_LE", "-t", "raw"],
            stdout=subprocess.PIPE,
        )
        try:
            return capture_utterance(
                self._frames(proc), self._is_speech,
                sample_rate=self.sample_rate, frame_ms=30,
                max_initial_silence=max_initial_silence,
                vad_silence_ms=self.vad_silence_ms,
                max_utterance=max_utterance,
            )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()


class WhisperSTT:
    def __init__(self, config, vocab=None, model=None, recorder=None):
        # vocab is accepted for signature parity with VoskSTT but unused:
        # Whisper is open-vocabulary, so there is no grammar to constrain.
        self.sample_rate = config.sample_rate
        self.record_seconds = config.record_seconds
        self.no_speech_threshold = config.whisper_no_speech_threshold
        self.logprob_threshold = config.whisper_logprob_threshold
        if model is None:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                getattr(config, "whisper_model", "large-v3"),
                device=getattr(config, "whisper_device", "cuda"),
                compute_type=getattr(config, "whisper_compute_type", "int8"),
            )
        self.model = model
        self.recorder = recorder or ArecordVadRecorder(config)

    def listen(self, max_initial_silence=5.0, max_utterance=12.0, on_transcribing=None):
        pcm = self.recorder(max_initial_silence, max_utterance)
        if not pcm:
            _debug("silence (no speech)")
            return None
        if on_transcribing is not None:
            on_transcribing()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            with wave.open(str(path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.sample_rate)
                wf.writeframes(pcm)
            segments, _info = self.model.transcribe(
                str(path), language="en", beam_size=5,
                vad_filter=True, condition_on_previous_text=False,
            )
            text = whisper_transcript(
                segments,
                no_speech_threshold=self.no_speech_threshold,
                logprob_threshold=self.logprob_threshold,
            )
        finally:
            path.unlink(missing_ok=True)
        if not text:
            _debug("REJECT empty/low-confidence transcript")
            return ""
        norm = text.lower().strip(_PUNCT_STRIP)
        if norm in STOP_PHRASES:
            _debug(f"STOP heard={norm!r}")
            return STOP
        _debug(f"ACCEPT {norm!r}")
        return norm

    def transcribe(self):
        return self.listen(max_initial_silence=self.record_seconds)


def build_stt(config, vocab=None):
    if config.stt_backend == "vosk":
        return VoskSTT(config, vocab=vocab)
    if config.stt_backend == "whisper":
        return WhisperSTT(config, vocab=vocab)
    return ManualTextInput()
