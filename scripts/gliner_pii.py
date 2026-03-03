import json
import os
import sys
from typing import Any, Dict, List

from gliner import GLiNER


MODEL_ID = os.environ.get("PII_GLINER_MODEL", "ineersa/gliner-PII-onnx")
THRESHOLD = float(os.environ.get("PII_GLINER_THRESHOLD", "0.5"))

# Full PII label set from the GLiNER-PII ONNX model card:
# https://huggingface.co/ineersa/gliner-PII-onnx
LABELS: List[str] = [
    # Personal Information (13)
    "first_name",
    "last_name",
    "name",
    "date_of_birth",
    "age",
    "gender",
    "sexuality",
    "race_ethnicity",
    "religious_belief",
    "political_view",
    "occupation",
    "employment_status",
    "education_level",
    # Contact Information (10)
    "email",
    "phone_number",
    "street_address",
    "city",
    "county",
    "state",
    "country",
    "coordinate",
    "zip_code",
    "po_box",
    # Financial Information (10)
    "credit_debit_card",
    "cvv",
    "bank_routing_number",
    "account_number",
    "iban",
    "swift_bic",
    "pin",
    "ssn",
    "tax_id",
    "ein",
    # Government Identifiers (5)
    "passport_number",
    "driver_license",
    "license_plate",
    "national_id",
    "voter_id",
    # Digital/Technical Identifiers (11)
    "ipv4",
    "ipv6",
    "mac_address",
    "url",
    "user_name",
    "password",
    "device_identifier",
    "imei",
    "serial_number",
    "api_key",
    "secret_key",
    # Healthcare/PHI (7)
    "medical_record_number",
    "health_plan_beneficiary_number",
    "blood_type",
    "biometric_identifier",
    "health_condition",
    "medication",
    "insurance_policy_number",
    # Temporal Information (3)
    "date",
    "time",
    "date_time",
    # Organization Information (5)
    "company_name",
    "employee_id",
    "customer_id",
    "certificate_license_number",
    "vehicle_identifier",
]


def _debug(*args: Any) -> None:
    if os.environ.get("PII_DEBUG", "").lower() in ("1", "true", "yes"):
        print("[GLiNER PII]", *args, file=sys.stderr)


def _load_model() -> GLiNER:
    _debug("Loading model", MODEL_ID)
    return GLiNER.from_pretrained(
        MODEL_ID,
        load_onnx_model=True,
        load_tokenizer=True,
    )


def _ensure_offsets(
    text: str, entities: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Ensure each entity has integer start/end offsets.

    GLiNER typically returns start/end, but if they are missing for any reason
    we fall back to a simple substring search on the original text.
    """
    result: List[Dict[str, Any]] = []
    cursor = 0

    for ent in entities:
        label = ent.get("label")
        span_text = ent.get("text")
        start = ent.get("start")
        end = ent.get("end")

        if not label or not span_text:
            continue

        if isinstance(start, int) and isinstance(end, int):
            result.append(
                {
                    "start": int(start),
                    "end": int(end),
                    "label": str(label),
                    "text": str(span_text),
                }
            )
            cursor = max(cursor, int(end))
            continue

        # Fallback: locate the span text inside the original string.
        idx = text.find(str(span_text), cursor)
        if idx == -1:
            idx = text.find(str(span_text))
            if idx == -1:
                _debug("Could not locate span in text", span_text)
                continue

        start_i = idx
        end_i = idx + len(str(span_text))
        result.append(
            {
                "start": start_i,
                "end": end_i,
                "label": str(label),
                "text": str(span_text),
            }
        )
        cursor = end_i

    return result


def main() -> None:
    text = sys.stdin.read()
    if not text.strip():
        sys.stdout.write("[]")
        return

    model = _load_model()
    _debug("Running prediction", {"len": len(text)})
    raw_entities = model.predict_entities(text, LABELS, threshold=THRESHOLD)

    # GLiNER can return either dicts or lightweight objects; normalize to dicts.
    entities: List[Dict[str, Any]] = []
    for ent in raw_entities:
        if isinstance(ent, dict):
            entities.append(ent)
        else:
            entities.append(
                {
                    "start": getattr(ent, "start", None),
                    "end": getattr(ent, "end", None),
                    "label": getattr(ent, "label", None),
                    "text": getattr(ent, "text", None),
                }
            )

    with_offsets = _ensure_offsets(text, entities)
    sys.stdout.write(json.dumps(with_offsets, ensure_ascii=True))


if __name__ == "__main__":
    main()

