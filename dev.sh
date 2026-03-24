#!/bin/bash
set -e

NODE_ENV=development \
PII_SPACY_PY=/Users/mohamedredamahboub/venv/bin/python3.13 \
PII_BERT_PY=/Users/mohamedredamahboub/venv/bin/python3.13 \
PII_LLM_DEBUG=1 \
PII_OLLAMA_BASE=http://127.0.0.1:11434 \
npm run dev
