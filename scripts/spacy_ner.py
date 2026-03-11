import json
import sys
import spacy

def main() -> None:
    text = sys.stdin.read()
    nlp = spacy.load('en_core_web_sm')
    doc = nlp(text)
    entities = [
        {
            'start': ent.start_char,
            'end': ent.end_char,
            'label': ent.label_,
            'text': ent.text,
        }
        for ent in doc.ents
    ]
    sys.stdout.write(json.dumps(entities, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == '__main__':
    main()
