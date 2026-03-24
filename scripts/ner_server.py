#!/usr/bin/env python3
"""
Persistent NER HTTP server for LocalPIIGuard.

Loads spaCy NER, SpanCat, Presidio, and BERT NER models once at startup.
Prints "PORT=<n>" then "READY" to stdout so the Electron host can detect readiness.
Self-terminates (orphan guard) when the parent Electron process exits.

Environment variables:
  PII_NER_PORT       Preferred TCP port (default 5001). Falls back to OS-assigned if busy.
  PII_BERT_MODEL     HuggingFace model name for BERT NER (default dslim/bert-large-NER).
  PII_SPACY_DISABLE  Set to "1" to skip loading / serving spaCy NER.
  PII_SPANCAT_DISABLE Set to "1" to skip loading / serving SpanCat.
  PII_PRESIDIO_DISABLE Set to "1" to skip loading / serving Presidio.
  PII_BERT_DISABLE   Set to "1" to skip loading / serving BERT NER.
  PII_DEBUG          Set to "1" for verbose stderr output.
"""

import json
import logging
import os
import signal
import socket
import sys
import threading
import time

# Silence Werkzeug request logs – Electron receives structured stdout/stderr.
logging.getLogger('werkzeug').setLevel(logging.ERROR)

PII_DEBUG = os.environ.get('PII_DEBUG', '').lower() in ('1', 'true', 'yes')

DISABLE_SPACY    = os.environ.get('PII_SPACY_DISABLE', '')    .lower() in ('1', 'true', 'yes')
DISABLE_SPANCAT  = os.environ.get('PII_SPANCAT_DISABLE', '')  .lower() in ('1', 'true', 'yes')
DISABLE_PRESIDIO = os.environ.get('PII_PRESIDIO_DISABLE', '') .lower() in ('1', 'true', 'yes')
DISABLE_BERT     = os.environ.get('PII_BERT_DISABLE', '')     .lower() in ('1', 'true', 'yes')

SPANCAT_SPANS_KEY = 'pii'
PRESIDIO_MIN_SCORE = 0.3


def _log(*args: object) -> None:
    print('[ner_server]', *args, file=sys.stderr, flush=True)


def _debug(*args: object) -> None:
    if PII_DEBUG:
        _log(*args)


# ── Model handles (None = not loaded or disabled) ────────────────────────────

_spacy_nlp       = None
_spancat_nlp     = None
_presidio        = None
_bert_ner        = None


# ── Port selection ────────────────────────────────────────────────────────────

