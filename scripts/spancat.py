import spacy, json, sys, os

SPANS_KEY = "pii"  # default spancat key — change if your model uses a different one

def main() -> None:
    text = sys.stdin.read()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, '..', 'pii_spancat_model')
    
    nlp = spacy.load(model_path)
    doc = nlp(text)
    spans = doc.spans.get(SPANS_KEY, [])
    entities = [
        {
            'start': span.start_char,
            'end': span.end_char,
            'label': span.label_,
            'text': span.text,        
            }
        for span in spans
    ]
    sys.stdout.write(json.dumps(entities, ensure_ascii=True))

if __name__ == '__main__':
    main()