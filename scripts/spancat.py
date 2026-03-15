import spacy, json, sys, os

SPANS_KEY = "pii"  # default spancat key — change if your model uses a different one

def main() -> None:
    text = sys.stdin.read()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, '..', 'pii_spancat_model')
    
    nlp = spacy.load(model_path)
    doc = nlp(text)
    span_group = doc.spans.get(SPANS_KEY, [])

    scores = []
    if hasattr(span_group, 'attrs') and 'scores' in span_group.attrs:
        scores = span_group.attrs['scores']

    entities = [
        {
            'start': span.start_char,
            'end': span.end_char,
            'label': span.label_,
            'text': span.text,
            'score': float(scores[i]) if i < len(scores) else None,
        }
        for i, span in enumerate(span_group)
    ]
    sys.stdout.write(json.dumps(entities, ensure_ascii=True))

if __name__ == '__main__':
    main()