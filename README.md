# Local-First PII Sanitization Tool

A privacy-first, local-only system for detecting and sanitizing personally identifiable information (PII) before text is shared with external applications such as email clients, documents, chat platforms, or AI tools.

## Docker Quick Start (Recommended)

### Prerequisites

- Docker Desktop (or Docker Engine + Docker Compose)
- Docker daemon running

### Run with Docker

Preferred (uses `run.sh` to auto-select CPU vs NVIDIA compose config):

```bash
./run.sh up --build
```

When startup completes, open:

- `http://localhost:8787/`

### Stop

- `Ctrl + C` in the terminal running compose
- Optional cleanup:

```bash
./run.sh down
```

### Issues with the Spancat Model
If you see the following error:
```bash
 [NER server] stderr: [ner_server] SpanCat load FAILED: Cannot load file containing pickled data when allow_pickle=False
```
Ensure that git-lfs is installed, and pull. 

```bash
sudo apt install git-lfs
git lfs pull
```

## Manual Installation (No Docker)

### Prerequisites

- Node.js (LTS recommended)
- Python 3.9+ (for NER layers)

### Install dependencies

```bash
npm install
```

Install Python dependencies for the local NER server:

```bash
python -m pip install -r requirements.txt
python -m spacy download en_core_web_sm
```

Optional Presidio layer:

```bash
pip install presidio_analyzer
python -m spacy download en_core_web_lg
```

Optional LLM layer:

1. Install [Ollama](https://ollama.com) and pull the default model:
   `ollama pull phi4-mini`
2. Keep Ollama running (`http://localhost:11434`).
3. To disable LLM detection, set `PII_LLM_DISABLE=1`.
4. To use another model, set `PII_OLLAMA_MODEL=<your-model>`.
5. Debug logs: `PII_DEBUG=1` (pipeline + LLM), `PII_LLM_DEBUG=1` (LLM only).

### Running Prototype

```bash
npm run dev
```

If you see Electron errors about `app.isPackaged`, make sure `ELECTRON_RUN_AS_NODE` is not set in your shell.

## PII Layer Pipeline and Speed

The detection pipeline runs in this order:

1. `Regex` (Fast): pattern-based detection for structured PII such as emails, phone numbers, IPs, cards, and IDs.
2. `NER (Spacy)` (Fast): named-entity detection for people, organizations, locations, dates, and times.
3. `Spancat (Spacy)` (Fast to Moderate): span categorization for broader contextual PII spans.
4. `Presidio (Analyzer)` (Moderate): rule/model-backed recognizers focused on common privacy and compliance entities.
5. `NER (BERT)` (Moderate): transformer-based NER for additional person/org/location coverage.
6. `LLM` (VERY Slow): contextual final pass to catch nuanced residual PII after earlier masking.

Notes:

- NER-family layers (`NER (Spacy)`, `Spancat (Spacy)`, `Presidio (Analyzer)`, `NER (BERT)`) run in parallel in the NER stage.
- Speed labels are relative and depend on hardware, model load state, and input size.

## LLM Model Used

- Default model: `phi4-mini`
- Source of default: `PII_OLLAMA_MODEL` environment variable fallback in code
- Docker compose also sets `PII_OLLAMA_MODEL=phi4-mini`

## Core Features

- Local PII detection with labeled span highlighting
- Sanitized output with consistent placeholder replacement
- User-controlled persistent rules (always sensitive / never sensitive)
- Designed for safe use with external tools and LLMs

## Testing

Evaluation is performed using a fixed regression suite of labeled "golden" examples and synthetic data for stress testing. Metrics include span-level precision, recall, leakage rate, over-masking rate, and local performance (latency and memory).

## Privacy Guarantees

- Computation is local
- No raw text leaves the device
- No remote storage or telemetry
