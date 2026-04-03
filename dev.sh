#!/usr/bin/env bash
# dev.sh — set up the Python environment then launch the Electron dev server.
#
# What this script does (skipping any step that is already done):
#   1. Locate or create a Python virtual environment
#   2. Install Python dependencies from requirements.txt
#   3. Download the spaCy en_core_web_sm model
#   4. Ensure Ollama is running and pre-warm the LLM model
#   5. Start the Electron + Vite dev servers
#
# Usage:
#   ./dev.sh              # normal run
#   VENV_DIR=~/.myvenv ./dev.sh   # point at an existing venv

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS="$REPO_DIR/requirements.txt"

# ── 1. Locate or create venv ──────────────────────────────────────────────────

# Prefer an explicit override, then a project-local .venv, then a sibling venv.
if [[ -n "${VENV_DIR:-}" ]]; then
  echo "[setup] Using venv from VENV_DIR: $VENV_DIR"
elif [[ -d "$REPO_DIR/.venv/bin" ]]; then
  VENV_DIR="$REPO_DIR/.venv"
  echo "[setup] Found project-local venv: $VENV_DIR"
elif [[ -d "$HOME/venv/bin" ]]; then
  VENV_DIR="$HOME/venv"
  echo "[setup] Found user venv: $VENV_DIR"
else
  VENV_DIR="$REPO_DIR/.venv"
  echo "[setup] No venv found – creating one at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# Resolve the first working Python binary inside the venv (handles broken symlinks).
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
  bin="$VENV_DIR/bin/$candidate"
  if [[ -x "$bin" ]] && "$bin" -c "" 2>/dev/null; then
    PYTHON="$bin"
    break
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "[setup] ERROR: No working Python executable found in $VENV_DIR/bin/" >&2
  exit 1
fi

PIP="$VENV_DIR/bin/pip"

echo "[setup] Python: $($PYTHON --version) ($PYTHON)"

# ── 2. Install Python dependencies ───────────────────────────────────────────

# Check if all key packages are importable; skip pip install if they are.
if "$PYTHON" -c "import flask, spacy, presidio_analyzer, transformers, torch" 2>/dev/null; then
  echo "[setup] Python dependencies already installed – skipping"
else
  echo "[setup] Installing Python dependencies from requirements.txt …"
  "$PIP" install -r "$REQUIREMENTS" --quiet
  echo "[setup] Python dependencies installed"
fi

# ── 3. Download spaCy model ───────────────────────────────────────────────────

if "$PYTHON" -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null; then
  echo "[setup] spaCy en_core_web_sm already present – skipping"
else
  echo "[setup] Downloading spaCy en_core_web_sm …"
  "$PYTHON" -m spacy download en_core_web_sm
fi

# ── 4. Install Node dependencies ─────────────────────────────────────────────

if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  echo "[setup] Installing Node dependencies …"
  npm install --prefix "$REPO_DIR"
fi

# ── 5. Ensure Ollama is running ───────────────────────────────────────────────

OLLAMA_BASE="${PII_OLLAMA_BASE:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${PII_OLLAMA_MODEL:-phi4-mini}"

if curl -s --max-time 3 "$OLLAMA_BASE/api/tags" > /dev/null 2>&1; then
  echo "[setup] Ollama already running at $OLLAMA_BASE"
else
  echo "[setup] Ollama not detected – starting it …"
  if ! command -v ollama &> /dev/null; then
    echo "[setup] WARNING: 'ollama' command not found – LLM detection will be unavailable" >&2
  else
    ollama serve > /dev/null 2>&1 &
    echo "[setup] Waiting for Ollama to be ready …"
    for i in $(seq 1 20); do
      sleep 1
      if curl -s --max-time 2 "$OLLAMA_BASE/api/tags" > /dev/null 2>&1; then
        echo "[setup] Ollama is ready"
        break
      fi
      if [[ $i -eq 20 ]]; then
        echo "[setup] WARNING: Ollama did not respond after 20 s – LLM detection may be unavailable" >&2
      fi
    done
  fi
fi

# Pre-warm the model in the background so it is loaded before the first scan.
if curl -s --max-time 2 "$OLLAMA_BASE/api/tags" > /dev/null 2>&1; then
  echo "[setup] Pre-warming $OLLAMA_MODEL in background …"
  curl -s --max-time 300 -X POST "$OLLAMA_BASE/api/chat" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$OLLAMA_MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\".\"}]}" \
    > /dev/null 2>&1 &
fi

# ── 6. Launch the app ─────────────────────────────────────────────────────────

echo "[setup] Setup complete – launching app"
echo ""

cd "$REPO_DIR"
NODE_ENV=development \
PII_NER_PY="$PYTHON" \
PII_OLLAMA_BASE="$OLLAMA_BASE" \
npm run dev
