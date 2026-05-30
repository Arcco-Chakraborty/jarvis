NUMBER_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}


# Device names that aren't real English words (so the Vosk lexicon can't decode them) ->
# spoken forms made of real words. Recognized text is normalized back via spoken_to_name.
SPOKEN_OVERRIDES = {
    "tubelight": "tube light",
    "rgb light": "r g b light",
}


def to_spoken(name):
    """Registry name -> spoken form Vosk can decode (real words only)."""
    if name in SPOKEN_OVERRIDES:
        return SPOKEN_OVERRIDES[name]
    return " ".join(NUMBER_WORDS.get(tok, tok) for tok in name.split(" "))


def build_grammar(vocab):
    """vocab {deviceNames, groupNames} -> (phrases list, spoken_to_name map)."""
    devices = (vocab or {}).get("deviceNames", [])
    groups = (vocab or {}).get("groupNames", [])
    phrases = []
    spoken_to_name = {}

    def add(p):
        if p not in phrases:
            phrases.append(p)

    spoken_devices = []
    for name in devices:
        sd = to_spoken(name)
        spoken_to_name[sd] = name
        spoken_devices.append(sd)
        add(f"turn on the {sd}")
        add(f"turn off the {sd}")
        add(f"{sd} on")
        add(f"{sd} off")
        add(f"is the {sd} on")
        add(f"keep the {sd} on rest off")
        add(f"keep only the {sd} on")
        add(f"keep only {sd} on")
        add(f"switch on the {sd}")
        add(f"switch off the {sd}")
        add(f"turn the {sd} on")
        add(f"turn the {sd} off")
        # "turn off everything except <device>" (global exclusion)
        add(f"turn off everything except the {sd}")
        add(f"turn off everything except {sd}")

    for g in groups:
        add(f"turn on the {g}")
        add(f"turn off the {g}")
        add(f"{g} on")
        add(f"{g} off")
        add(f"keep the {g} on rest off")
        add(f"keep only the {g} on")
        add(f"keep only {g} on")
        add(f"switch on the {g}")
        add(f"switch off the {g}")
        add(f"turn the {g} on")
        add(f"turn the {g} off")
        # "turn off all <group> except <device>" (group-scoped exclusion)
        for sd in spoken_devices:
            add(f"turn off all {g} except the {sd}")
            add(f"turn off all {g} except {sd}")

    for p in ("all off", "everything off", "turn everything off", "turn off everything",
              "all on", "everything on", "turn everything on", "turn on everything",
              "stop", "cancel", "never mind"):
        add(p)

    # PC apps: "open <app>" / "launch <app>" / "start <app>" — phrases only;
    # the orchestrator's allowlist decides whether to actually run it.
    apps = (vocab or {}).get("appNames", []) or []
    for app in apps:
        add(f"open {app}")
        add(f"launch {app}")
        add(f"start {app}")

    # PC media (transport + volume)
    for p in (
        "play", "pause", "play music", "pause music",
        "next", "skip", "next song",
        "previous", "previous song", "go back",
        "volume up", "louder", "volume down", "quieter",
        "mute", "unmute",
    ):
        add(p)
    for n in ("zero", "ten", "twenty", "thirty", "forty", "fifty",
              "sixty", "seventy", "eighty", "ninety", "hundred"):
        add(f"set volume to {n} percent")

    # PC window
    for p in ("snap left", "snap right", "minimize", "minimize window", "close window"):
        add(p)
    for app in apps:
        add(f"focus {app}")

    # PC shell: "run <recipe>" + confirmation phrases
    for r in ((vocab or {}).get("shellRecipes", []) or []):
        add(f"run {r}")
    for p in ("confirm", "confirmed", "go ahead", "do it", "yes confirm"):
        add(p)

    return phrases, spoken_to_name


def normalize_transcript(text, spoken_to_name):
    """Replace spoken device forms with registry names ('fan one' -> 'fan 1')."""
    out = text
    for spoken in sorted(spoken_to_name, key=len, reverse=True):
        name = spoken_to_name[spoken]
        if spoken != name:
            out = out.replace(spoken, name)
    return out
