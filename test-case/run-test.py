import random
import subprocess
import json
import time
from datasets import load_dataset
import re
from typing import List, Tuple, Any
from tqdm import tqdm
import math

valid_label = {
    "first_name": "NAME",
    "last_name": "NAME",
    "NAME": "NAME",
    "LOCATION": "LOCATION",
    "city": "LOCATION",
    "county": "LOCATION",
    "state": "LOCATION",
    "street_address": "LOCATION",
    "ORG": "ORG",
    "company_name": "ORG",
}

LABELS = ["NAME", "LOCATION", "ORG"]

def parse_text(text, pii, label_name="type"):
    words = []
    offset = 0
    for word in re.findall(r"\S+", text):
        start = text.find(word, offset)
        end = start + len(word)
        words.append({"word": word, "start": start, "end": end})
        offset = end

    if not isinstance(pii, list):
        return [""] * len(words)

    word_labels = []
    for w in words:
        label = ""
        for e in pii:
            if not isinstance(e, dict):
                continue
            if label_name not in e:
                continue
            if e[label_name] not in valid_label:
                continue
            if "start" not in e or "end" not in e:
                continue
            if w["start"] < e["end"] and w["end"] > e["start"]:
                label = valid_label[e[label_name]]
                break
        word_labels.append(label)

    return word_labels

def detect_texts_single_batch(texts: List[str], detector_type: int = 1) -> Tuple[List[Any], float]:
    input_json = json.dumps(texts)

    start_time = time.perf_counter()
    proc = subprocess.run(
        ["node", "test-case.cjs", input_json, str(detector_type)],
        capture_output=True,
        text=True,
    )
    end_time = time.perf_counter()
    duration = end_time - start_time

    if proc.returncode != 0:
        raise RuntimeError(f"Node.js error:\n{proc.stderr}")

    results = json.loads(proc.stdout)
    return results, duration

