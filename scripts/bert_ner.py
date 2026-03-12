import json
import os
import sys

import torch
from transformers import pipeline


PII_DEBUG = os.environ.get('PII_DEBUG', '').lower() in ('1', 'true', 'yes')


def debug(*args: object) -> None:
    if PII_DEBUG:
        print('[PII BERT]', *args, file=sys.stderr)


def main() -> None:
    text = sys.stdin.read()
    if not text.strip():
        sys.stdout.write(json.dumps([], ensure_ascii=True))
        return

    model_name = os.environ.get('PII_BERT_MODEL', 'dslim/bert-large-NER')

    if torch.cuda.is_available():
        device = 0  # first CUDA device
        debug('CUDA available, using GPU', torch.cuda.get_device_name(0))
    else:
        device = -1  # CPU
        debug('CUDA not available, using CPU')

    debug('loading model', model_name, 'on device', device)

    ner = pipeline(
        'ner',
        model=model_name,
        aggregation_strategy='simple',
        device=device,
    )

    debug('running inference, text length:', len(text))
    results = ner(text)
    debug('raw results count:', len(results))

    entities = [
        {
            'start': int(ent['start']),
            'end': int(ent['end']),
            'label': ent['entity_group'],
            'text': ent['word'],
        }
        for ent in results
    ]

    debug('entities:', entities)
    sys.stdout.write(json.dumps(entities, ensure_ascii=True))


if __name__ == '__main__':
    main()
