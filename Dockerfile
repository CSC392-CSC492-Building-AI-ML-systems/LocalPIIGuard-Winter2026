FROM node:20-bookworm

# System packages: Python, Xvfb, x11vnc, noVNC, Electron runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ca-certificates zstd \
    xvfb x11vnc novnc websockify \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
    libatspi2.0-0 libdrm2 libgbm1 libxcb-dri3-0 \
    libxcomposite1 libxcursor1 libxdamage1 libxrandr2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama and pull the model at build time
RUN curl -fsSL https://ollama.com/install.sh | sh
RUN ollama serve & \
    sleep 5 && \
    ollama pull phi4-mini && \
    pkill ollama

WORKDIR /app

# Install Node dependencies before copying all source (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Set up an isolated Python venv and install both script dependency sets
COPY scripts/requirements-spacy.txt scripts/requirements-bert.txt ./scripts/
RUN python3 -m venv /opt/pii-venv \
    && /opt/pii-venv/bin/pip install --upgrade pip \
    && /opt/pii-venv/bin/pip install --no-cache-dir --timeout=120 \
        -r scripts/requirements-spacy.txt \
        -r scripts/requirements-bert.txt \
    && /opt/pii-venv/bin/pip install --no-cache-dir \
        https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.7.1/en_core_web_sm-3.7.1-py3-none-any.whl

# Custom noVNC pages: landing page + fixed-size app viewer
COPY docker/novnc-index.html /usr/share/novnc/index.html
COPY docker/novnc-app.html /usr/share/novnc/app.html

# Copy the rest of the source
COPY . .

# noVNC port
EXPOSE 6080

ENV PII_SPACY_PY=/opt/pii-venv/bin/python3
ENV PII_BERT_PY=/opt/pii-venv/bin/python3
ENV NODE_ENV=production
ENV DISPLAY=:99

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
