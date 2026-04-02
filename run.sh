#!/bin/bash
# Wrapper script that detects the available GPU and runs the appropriate docker compose configuration.
# Usage: ./run.sh [docker compose arguments]
#   e.g. ./run.sh up --build
#        ./run.sh down

set -e

detect_gpu() {
    # NVIDIA: check for nvidia-smi or the nvidia device node
    if command -v nvidia-smi &>/dev/null || [ -e /dev/nvidia0 ]; then
        echo "nvidia"
        return
    fi

    echo "cpu"
}

GPU=$(detect_gpu)

case "$GPU" in
    nvidia)
        echo "[run.sh] NVIDIA GPU detected — using docker-compose.nvidia.yml"
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.nvidia.yml"
        ;;
    cpu)
        echo "[run.sh] No supported GPU detected — running CPU-only"
        COMPOSE_FILES="-f docker-compose.yml"
        ;;
esac

exec docker compose $COMPOSE_FILES "$@"
