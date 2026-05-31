#!/usr/bin/env bash
# JARVIS — one-command bootstrap for a new Linux host (Ubuntu / Debian).
#
# Fresh machine (downloads & clones):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Arcco-Chakraborty/jarvis/main/setup-new-pc.sh)
#
# Or if you've already cloned the repo:
#   cd jarvis && ./setup-new-pc.sh
#
# Flags:
#   --skip-packages    don't apt-install system deps (you've handled them)
#   --skip-models      don't download Vosk + Piper (you'll do it manually)
#   --skip-tests       don't run npm/python test suites at the end
#   --gpu              also install CUDA-side STT deps (assumes nvidia-smi works)
#   -h | --help        show usage

set -euo pipefail

# ---------- config ----------
GH_OWNER="Arcco-Chakraborty"
REPO_NAME="jarvis"
REPO_HTTPS="https://github.com/${GH_OWNER}/${REPO_NAME}.git"
PY_VER="3.12"

VOSK_URL="https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip"
VOSK_DIR="vosk-model-en-us-0.22-lgraph"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
PIPER_ONNX="en_US-lessac-medium.onnx"

# ---------- helpers ----------
step()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ---------- flags ----------
SKIP_PACKAGES=0; SKIP_MODELS=0; SKIP_TESTS=0; WANT_GPU=0
for arg in "$@"; do
  case "$arg" in
    --skip-packages) SKIP_PACKAGES=1 ;;
    --skip-models)   SKIP_MODELS=1 ;;
    --skip-tests)    SKIP_TESTS=1 ;;
    --gpu)           WANT_GPU=1 ;;
    -h|--help)       sed -n '2,16p' "$0"; exit 0 ;;
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
  warn "Non-Debian host detected — pass --skip-packages and install equivalents yourself."
  exit 1
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
    alsa-utils pulseaudio-utils \
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
  cat <<EOF

  Open .env in your editor and set:
    ESP32_BASE_URL    — your relay board (default already set if reused; mine is http://192.168.0.202)
    GEMINI_API_KEY    — optional intent fallback; leave blank to disable
    WEATHER_LAT/LON   — optional override (defaults to Pilani 28.36, 75.59)
    PC_AGENT_TOKEN    — unused yet (Phase 3 LAN agent); leave default

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

# ---------- 6: voice models ----------
if [ "$SKIP_MODELS" = 0 ]; then
  step "Downloading voice models (~270 MB, one-time)"
  mkdir -p voice-service/models
  pushd voice-service/models >/dev/null

  if [ ! -d "$VOSK_DIR" ]; then
    echo "  Vosk lgraph (~205 MB)..."
    curl -L --fail -o vosk.zip "$VOSK_URL"
    unzip -q vosk.zip && rm vosk.zip
    ok "Vosk model ready"
  else
    ok "Vosk model already present"
  fi

  if [ ! -f "$PIPER_ONNX" ]; then
    echo "  Piper voice (~63 MB)..."
    curl -L --fail -O "${PIPER_BASE}/${PIPER_ONNX}"
    curl -L --fail -O "${PIPER_BASE}/${PIPER_ONNX}.json"
    ok "Piper voice ready"
  else
    ok "Piper voice already present"
  fi
  popd >/dev/null
fi

# ---------- 7: verify ----------
if [ "$SKIP_TESTS" = 0 ]; then
  step "Running tests"
  npm test 2>&1 | tail -10
  npm test 2>&1 | grep -qE '^# fail 0' || die "Backend tests failed — see output above."
  ok "Backend: 0 failing"

  .venv/bin/python -m unittest discover -s voice-service/tests 2>&1 | tail -3
  .venv/bin/python -m unittest discover -s voice-service/tests 2>&1 | grep -q '^OK$' || die "Voice tests failed."
  ok "Voice: OK"
fi

# ---------- 8: optional GPU STT ----------
if [ "$WANT_GPU" = 1 ]; then
  step "Installing CUDA STT deps (faster-whisper)"
  if ! have nvidia-smi; then
    warn "nvidia-smi not found — skipping GPU bits (do this after the NVIDIA driver is installed)."
  else
    uv pip install nvidia-cudnn-cu12 'ctranslate2[cuda]' huggingface-hub
    echo
    echo "  Suggested .env edits:"
    echo "    VOICE_STT_BACKEND=whisper"
    echo "    WHISPER_MODEL=distil-large-v3"
    echo "    WHISPER_COMPUTE_TYPE=float16"
    echo
    echo "  Then download the model:"
    echo "    .venv/bin/huggingface-cli download Systran/faster-distil-whisper-large-v3"
    echo
  fi
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

Phase 3.5 commands you can try (typed in the dashboard command box):
  open chrome
  play discover weekly         (search Spotify)
  search about machine learning (Google in default browser)
  split chrome with code        (tile two windows)
  run free space                (recipe — will ask "confirm" before executing)

If anything failed above, ping back with the output and we'll debug.
EOF
