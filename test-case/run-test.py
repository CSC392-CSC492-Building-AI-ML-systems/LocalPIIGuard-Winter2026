import random
import subprocess
import json
import time
from datasets import load_dataset
import re

valid_label = {
    "first_name": "NAME",
    "last_name": "NAME",
    "NAME": "NAME"
}

def parse_text(text, pii, label_name='type'):
    # Split the text into words while keeping track of character offsets
    words = []
    offset = 0
    for word in re.findall(r'\S+', text):
        start = text.find(word, offset)
        end = start + len(word)
        words.append({'word': word, 'start': start, 'end': end})
        offset = end
    # Assign labels
    word_labels = []
    for w in words:
        label = ""
        for e in pii:
            if e[label_name] not in valid_label:
                continue 
            # If the word overlaps with an entity, assign the label
            if w['start'] < e['end'] and w['end'] > e['start']:
                label = valid_label[e[label_name]]
                break
        word_labels.append(label)
    return word_labels


def detect_texts(texts, detector_type=1):
    """
    Run the Node.js NerDetector CLI with a list of strings and a detector type.
    Returns a tuple (results, duration_seconds).
    """
    input_json = json.dumps(texts)

    start_time = time.perf_counter()

    proc = subprocess.run(
        ["node", "test-case.cjs", input_json, str(detector_type)],
        capture_output=True,
        text=True
    )

    end_time = time.perf_counter()
    duration = end_time - start_time

    if proc.returncode != 0:
        raise RuntimeError(f"Node.js error:\n{proc.stderr}")

    results = json.loads(proc.stdout)
    return results, duration


# load NVIDIA Nemotron‑PII dataset
# Example usage
if __name__ == "__main__":
    dataset = load_dataset("nvidia/Nemotron-PII")
    test_set = dataset['test'].filter(
            lambda x: x['locale'] == "us"
        ).select_columns(['text', 'spans', 'locale'])

    texts = test_set["text"]
    all_spans = test_set["spans"]

    sample_size = 100
    indices = random.sample(range(len(texts)), sample_size) 
    sample_texts = [texts[i] for i in indices]
    sample_spans = [all_spans[i] for i in indices]
    
    results, duration = detect_texts(sample_texts, detector_type=2)
    
    TP = FP = TN = FN = 0
    word_count = 0
    for text, res, correct_res in zip(sample_texts, results, sample_spans):
        try:
            correct_res = json.loads(correct_res.replace("'", '"'))
        except Exception as e:
            print(e)
            continue
        out = parse_text(text, res)
        out_2 = parse_text(text, correct_res, label_name="label")
        word_count += len(out)
        for pred, true in zip(out, out_2):
            if pred == "NAME" and true == "NAME":
                TP += 1
            elif pred == "NAME" and true == "":
                FP += 1
            elif pred == "" and true == "":
                TN += 1
            elif pred == "" and true == "NAME":
                FN += 1
    print(f"Subprocess took {duration:.3f} seconds processing {word_count} word\n")
    print(f"True Positives (TP): {TP}")
    print(f"False Positives (FP): {FP}")
    print(f"True Negatives (TN): {TN}")
    print(f"False Negatives (FN): {FN}")
