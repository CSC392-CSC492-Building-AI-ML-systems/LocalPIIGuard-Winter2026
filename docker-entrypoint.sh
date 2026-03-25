#!/bin/bash
set -e

if command -v ollama >/dev/null 2>&1; then
  echo "==> Starting Ollama service..."
  ollama serve > /tmp/ollama.log 2>&1 &
  echo "==> Waiting for Ollama to become ready..."
  for _ in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo "    Ollama is ready."
      break
    fi
    sleep 1
  done
else
  echo "==> Ollama not installed in image; LLM detector may be unavailable."
fi

echo "==> Starting LocalPIIGuard web server..."
exec node /app/dist-server/server/index.js