import ast
import json
import time
import random
import sys
import ollama
from datasets import load_dataset

FEW_SHOT_1_USER = """Subject: Group Messaging for Admissions Process
Good morning, everyone,
I hope this message finds you well. As we continue our admissions processes, I would like to update you on the latest developments and key information. Please find below the timeline for our upcoming meetings:

wynqvrh053 - Meeting at 10:20am
luka.burg - Meeting at 21
qahl.wittauer - Meeting at quarter past 13
gholamhossein.ruschke - Meeting at 9:47 PM
pdmjrsyoz1460"""

FEW_SHOT_1_ASSISTANT = """{
  items: [
    { value: 'wynqvrh053', label: 'USERNAME' },
    { value: '10:20am', label: 'TIME' },
    { value: 'luka.burg', label: 'USERNAME' },
    { value: '21', label: 'TIME' },
    { value: 'qahl.wittauer', label: 'USERNAME' },
    { value: 'quarter past 13', label: 'TIME' },
    { value: 'gholamhossein.ruschke', label: 'USERNAME' },
    { value: '9:47 PM', label: 'TIME' },
    { value: 'pdmjrsyoz1460', label: 'USERNAME' },
  ],
}"""

FEW_SHOT_2_USER = 'Card: KB90324ER\n Country: GB\n Building: 163\n Street: Conygre Grove\n City: Bristol\n State: ENG\n Postcode: BS34 7HU, BS34 7HZ\n Password: q4R\\n\n2. Applicant: Baasgaran Palmoso\n Email: blerenbaasgara@gmail.com\n Social Number: 107-393-9036\n ID Card: SC78428CU\n Country: United Kingdom\n Building: 646\n Street: School Lane\n City: Altrincham\n State: ENG\n Postcode: WA14 5R';

FEW_SHOT_2_ASSISTANT = """{
  items: [
    { value: 'KB90324ER', label: 'ID' },
    { value: 'GB', label: 'COUNTRY' },
    { value: '163', label: 'BUILDING' },
    { value: 'Conygre Grove', label: 'STREET' },
    { value: 'Bristol', label: 'CITY' },
    { value: 'ENG', label: 'STATE' },
    { value: 'BS34 7HU, BS34 7HZ', label: 'POSTCODE' },
    { value: 'q4R\\\\', label: 'PASS' },
    { value: 'Baasgaran', label: 'LASTNAME' },
    { value: 'Palmoso', label: 'LASTNAME' },
    { value: 'blerenbaasgara@gmail.com', label: 'EMAIL' },
    { value: '107-393-9036', label: 'SOCIALNUMBER' },
    { value: 'SC78428CU', label: 'ID' },
    { value: 'United Kingdom', label: 'COUNTRY' },
    { value: '646', label: 'BUILDING' },
    { value: 'School Lane', label: 'STREET' },
    { value: 'Altrincham', label: 'CITY' },
    { value: 'ENG', label: 'STATE' },
  ],
}"""

labels_list = [
  'EMAIL', 'PHONE', 'IP', 'IPV6', 'MAC', 'CARD', 'IBAN',
  'NAME', 'FIRSTNAME', 'LASTNAME', 'LOCATION', 'ORG', 'DATE',
  'USERNAME', 'TIME', 'ID', 'COUNTRY', 'BUILDING', 'STREET',
  'CITY', 'STATE', 'POSTCODE', 'PASS', 'SOCIALNUMBER',
]

labels_str = ", ".join(labels_list)

system_prompt = f"""You are a PII scrubbing assistant operating as the final stage of a detection pipeline.

CONTEXT — earlier pipeline stages have already redacted some PII by replacing it with bracketed placeholders. The placeholders you may encounter are:
[FIRSTNAME] [LASTNAME] [NAME] [EMAIL] [PHONE] [IP] [IPV6] [MAC] [CARD] [IBAN] [LOCATION] [ORG] [DATE] [TIME] [USERNAME] [ID] [COUNTRY] [BUILDING] [STREET] [CITY] [STATE] [POSTCODE] [PASS] [SOCIALNUMBER]

Do NOT return any of these placeholders as matches — they are already redacted.

BACKGROUND — to help you recognise what counts as PII, here is a broad taxonomy of PII categories that earlier detectors cover. Anything in this taxonomy that is still present as real text in the input is your target:
- Personal: first/last name, date of birth, age, gender, sexuality, race/ethnicity, religion, political view, occupation, education
- Contact: email, phone, street address, city, county, state, country, coordinates, zip code, PO box
- Financial: credit/debit card, CVV, bank routing number, account number, IBAN, SWIFT/BIC, PIN, SSN, tax ID, EIN
- Government IDs: passport, driver's licence, licence plate, national ID, voter ID
- Digital: IPv4, IPv6, MAC address, URL, username, password, device ID, IMEI, serial number, API key, secret key
- Healthcare: medical record number, health plan ID, blood type, biometric identifier, health condition, medication, insurance policy
- Temporal: date, time, datetime
- Organisation: company name, employee ID, customer ID, certificate/licence number, vehicle identifier

YOUR TASK — find any remaining unredacted PII of these output types only: {labels_str}.

Return a JSON object with an "items" array. Each item must have:
- "value": the exact substring from the text (character-for-character, copy it exactly)
- "label": one of {labels_str}

Rules:
- Only mark PII that is explicitly present as real text, not inside a [PLACEHOLDER].
- Never reconstruct or infer content that is hidden behind a placeholder.
- If unsure whether something is PII, do not include it.
- Return all items, even if there are many. It is OK if items length is 200+.
- Return {{"items": []}} only if there is no remaining unredacted PII of these types."""

