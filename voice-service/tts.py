import re
import subprocess
import tempfile
import wave
from pathlib import Path

# Piper clips when several sentences are synthesized in one call (long replies
# distort into static), but each sentence on its own is clean. So we split on
# sentence boundaries, synthesize each separately, and concatenate the clean
# clips with a short silence between them.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text):
    parts = _SENTENCE_SPLIT.split(str(text or "").strip())
    return [p.strip() for p in parts if p.strip()]


def _concat_wavs(paths, out_path, gap_s=0.15):
    """Concatenate same-format WAVs into out_path with gap_s of silence between."""
    frames = []
    params = None
    for p in paths:
        with wave.open(str(p), "rb") as w:
            if params is None:
                params = w.getparams()
            frames.append(w.readframes(w.getnframes()))
    with wave.open(str(out_path), "wb") as w:
        w.setparams(params)
        silence = b"\x00" * (params.framerate * params.sampwidth * params.nchannels)
        silence = silence[: int(params.framerate * gap_s) * params.sampwidth * params.nchannels]
        for i, fr in enumerate(frames):
            if i:
                w.writeframes(silence)
            w.writeframes(fr)


class ConsoleTTS:
    def speak(self, text):
        print(f"JARVIS: {text}")


class PiperTTS:
    def __init__(
        self,
        command="piper",
        voice="",
        output_device="",
        audio_player="aplay",
        length_scale=0.8,
        sentence_silence=0.15,
        runner=subprocess.run,
    ):
        self.command = command
        self.voice = voice
        self.output_device = output_device
        self.audio_player = audio_player
        # length_scale < 1.0 speeds up speech; sentence_silence is the pause we
        # insert between separately-synthesized sentences. Crisp, JARVIS-like.
        self.length_scale = length_scale
        self.sentence_silence = sentence_silence
        self.runner = runner

    def _synth(self, sentence, path):
        self.runner(
            [
                self.command,
                "--model", self.voice,
                "--length-scale", str(self.length_scale),
                "--output-file", str(path),
            ],
            input=str(sentence).encode("utf-8"),
            check=True,
        )

    def _play(self, path):
        # No "-q": keep the command player-agnostic so AUDIO_PLAYER can be
        # pw-play (PipeWire-native, cleaner) or aplay. -D is aplay's device flag.
        player = [self.audio_player, str(path)]
        if self.output_device:
            player = [self.audio_player, "-D", self.output_device, str(path)]
        self.runner(player, check=True)

    def speak(self, text):
        if not self.voice:
            raise RuntimeError("PIPER_VOICE is required for VOICE_TTS_BACKEND=piper")
        sentences = split_sentences(text) or [str(text)]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "speech.wav"
            if len(sentences) == 1:
                self._synth(sentences[0], out)
            else:
                parts = []
                for i, sentence in enumerate(sentences):
                    p = Path(td) / f"part{i}.wav"
                    self._synth(sentence, p)
                    parts.append(p)
                _concat_wavs(parts, out, gap_s=self.sentence_silence)
            self._play(out)


def build_tts(config):
    if config.tts_backend == "piper":
        return PiperTTS(
            config.piper_command,
            config.piper_voice,
            config.piper_output_device,
            config.audio_player,
            config.piper_length_scale,
            config.piper_sentence_silence,
        )
    return ConsoleTTS()
