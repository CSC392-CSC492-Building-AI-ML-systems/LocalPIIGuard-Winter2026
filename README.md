## Docker Quick Start (Recommended)

### Prerequisites

* Docker Desktop (or Docker Engine + Docker Compose)
* Docker daemon running

### Run with Docker

From the project root:

```bash
docker compose up --build
```

When startup completes, open:

* `http://localhost:6080/` (popup launcher)
* If needed: `http://localhost:6080/app.html` (direct app view)

### Stop

* `Ctrl + C` in the terminal running compose
* Optional cleanup:

```bash
docker compose down
```

---

## Manual Installation (No Docker)

### Prerequisites

* Node.js (LTS recommended)
* Python 3.9+ (for spaCy NER)

### Install dependencies

```bash
npm install
```

Install this for the spaCy NER layer:

```bash
python -m pip install -r scripts/requirements-spacy.txt
python -m spacy download en_core_web_sm
```

Optional — for the **LLM** detector layer:

1. Install [Ollama](https://ollama.com) and run: `ollama pull mistral:7b-instruct-v0.3-q4_K_M` (or another model; set `PII_OLLAMA_MODEL` to match).
2. Keep Ollama running (it serves `http://localhost:11434`). The app will call it when the "LLM" PII layer is enabled in the UI.
3. To disable the LLM layer without uninstalling: set env `PII_LLM_DISABLE=1`. To use another model: `PII_OLLAMA_MODEL=your-model`. Debug logs: `PII_DEBUG=1` (scan/merge pipeline + LLM detector), or `PII_LLM_DEBUG=1` (LLM detector only).

## Running prototype

```bash
npm run dev
```
If you see Electron errors about `app.isPackaged`, make sure `ELECTRON_RUN_AS_NODE` is not set in your shell.

# Local-First PII Sanitization Tool

A privacy-first, local-only system for detecting and sanitizing personally identifiable information (PII) before text is shared with external applications such as email clients, documents, chat platforms, or AI tools.

## Overview

This project implements an on-device pipeline that detects sensitive information, highlights it with labels and confidence scores, and produces a sanitized version of the text using consistent placeholders or synthetic replacements. All processing occurs locally; no raw text is transmitted or stored remotely.

## Core Features

* Local PII detection with labeled span highlighting
* Sanitized output with consistent placeholder replacement
* User-controlled persistent rules (always sensitive / never sensitive)
* Designed for safe use with external tools and LLMs

## High-Level

* Regex-based detectors for structured PII (e.g. phone numbers, IDs)
* NER models for ambiguous PII (e.g. names, locations)
* Contextual LLM layer for improved detection accuracy
* Simple and clean front-end UI/UX

## Testing

Evaluation is performed using a fixed regression suite of labeled â€œgoldenâ€ examples and synthetic data for stress testing. Metrics include span-level precision, recall, leakage rate, over-masking rate, and local performance (latency and memory).

## Privacy Guarantees

* Computation is local
* No raw text leaves the device
* No remote storage or telemetry
