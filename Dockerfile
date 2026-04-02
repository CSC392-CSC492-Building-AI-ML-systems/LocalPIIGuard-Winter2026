FROM node:20-bookworm

# System packages: Python + build/runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ca-certificates zstd \
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
COPY requirements.txt ./
COPY scripts/requirements-spacy.txt scripts/requirements-bert.txt ./scripts/
RUN python3 -m venv /opt/pii-venv \
    && /opt/pii-venv/bin/pip install --upgrade pip \
    && /opt/pii-venv/bin/pip install --no-cache-dir --timeout=120 -r requirements.txt \
    && /opt/pii-venv/bin/pip install --no-cache-dir \
        https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.7.1/en_core_web_sm-3.7.1-py3-none-any.whl

# Copy the rest of the source
COPY . .

# Build frontend + backend for production serving
RUN npm run build

EXPOSE 8787

ENV PII_SPACY_PY=/opt/pii-venv/bin/python3
ENV PII_BERT_PY=/opt/pii-venv/bin/python3
ENV PII_NER_PY=/opt/pii-venv/bin/python3
ENV NODE_ENV=production
ENV PII_WEB_PORT=8787

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
