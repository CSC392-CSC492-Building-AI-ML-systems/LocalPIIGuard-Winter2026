import json
import sys

from presidio_analyzer import AnalyzerEngine

def main() -> None:
    # Read input from stdin
    text = sys.stdin.read()
    analyzer = AnalyzerEngine()
    
    results = analyzer.analyze(text=text, language='en')
    

    # Map Presidio results to your desired dictionary format
    entities = [
        {
            'start': res.start, 
            'end': res.end,
            'label': res.entity_type,
            'text': text[res.start:res.end],
            'score': res.score,  # Presidio provides a confidence score
        }
        for res in results
    ]
    
    # Output JSON to stdout
    sys.stdout.write(json.dumps(entities, ensure_ascii=True))
    sys.stdout.flush()

if __name__ == '__main__':
    main()