def _find_port(preferred: int) -> int:
    """Try the preferred port first; fall back to an OS-assigned free port."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError('Could not bind to any port')


# ── Orphan guard ──────────────────────────────────────────────────────────────

def _watchdog(parent_pid: int) -> None:
    """Terminate this process if the parent (Electron) is no longer alive."""
    while True:
        time.sleep(3)
        try:
            os.kill(parent_pid, 0)  # signal 0 = existence check
        except (ProcessLookupError, PermissionError):
            _log('parent process gone – shutting down')
            os.kill(os.getpid(), signal.SIGTERM)
            return


# ── Model loading ─────────────────────────────────────────────────────────────

def _load_models() -> None:
    global _spacy_nlp, _spancat_nlp, _presidio, _bert_ner

    script_dir = os.path.dirname(os.path.abspath(__file__))

    if not DISABLE_SPACY:
        try:
            import spacy
            _spacy_nlp = spacy.load('en_core_web_sm')
            _log('spaCy NER loaded')
        except Exception as exc:
            _log(f'spaCy NER load FAILED: {exc}')

    if not DISABLE_SPANCAT:
        try:
            import spacy as _spacy  # type: ignore[import]
            model_path = os.path.join(script_dir, '..', 'pii_spancat_model')
            _spancat_nlp = _spacy.load(model_path)
            _log('SpanCat loaded')
        except Exception as exc:
            _log(f'SpanCat load FAILED: {exc}')

    if not DISABLE_PRESIDIO:
        try:
            from presidio_analyzer import AnalyzerEngine
            _presidio = AnalyzerEngine()
            _log('Presidio loaded')
        except Exception as exc:
            _log(f'Presidio load FAILED: {exc}')

    if not DISABLE_BERT:
        try:
            import torch
            from transformers import pipeline as hf_pipeline
            model_name = os.environ.get('PII_BERT_MODEL', 'dslim/bert-large-NER')
            device = 0 if torch.cuda.is_available() else -1
            _debug(f'loading BERT model {model_name!r} on device {device}')
            _bert_ner = hf_pipeline(
                'ner',
                model=model_name,
                aggregation_strategy='simple',
                device=device,
            )
            _log('BERT NER loaded')
        except Exception as exc:
            _log(f'BERT NER load FAILED: {exc}')


# ── Flask application ─────────────────────────────────────────────────────────

from flask import Flask, request, jsonify  # noqa: E402  (import after env setup)

app = Flask(__name__)


@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'models': {
            'spacy':    _spacy_nlp   is not None,
            'spancat':  _spancat_nlp is not None,
            'presidio': _presidio    is not None,
            'bert':     _bert_ner    is not None,
        },
    })


@app.route('/spacy', methods=['POST'])
def spacy_route():
    if _spacy_nlp is None:
        return jsonify([])
    text = (request.get_json(silent=True) or {}).get('text', '')
    if not text.strip():
        return jsonify([])
    try:
        doc = _spacy_nlp(text)
        return jsonify([
            {'start': e.start_char, 'end': e.end_char, 'label': e.label_, 'text': e.text}
            for e in doc.ents
        ])
    except Exception as exc:
        _log(f'/spacy error: {exc}')
        return jsonify([])


@app.route('/spancat', methods=['POST'])
def spancat_route():
    if _spancat_nlp is None:
        return jsonify([])
    text = (request.get_json(silent=True) or {}).get('text', '')
    if not text.strip():
        return jsonify([])
    try:
        doc = _spancat_nlp(text)
        span_group = doc.spans.get(SPANCAT_SPANS_KEY, [])
        scores: list = []
        if hasattr(span_group, 'attrs') and 'scores' in span_group.attrs:
            scores = span_group.attrs['scores']
        return jsonify([
            {
                'start': span.start_char,
                'end':   span.end_char,
                'label': span.label_,
                'text':  span.text,
                'score': float(scores[i]) if i < len(scores) else None,
            }
            for i, span in enumerate(span_group)
        ])
    except Exception as exc:
        _log(f'/spancat error: {exc}')
        return jsonify([])


@app.route('/presidio', methods=['POST'])
def presidio_route():
    if _presidio is None:
        return jsonify([])
    text = (request.get_json(silent=True) or {}).get('text', '')
    if not text.strip():
        return jsonify([])
    try:
        results = _presidio.analyze(text=text, language='en')
        return jsonify([
            {
                'start': r.start,
                'end':   r.end,
                'label': r.entity_type,
                'text':  text[r.start:r.end],
                'score': r.score,
            }
            for r in results
            if r.score >= PRESIDIO_MIN_SCORE
        ])
    except Exception as exc:
        _log(f'/presidio error: {exc}')
        return jsonify([])


@app.route('/bert', methods=['POST'])
def bert_route():
    if _bert_ner is None:
        return jsonify([])
    text = (request.get_json(silent=True) or {}).get('text', '')
    if not text.strip():
        return jsonify([])
    try:
        results = _bert_ner(text)
        _debug(f'/bert raw results: {len(results)}')
        return jsonify([
            {
                'start': int(e['start']),
                'end':   int(e['end']),
                'label': e['entity_group'],
                'text':  e['word'],
            }
            for e in results
        ])
    except Exception as exc:
        _log(f'/bert error: {exc}')
        return jsonify([])


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parent_pid = os.getppid()

    # Orphan guard runs in a daemon thread so it doesn't block shutdown.
    threading.Thread(target=_watchdog, args=(parent_pid,), daemon=True).start()

    _load_models()

    preferred = int(os.environ.get('PII_NER_PORT', '5001'))
    port = _find_port(preferred)
    if port != preferred:
        _log(f'preferred port {preferred} busy, using {port}')

    # Signal readiness to Electron (parsed from stdout).
    print(f'PORT={port}', flush=True)
    print('READY', flush=True)

    # threaded=True allows concurrent requests from Promise.all in main.ts.
    app.run(host='127.0.0.1', port=port, threaded=True, use_reloader=False)
