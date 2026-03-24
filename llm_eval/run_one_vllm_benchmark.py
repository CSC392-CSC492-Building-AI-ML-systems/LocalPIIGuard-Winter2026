import os
os.environ.setdefault("VLLM_ENABLE_V1_MULTIPROCESSING", "0")

import ast
import json
import time
import re
import random
import argparse

from datasets import load_dataset
from transformers import AutoTokenizer
from vllm import LLM, SamplingParams

FEW_SHOT_1_USER = """Subject: Group Messaging for Admissions Process
Good morning, everyone,
I hope this message finds you well. As we continue our admissions processes, I would like to update you on the latest developments and key information. Please find below the timeline for our upcoming meetings:

wynqvrh053 - Meeting at 10:20am
luka.burg - Meeting at 21
qahl.wittauer - Meeting at quarter past 13
gholamhossein.ruschke - Meeting at 9:47 PM
pdmjrsyoz1460"""

FEW_SHOT_1_ASSISTANT = """{
  "items": [
    { "value": "wynqvrh053", "label": "USERNAME" },
    { "value": "10:20am", "label": "TIME" },
    { "value": "luka.burg", "label": "USERNAME" },
    { "value": "21", "label": "TIME" },
    { "value": "qahl.wittauer", "label": "USERNAME" },
    { "value": "quarter past 13", "label": "TIME" },
    { "value": "gholamhossein.ruschke", "label": "USERNAME" },
    { "value": "9:47 PM", "label": "TIME" },
    { "value": "pdmjrsyoz1460", "label": "USERNAME" }
  ]
}"""

FEW_SHOT_2_USER = 'Card: KB90324ER\\n Country: GB\\n Building: 163\\n Street: Conygre Grove\\n City: Bristol\\n State: ENG\\n Postcode: BS34 7HU, BS34 7HZ\\n Password: q4R\\\\n\\n2. Applicant: Baasgaran Palmoso\\n Email: blerenbaasgara@gmail.com\\n Social Number: 107-393-9036\\n ID Card: SC78428CU\\n Country: United Kingdom\\n Building: 646\\n Street: School Lane\\n City: Altrincham\\n State: ENG\\n Postcode: WA14 5R'

FEW_SHOT_2_ASSISTANT = """{
  "items": [
    { "value": "KB90324ER", "label": "ID" },
    { "value": "GB", "label": "COUNTRY" },
    { "value": "163", "label": "BUILDING" },
    { "value": "Conygre Grove", "label": "STREET" },
    { "value": "Bristol", "label": "CITY" },
    { "value": "ENG", "label": "STATE" },
    { "value": "BS34 7HU, BS34 7HZ", "label": "POSTCODE" },
    { "value": "q4R\\\\", "label": "PASS" },
    { "value": "Baasgaran", "label": "LASTNAME" },
    { "value": "Palmoso", "label": "LASTNAME" },
    { "value": "blerenbaasgara@gmail.com", "label": "EMAIL" },
    { "value": "107-393-9036", "label": "SOCIALNUMBER" },
    { "value": "SC78428CU", "label": "ID" },
    { "value": "United Kingdom", "label": "COUNTRY" },
    { "value": "646", "label": "BUILDING" },
    { "value": "School Lane", "label": "STREET" },
    { "value": "Altrincham", "label": "CITY" },
    { "value": "ENG", "label": "STATE" }
  ]
}"""

