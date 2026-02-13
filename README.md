## Installation

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