def detect_texts_batched(
    texts: List[str],
    detector_type: int = 1,
    batch_size: int = 25,
    auto_shrink_on_oserror: bool = True,
) -> Tuple[List[Any], float]:
    all_results: List[Any] = []
    total_duration = 0.0

    i = 0
    current_batch_size = batch_size

    # Progress bar for overall text coverage (not number of batches, since batch size can shrink)
    pbar = tqdm(total=len(texts), desc="Running detection (batched)", unit="text")

    try:
        while i < len(texts):
            batch = texts[i:i + current_batch_size]
            try:
                batch_results, dur = detect_texts_single_batch(batch, detector_type=detector_type)
                if not isinstance(batch_results, list) or len(batch_results) != len(batch):
                    raise RuntimeError(
                        f"Detector returned unexpected batch shape: "
                        f"expected list len {len(batch)}, got {type(batch_results)} len {len(batch_results) if isinstance(batch_results, list) else 'n/a'}"
                    )

                all_results.extend(batch_results)
                total_duration += dur
                i += len(batch)

                pbar.update(len(batch))
                pbar.set_postfix({"batch_size": current_batch_size, "secs": f"{dur:.2f}"})

            except OSError as e:
                if (getattr(e, "errno", None) == 7) and auto_shrink_on_oserror and current_batch_size > 1:
                    current_batch_size = max(1, current_batch_size // 2)
                    pbar.set_postfix({"batch_size": current_batch_size, "note": "shrink"})
                    continue
                raise
    finally:
        pbar.close()

    return all_results, total_duration

def make_confusion():
    return {lab: {"TP": 0, "FP": 0, "TN": 0, "FN": 0} for lab in LABELS}

def update_binary(counts, pred_is_lab: bool, true_is_lab: bool):
    if pred_is_lab and true_is_lab:
        counts["TP"] += 1
    elif pred_is_lab and not true_is_lab:
        counts["FP"] += 1
    elif (not pred_is_lab) and (not true_is_lab):
        counts["TN"] += 1
    elif (not pred_is_lab) and true_is_lab:
        counts["FN"] += 1

def accuracy_from_counts(TP, FP, TN, FN):
    total = TP + FP + TN + FN
    return (TP + TN) / total if total else 0.0

def micro_accuracy(conf_by_label):
    TP = sum(conf_by_label[lab]["TP"] for lab in LABELS)
    FP = sum(conf_by_label[lab]["FP"] for lab in LABELS)
    TN = sum(conf_by_label[lab]["TN"] for lab in LABELS)
    FN = sum(conf_by_label[lab]["FN"] for lab in LABELS)
    return accuracy_from_counts(TP, FP, TN, FN), {"TP": TP, "FP": FP, "TN": TN, "FN": FN}

def combined_any_pii_counts(pred_seq, true_seq):
    TP = FP = TN = FN = 0
    for pred, true in zip(pred_seq, true_seq):
        pred_pos = pred in LABELS
        true_pos = true in LABELS
        if pred_pos and true_pos:
            TP += 1
        elif pred_pos and not true_pos:
            FP += 1
        elif (not pred_pos) and (not true_pos):
            TN += 1
        elif (not pred_pos) and true_pos:
            FN += 1
    return {"TP": TP, "FP": FP, "TN": TN, "FN": FN}

if __name__ == "__main__":
    dataset = load_dataset("nvidia/Nemotron-PII")
    test_set = (
        dataset["test"]
        .filter(lambda x: x["locale"] == "us")
        .select_columns(["text", "spans", "locale"])
    )

    texts = test_set["text"]
    all_spans = test_set["spans"]

    sample_size = 100
    indices = random.sample(range(len(texts)), sample_size)
    sample_texts = [texts[i] for i in indices]
    sample_spans = [all_spans[i] for i in indices]

    detector_type = 3  # one detector per run

    results, total_duration = detect_texts_batched(
        sample_texts,
        detector_type=detector_type,
        batch_size=5,
        auto_shrink_on_oserror=True,
    )

    conf_by_label = make_confusion()
    combined_counts_total = {"TP": 0, "FP": 0, "TN": 0, "FN": 0}
    word_count = 0
    skipped = 0

    # Progress bar for parsing/evaluation
    for text, res, correct_res in tqdm(
        zip(sample_texts, results, sample_spans),
        total=len(sample_texts),
        desc="Parsing & evaluating",
        unit="text",
    ):
        print(text)
        if not isinstance(correct_res, list):
            try:
                correct_res = json.loads(str(correct_res).replace("'", '"'))
            except Exception as e:
                skipped += 1
                continue

        pred_seq = parse_text(text, res, label_name="type")
        true_seq = parse_text(text, correct_res, label_name="label")

        if len(pred_seq) != len(true_seq):
            raise ValueError(f"Token length mismatch: pred_len={len(pred_seq)} true_len={len(true_seq)}")

        word_count += len(true_seq)

        for pred, true in zip(pred_seq, true_seq):
            for lab in LABELS:
                update_binary(
                    conf_by_label[lab],
                    pred_is_lab=(pred == lab),
                    true_is_lab=(true == lab),
                )

        comb = combined_any_pii_counts(pred_seq, true_seq)
        for k in combined_counts_total:
            combined_counts_total[k] += comb[k]

    print(
        f"\nTotal subprocess time {total_duration:.3f} seconds "
        f"processing {word_count} word/tokens "
        f"(evaluated {sample_size - skipped} samples, skipped {skipped})\n"
    )

    print("Per-label (one-vs-rest) results:")
    acc_list = []
    for lab in LABELS:
        c = conf_by_label[lab]
        acc = accuracy_from_counts(c["TP"], c["FP"], c["TN"], c["FN"])
        acc_list.append(acc)
        print(f"  {lab}: acc={acc:.6f} | TP={c['TP']} FP={c['FP']} TN={c['TN']} FN={c['FN']}")

    micro_acc, micro_counts = micro_accuracy(conf_by_label)
    print("\nMicro (summed over one-vs-rest labels):")
    print(
        f"  acc={micro_acc:.6f} | TP={micro_counts['TP']} FP={micro_counts['FP']} "
        f"TN={micro_counts['TN']} FN={micro_counts['FN']}"
    )

    combined_acc = accuracy_from_counts(
        combined_counts_total["TP"],
        combined_counts_total["FP"],
        combined_counts_total["TN"],
        combined_counts_total["FN"],
    )
    print("\nCombined ANY-PII (positive if any of NAME/LOCATION/ORG predicted):")
    print(
        f"  acc={combined_acc:.6f} | TP={combined_counts_total['TP']} FP={combined_counts_total['FP']} "
        f"TN={combined_counts_total['TN']} FN={combined_counts_total['FN']}"
    )

    print("\nAccuracy list (per-label in LABELS order):")
    print(acc_list)