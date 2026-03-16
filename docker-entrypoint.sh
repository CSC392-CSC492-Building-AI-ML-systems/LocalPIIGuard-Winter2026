#!/bin/bash
set -e

echo "==> Starting Xvfb virtual display on :99..."
Xvfb :99 -screen 0 900x600x24 -ac &
sleep 1

echo "==> Starting Ollama service..."
ollama serve &

echo "==> Waiting for Ollama to become ready..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
    sleep 1
done
echo "    Ollama is ready."

echo "==> Building Electron TypeScript..."
npm run build:electron

echo "==> Starting Vite dev server..."
npm run dev:vite &

echo "==> Waiting for Vite to be ready..."
until curl -sf http://localhost:5173 > /dev/null 2>&1; do
    sleep 1
done
echo "    Vite is ready."

echo "==> Starting Electron..."
./node_modules/.bin/electron --no-sandbox . > /tmp/electron.log 2>&1 &
sleep 3
echo "--- Electron log ---"
cat /tmp/electron.log
echo "--------------------"

echo "==> Starting x11vnc..."
# This is a bit of a workaround since we can't start electron as a website directly. 
x11vnc -display :99 -nopw -listen localhost -xkb -forever -shared -rfbport 5900 > /tmp/x11vnc.log 2>&1 &
sleep 2

echo "==> Starting noVNC on port 6080..."
exec websockify --web /usr/share/novnc/ 6080 localhost:5900