def parse_response(content):
    """Extract [{value, label}] from model output.

    Handles:
    - Valid JSON:       {"items": [{"value": ..., "label": ...}]}
    - Markdown fences:  ```json ... ```
    - JS-style objects: { value: '...', label: '...' }  (unquoted keys, single quotes)
    """
    import re as _re

    raw = content.strip()

    # Strip markdown code fences
    fence = _re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
    if fence:
        raw = fence.group(1).strip()

    # Try strict JSON first
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get('items'), list):
            return [i for i in parsed['items'] if isinstance(i.get('value'), str) and isinstance(i.get('label'), str)]
        if isinstance(parsed, list):
            return [i for i in parsed if isinstance(i.get('value'), str) and isinstance(i.get('label'), str)]
    except json.JSONDecodeError:
        pass

    # Fallback: regex for both JSON-style and JS-style entries
    items = []
    # Matches:  "value": "foo", "label": "BAR"
    for m in _re.finditer(r'"value"\s*:\s*"([^"]*)"\s*,\s*"label"\s*:\s*"([^"]*)"', raw):
        items.append({'value': m.group(1), 'label': m.group(2)})
    if items:
        return items
    # Matches:  value: 'foo', label: 'BAR'  (JS-style single quotes, unquoted keys)
    for m in _re.finditer(r"value\s*:\s*'([^']*)'\s*,\s*label\s*:\s*'([^']*)'", raw):
        items.append({'value': m.group(1), 'label': m.group(2)})
    return items


def detect_text(text, span, model_name):
    TP, FP, TN, FN = 0, 0, 0, 0

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": FEW_SHOT_1_USER},
        {"role": "assistant", "content": FEW_SHOT_1_ASSISTANT},
        {"role": "user", "content": FEW_SHOT_2_USER},
        {"role": "assistant", "content": FEW_SHOT_2_ASSISTANT},
        {"role": "user", "content": text},
    ]

    response = ollama.chat(model=model_name, messages=messages)

    content = response.message.content

    items = parse_response(content)
    pred_items = [item['value'] for item in items]

    span_list = ast.literal_eval(span)
    true_items = [s['text'] for s in span_list if isinstance(s.get('text'), str)]

    for pred_item in pred_items:
        if pred_item in true_items:
            TP += 1
        else:
            FP += 1

    for true_item in true_items:
        if true_item not in pred_items:
            FN += 1
        else:
            TN += 1

    return TP, FP, TN, FN


def print_metrics(TP, FP, TN, FN, duration=None, n=None):
    precision = TP / (TP + FP) if (TP + FP) > 0 else 0.0
    recall = TP / (TP + FN) if (TP + FN) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    header = f"--- After {n} samples ---" if n is not None else "--- Final Results ---"
    print(header)
    if duration is not None:
        print(f"  Elapsed:   {duration:.1f}s")
    print(f"  TP={TP}  FP={FP}  TN={TN}  FN={FN}")
    print(f"  Precision: {precision:.3f}  Recall: {recall:.3f}  F1: {f1:.3f}")


def detect_texts(texts, spans, model_name, live=False):
    TP, FP, TN, FN = 0, 0, 0, 0
    start_time = time.perf_counter()
    for i in range(len(texts)):
        print(f"Processing text {i+1} of {len(texts)}")
        result = detect_text(texts[i], spans[i], model_name)
        TP += result[0]
        FP += result[1]
        TN += result[2]
        FN += result[3]
        if live:
            print_metrics(TP, FP, TN, FN, duration=time.perf_counter() - start_time, n=i + 1)
    return TP, FP, TN, FN

if __name__ == "__main__":
    args = sys.argv[1:]

    if len(args) < 1:
        print("Usage: python LLM_evaluation.py <model_name> [sample]")
        sys.exit(1)

    is_sample = len(args) > 1 and args[1] == "sample"

    dataset = load_dataset("nvidia/Nemotron-PII")

    all_texts = list(dataset['test']['text']) + list(dataset['train']['text'])
    all_spans = list(dataset['test']['spans']) + list(dataset['train']['spans'])
    if is_sample:
        sample_size = 50
        indices = random.sample(range(len(all_texts)), sample_size)
        sample_texts = [all_texts[i] for i in indices]
        sample_spans = [all_spans[i] for i in indices]
    else:
        sample_texts = all_texts
        sample_spans = all_spans

    start_time = time.perf_counter()
    TP, FP, TN, FN = detect_texts(sample_texts, sample_spans, args[0], live=is_sample)
    duration = time.perf_counter() - start_time

    print(f"\nSubprocess took {duration:.3f} seconds processing {len(sample_texts)} texts")
    print_metrics(TP, FP, TN, FN)