labels_list = [
    "EMAIL", "PHONE", "IP", "IPV6", "MAC", "CARD", "IBAN",
    "NAME", "FIRSTNAME", "LASTNAME", "LOCATION", "ORG", "DATE",
    "USERNAME", "TIME", "ID", "COUNTRY", "BUILDING", "STREET",
    "CITY", "STATE", "POSTCODE", "PASS", "SOCIALNUMBER",
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

MODEL_MAP = {
    "qwen2.5-0.5b": {"hf_id": "Qwen/Qwen2.5-0.5B-Instruct", "trust_remote_code": False},
    "qwen2.5-1.5b": {"hf_id": "Qwen/Qwen2.5-1.5B-Instruct", "trust_remote_code": False},
    "qwen2.5-3b": {"hf_id": "Qwen/Qwen2.5-3B-Instruct", "trust_remote_code": False},
    "smollm2-1.7b": {"hf_id": "HuggingFaceTB/SmolLM2-1.7B-Instruct", "trust_remote_code": False},
    "granite-3.3-2b": {"hf_id": "ibm-granite/granite-3.3-2b-instruct", "trust_remote_code": False},
    "nemotron-mini-4b": {"hf_id": "nvidia/Nemotron-Mini-4B-Instruct", "trust_remote_code": False},
    "phi-4-mini": {"hf_id": "microsoft/Phi-4-mini-instruct", "trust_remote_code": True},
}

def parse_response(content: str):
    raw = content.strip()

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        raw = fence.group(1).strip()

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            return [
                i for i in parsed["items"]
                if isinstance(i, dict)
                and isinstance(i.get("value"), str)
                and isinstance(i.get("label"), str)
            ]
    except Exception:
        pass

    items = []
    for m in re.finditer(r'"value"\s*:\s*"([^"]*)"\s*,\s*"label"\s*:\s*"([^"]*)"', raw):
        items.append({"value": m.group(1), "label": m.group(2)})
    if items:
        return items

    for m in re.finditer(r"value\s*:\s*'([^']*)'\s*,\s*label\s*:\s*'([^']*)'", raw):
        items.append({"value": m.group(1), "label": m.group(2)})

    return items

def compute_prf(tp: int, fp: int, fn: int):
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-alias", required=True)
    ap.add_argument("--sample-size", type=int, default=100)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-new-tokens", type=int, default=256)
    ap.add_argument("--gpu-memory-utilization", type=float, default=0.5)
    ap.add_argument("--max-model-len", type=int, default=4096)
    args = ap.parse_args()

    spec = MODEL_MAP[args.model_alias]

    tokenizer = AutoTokenizer.from_pretrained(
        spec["hf_id"],
        trust_remote_code=spec["trust_remote_code"],
    )

    llm = LLM(
        model=spec["hf_id"],
        trust_remote_code=spec["trust_remote_code"],
        dtype="float16",
        gpu_memory_utilization=args.gpu_memory_utilization,
        max_model_len=args.max_model_len,
        enforce_eager=True,
    )

    ds = load_dataset("nvidia/Nemotron-PII")
    all_texts = list(ds["train"]["text"])
    all_spans = list(ds["train"]["spans"])

    random.seed(args.seed)
    idxs = random.sample(range(len(all_texts)), args.sample_size)
    eval_texts = [all_texts[i] for i in idxs]
    eval_spans = [all_spans[i] for i in idxs]

    tp = fp = fn = 0
    total_prompt_tokens = 0
    total_output_tokens = 0
    total_generation_time = 0.0

    t0 = time.perf_counter()

    for text, span in zip(eval_texts, eval_spans):
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": FEW_SHOT_1_USER},
            {"role": "assistant", "content": FEW_SHOT_1_ASSISTANT},
            {"role": "user", "content": FEW_SHOT_2_USER},
            {"role": "assistant", "content": FEW_SHOT_2_ASSISTANT},
            {"role": "user", "content": text},
        ]

        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_ids = tokenizer(prompt, return_tensors="pt")["input_ids"][0].tolist()

        sp = SamplingParams(temperature=0.0, max_tokens=args.max_new_tokens)

        started = time.perf_counter()
        out = llm.generate([prompt], sp, use_tqdm=False)
        elapsed = time.perf_counter() - started

        content = out[0].outputs[0].text
        items = parse_response(content)
        pred_items = [item["value"] for item in items]

        span_list = ast.literal_eval(span)
        true_items = [s["text"] for s in span_list if isinstance(s.get("text"), str)]

        for pred_item in pred_items:
            if pred_item in true_items:
                tp += 1
            else:
                fp += 1

        for true_item in true_items:
            if true_item not in pred_items:
                fn += 1

        total_prompt_tokens += len(prompt_ids)
        total_output_tokens += len(out[0].outputs[0].token_ids)
        total_generation_time += elapsed

    wall = time.perf_counter() - t0
    p, r, f1 = compute_prf(tp, fp, fn)

    result = {
        "model": args.model_alias,
        "hf_id": spec["hf_id"],
        "eval_time_s": round(wall, 3),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(p, 4),
        "recall": round(r, 4),
        "f1": round(f1, 4),
        "samples_processed": args.sample_size,
        "prompt_tokens": total_prompt_tokens,
        "output_tokens": total_output_tokens,
        "generation_time_s": round(total_generation_time, 3),
        "avg_latency_per_sample_s": round(total_generation_time / max(1, args.sample_size), 3),
        "avg_output_tokens_per_sample": round(total_output_tokens / max(1, args.sample_size), 3),
        "output_tokens_per_s": round(total_output_tokens / total_generation_time, 3) if total_generation_time > 0 else 0.0,
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()