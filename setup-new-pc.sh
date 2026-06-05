#!/usr/bin/env bash
# JARVIS — one-command bootstrap for a new Ubuntu host.
#
# Fresh machine (downloads & clones):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Arcco-Chakraborty/jarvis/main/setup-new-pc.sh)
#
# Or if you've already cloned the repo:
#   cd jarvis && ./setup-new-pc.sh
#
# Defaults to the GPU voice stack (faster-whisper large-v3 on CUDA), matching
# .env.example. No NVIDIA GPU? The script warns and you switch .env to CPU
# (see README → "Running without a GPU").
#
# Flags:
#   --skip-packages    don't apt-install system deps (you've handled them)
#   --skip-models      don't download the Piper voice (you'll do it manually)
#   --skip-tests       don't run the npm/python test suites at the end
#   --vosk             also download the offline Vosk STT model (opt-in fallback)
#   -h | --help        show usage

set -euo pipefail

# ---------- config ----------
GH_OWNER="Arcco-Chakraborty"
REPO_NAME="jarvis"
REPO_HTTPS="https://github.com/${GH_OWNER}/${REPO_NAME}.git"
PY_VER="3.12"

# Piper TTS voice (must match PIPER_VOICE in .env.example).
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium"
PIPER_ONNX="en_GB-alan-medium.onnx"

# Optional offline Vosk STT model (--vosk).
VOSK_URL="https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip"
VOSK_DIR="vosk-model-en-us-0.22-lgraph"

# ---------- helpers ----------
step()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ---------- flags ----------
SKIP_PACKAGES=0; SKIP_MODELS=0; SKIP_TESTS=0; WANT_VOSK=0
for arg in "$@"; do
  case "$arg" in
    --skip-packages) SKIP_PACKAGES=1 ;;
    --skip-models)   SKIP_MODELS=1 ;;
    --skip-tests)    SKIP_TESTS=1 ;;
    --vosk)          WANT_VOSK=1 ;;
    -h|--help)       sed -n '2,19p' "$0"; exit 0 ;;
    *) die "Unknown flag: $arg (use --help)" ;;
  esac
done

# ---------- 0: environment ----------
step "Detecting environment"
[ -f /etc/os-release ] && . /etc/os-release || die "Not a recognizable Linux host."
echo "  OS: ${PRETTY_NAME:-unknown}"
case "${ID_LIKE:-${ID:-}}" in
  *debian*|*ubuntu*|ubuntu|debian) PKG_OK=1 ;;
  *) PKG_OK=0 ;;
esac
if [ "$SKIP_PACKAGES" = 0 ] && [ "$PKG_OK" = 0 ]; then
  die "This script targets Ubuntu/Debian. On another distro, install the equivalents and re-run with --skip-packages."
fi

# ---------- 1: system packages ----------
if [ "$SKIP_PACKAGES" = 0 ]; then
  step "Installing system packages (sudo required)"

  # Node 22 LTS
  if ! ( have node && node --version | grep -q '^v22\.' ); then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    ok "Node $(node --version) already installed"
  fi

  # Everything else in one apt call
  sudo apt-get install -y \
    "python${PY_VER}" "python${PY_VER}-venv" \
    git gh curl unzip \
    alsa-utils pulseaudio-utils pipewire-bin \
    playerctl wmctrl xdotool xdg-utils \
    gnome-screenshot || warn "some optional packages may have failed — fine if it's just gnome-screenshot on KDE"

  # uv (Python venv/installer)
  if ! have uv; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  else
    ok "uv $(uv --version) already installed"
  fi
fi

# ---------- 2: get the repo ----------
step "Locating the repo"
if [ -d "orchestrator" ] && [ -f "package.json" ]; then
  ok "Already inside the jarvis repo at $(pwd)"
elif [ -d "${REPO_NAME}/orchestrator" ]; then
  cd "$REPO_NAME"
  ok "Found existing clone at $(pwd)"
else
  if ! have gh; then die "gh CLI not found and clone not detected — re-run after gh is installed."; fi
  if ! gh auth status >/dev/null 2>&1; then
    warn "GitHub CLI not signed in. Running 'gh auth login' (interactive)..."
    gh auth login
  fi
  gh repo clone "${GH_OWNER}/${REPO_NAME}" || git clone "$REPO_HTTPS"
  cd "$REPO_NAME"
fi

# ---------- 3: .env ----------
step ".env"
if [ ! -f .env ]; then
  cp .env.example .env
  ok "Created .env from .env.example"
  cat <<'EOF'

  Open .env in your editor and set:
    ESP32_BASE_URL    — your relay board's IP (give it a static DHCP lease)
    GEMINI_API_KEY    — optional intent/vision fallback; leave blank to disable
    PC_AGENTS         — optional: name=url for each PC agent (e.g. laptop=http://192.168.1.60:7000)
    PC_AGENT_TOKEN    — shared secret with your PC agents
    PHONE_CAMERA_URL  — optional: IP-webcam snapshot URL for vision
    WEATHER_LAT/LON   — optional: coordinates for weather answers

EOF
  read -rp "  Press Enter when you've edited .env (or Ctrl-C to abort)... " _
else
  ok ".env already present"
fi

# ---------- 4: node deps ----------
step "Installing Node deps (npm install)"
npm install
ok "Node deps installed"

# ---------- 5: python venv + voice deps ----------
step "Python venv + voice service deps"
if [ ! -d .venv ]; then
  uv venv .venv --python "$PY_VER"
fi
# shellcheck disable=SC1091
. .venv/bin/activate
uv pip install -r voice-service/requirements.txt
ok "Voice deps installed"

# ---------- 6: GPU STT runtime (default) ----------
step "GPU STT runtime (faster-whisper on CUDA)"
if have nvidia-smi; then
  uv pip install nvidia-cudnn-cu12 'ctranslate2[cuda]' huggingface-hub
  ok "CUDA STT deps installed — large-v3 downloads from Hugging Face on first run"
else
  warn "nvidia-smi not found. The default .env expects a GPU (WHISPER_DEVICE=cuda)."
  warn "Run CPU-only by editing .env: WHISPER_DEVICE=cpu, WHISPER_MODEL=base (see README)."
fi

# ---------- 7: voice models ----------
if [ "$SKIP_MODELS" = 0 ]; then
  step "Downloading voice models (one-time)"
  mkdir -p voice-service/models
  pushd voice-service/models >/dev/null

  if [ ! -f "$PIPER_ONNX" ]; then
    echo "  Piper voice (en_GB-alan-medium, ~63 MB)..."
    curl -L --fail -O "${PIPER_BASE}/${PIPER_ONNX}"
    curl -L --fail -O "${PIPER_BASE}/${PIPER_ONNX}.json"
    ok "Piper voice ready"
  else
    ok "Piper voice already present"
  fi

  if [ "$WANT_VOSK" = 1 ]; then
    if [ ! -d "$VOSK_DIR" ]; then
      echo "  Vosk lgraph model (~205 MB)..."
      curl -L --fail -o vosk.zip "$VOSK_URL"
      unzip -q vosk.zip && rm vosk.zip
      ok "Vosk model ready (set VOICE_STT_BACKEND=vosk in .env to use it)"
    else
      ok "Vosk model already present"
    fi
  fi
  popd >/dev/null
fi

# ---------- 8: verify ----------
if [ "$SKIP_TESTS" = 0 ]; then
  step "Running tests"
  npm test 2>&1 | tail -10
  npm test 2>&1 | grep -qE '^# fail 0' || die "Backend tests failed — see output above."
  ok "Backend: 0 failing"

  .venv/bin/python -m unittest discover -s voice-service/tests 2>&1 | tail -3
  .venv/bin/python -m unittest discover -s voice-service/tests 2>&1 | grep -q '^OK$' || die "Voice tests failed."
  ok "Voice: OK"
fi

# ---------- 9: done ----------
cat <<'EOF'

──────────────────────────────────────────────
✓ JARVIS is set up on this host.
──────────────────────────────────────────────

Per-host customization (optional, but recommended before first launch):
  • orchestrator/pc/apps-aliases.json  — map spoken shortcuts to the apps you
                                         actually have installed (chrome may
                                         be chromium, etc.)
  • orchestrator/pc/shell-recipes.json — host-specific shell recipes
  • Make sure the ESP32 (per ESP32_BASE_URL in .env) is reachable on this LAN.

Launch:
  ./run-jarvis.sh

Then open http://localhost:3000/  •  say "jarvis"  •  click ↻ on the Devices
widget to confirm board state.

Things to try (spoken, or typed in the dashboard command box):
  open chrome
  play discover weekly          (search + play)
  search for machine learning   (Google in the default browser)
  split chrome with code        (tile two windows)
  run free space                (recipe — will ask "confirm" before executing)

If anything failed above, re-run with the relevant --skip-* flag and check the README.
EOF
