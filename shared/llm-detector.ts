import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';
import { selectNonOverlapping } from './helper';

const OLLAMA_BASE = process.env.PII_OLLAMA_BASE ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.PII_OLLAMA_MODEL ?? 'llama3.2:3b';
const OLLAMA_TIMEOUT_MS = Number(process.env.PII_OLLAMA_TIMEOUT_MS) || 60000;

const DEBUG = /^1|true|yes$/i.test(process.env.PII_LLM_DEBUG ?? '') || /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[PII LLM]', ...args);
  }
}

type OllamaPiiItem = { value: string; start: number; end: number; label: string };

const VALID_PII_TYPES = new Set<string>([
  PiiType.EMAIL,
  PiiType.PHONE,
  PiiType.IP,
  PiiType.CARD,
  PiiType.NAME,
  PiiType.FIRSTNAME,
  PiiType.LASTNAME,
  PiiType.LOCATION,
  PiiType.ORG,
  PiiType.DATE,
  PiiType.USERNAME,
  PiiType.TIME,
  PiiType.IDCARD,
  PiiType.COUNTRY,
  PiiType.BUILDING,
  PiiType.STREET,
  PiiType.CITY,
  PiiType.STATE,
  PiiType.POSTCODE,
  PiiType.PASS,
  PiiType.SOCIALNUMBER,
]);

const PII_TYPE_ENUM = [
  'EMAIL', 'PHONE', 'IP', 'CARD', 'NAME', 'FIRSTNAME', 'LASTNAME',
  'LOCATION', 'ORG', 'DATE', 'USERNAME', 'TIME', 'IDCARD', 'COUNTRY',
  'BUILDING', 'STREET', 'CITY', 'STATE', 'POSTCODE', 'PASS', 'SOCIALNUMBER',
];

/** JSON schema for chat format: root object with items array. */
function getResponseSchema(): Record<string, unknown> {
  const itemSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      value: { type: 'string' },
      start: { type: 'integer' },
      end: { type: 'integer' },
      label: { type: 'string', enum: PII_TYPE_ENUM },
    },
    required: ['value', 'start', 'end', 'label'],
  };
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: itemSchema,
        description: 'All PII spans found; use [] only when there are none',
      },
    },
    required: ['items'],
  };
}

/**
 * Map a label string to a PiiType. Strips trailing digits so that labels
 * like LASTNAME1 or LASTNAME2 resolve to PiiType.LASTNAME.
 */
function mapType(raw: string): PiiType | null {
  const upper = raw?.toUpperCase?.()?.trim?.();
  if (!upper) return null;
  if (VALID_PII_TYPES.has(upper)) return upper as PiiType;
  const base = upper.replace(/\d+$/, '');
  if (base && VALID_PII_TYPES.has(base)) return base as PiiType;
  return null;
}

/**
 * Find all non-overlapping occurrences of `needle` in `text`, returning [start, end] pairs.
 */
function findOccurrences(
  text: string,
  needle: string
): Array<{ start: number; end: number; value: string }> {
  if (!needle || needle.length === 0) return [];
  const spans: Array<{ start: number; end: number; value: string }> = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf(needle, pos);
    if (idx === -1) break;
    const end = idx + needle.length;
    spans.push({ start: idx, end, value: text.slice(idx, end) });
    pos = end;
  }
  return spans;
}

/**
 * Find spans in text that normalize (digits only) to the same as value.
 * Used when the LLM returns e.g. "6475143441" but the text has "647-514-3441".
 */
function findOccurrencesNormalized(
  text: string,
  value: string
): Array<{ start: number; end: number; value: string }> {
  const normalized = value.replace(/\D/g, '');
  if (!normalized) return [];
  const spans: Array<{ start: number; end: number; value: string }> = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    let k = 0;
    while (j < text.length && k < normalized.length) {
      const c = text[j];
      if (/\d/.test(c)) {
        if (c !== normalized[k]) break;
        k++;
      }
      j++;
    }
    if (k === normalized.length) {
      spans.push({ start: i, end: j, value: text.slice(i, j) });
      i = j;
    } else {
      i++;
    }
  }
  return spans;
}

/**
 * Fallback: extract { value, start, end, label } objects from text via regex
 * when JSON.parse fails or returns no items.
 */
function parseJsonArrayFallback(response: string): OllamaPiiItem[] {
  const items: OllamaPiiItem[] = [];
  const re = /"value"\s*:\s*"([^"]*)"\s*,\s*"start"\s*:\s*(\d+)\s*,\s*"end"\s*:\s*(\d+)\s*,\s*"label"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const value = m[1] ?? '';
    const start = parseInt(m[2] ?? '', 10);
    const end = parseInt(m[3] ?? '', 10);
    const label = m[4] ?? '';
    if (value && label && !isNaN(start) && !isNaN(end) && end > start) {
      items.push({ value, start, end, label });
    }
  }
  return items;
}

/**
 * Normalize a parsed object to OllamaPiiItem.
 */
function normalizeItem(obj: unknown): OllamaPiiItem | null {
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const value = typeof o.value === 'string' ? o.value : '';
  const start = typeof o.start === 'number' ? Math.round(o.start) : -1;
  const end = typeof o.end === 'number' ? Math.round(o.end) : -1;
  const label = typeof o.label === 'string' ? o.label : '';
  if (!value || !label || start < 0 || end <= start) return null;
  return { value, start, end, label };
}

/**
 * Extract items from the model response. Expects { items: [...] } from schema,
 * or raw array. May be wrapped in markdown code block. Falls back to regex
 * if parse yields no items.
 */
function parseJsonArray(response: string): OllamaPiiItem[] {
  if (typeof response !== 'string') return [];
  let raw = response.replace(/^\uFEFF/, '').trim();
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) raw = codeBlock[1].trim();
  let arr: OllamaPiiItem[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
      const items = (parsed as { items: unknown[] }).items;
      for (const x of items) {
        const item = normalizeItem(x);
        if (item) arr.push(item);
      }
    } else if (Array.isArray(parsed)) {
      for (const x of parsed) {
        const item = normalizeItem(x);
        if (item) arr.push(item);
      }
    } else {
      const single = normalizeItem(parsed);
      if (single) arr = [single];
    }
  } catch {
    // parse failed, try fallback below
  }
  if (arr.length === 0) arr = parseJsonArrayFallback(response);
  return arr;
}

/* ------------------------------------------------------------------ */
/*  Few-shot examples                                                  */
/* ------------------------------------------------------------------ */

const FEW_SHOT_1_USER = `Subject: Group Messaging for Admissions Process
Good morning, everyone,
I hope this message finds you well. As we continue our admissions processes, I would like to update you on the latest developments and key information. Please find below the timeline for our upcoming meetings:

wynqvrh053 - Meeting at 10:20am
luka.burg - Meeting at 21
qahl.wittauer - Meeting at quarter past 13
gholamhossein.ruschke - Meeting at 9:47 PM
pdmjrsyoz1460`;

const FEW_SHOT_1_ASSISTANT = JSON.stringify({
  items: [
    { value: 'wynqvrh053', start: 287, end: 297, label: 'USERNAME' },
    { value: '10:20am', start: 311, end: 318, label: 'TIME' },
    { value: 'luka.burg', start: 319, end: 328, label: 'USERNAME' },
    { value: '21', start: 342, end: 344, label: 'TIME' },
    { value: 'qahl.wittauer', start: 345, end: 358, label: 'USERNAME' },
    { value: 'quarter past 13', start: 372, end: 387, label: 'TIME' },
    { value: 'gholamhossein.ruschke', start: 388, end: 409, label: 'USERNAME' },
    { value: '9:47 PM', start: 423, end: 430, label: 'TIME' },
    { value: 'pdmjrsyoz1460', start: 431, end: 444, label: 'USERNAME' },
  ],
});

const FEW_SHOT_2_USER = 'Card: KB90324ER\n Country: GB\n Building: 163\n Street: Conygre Grove\n City: Bristol\n State: ENG\n Postcode: BS34 7HU, BS34 7HZ\n Password: q4R\\n\n2. Applicant: Baasgaran Palmoso\n Email: blerenbaasgara@gmail.com\n Social Number: 107-393-9036\n ID Card: SC78428CU\n Country: United Kingdom\n Building: 646\n Street: School Lane\n City: Altrincham\n State: ENG\n Postcode: WA14 5R';

const FEW_SHOT_2_ASSISTANT = JSON.stringify({
  items: [
    { value: 'KB90324ER', start: 6, end: 15, label: 'IDCARD' },
    { value: 'GB', start: 29, end: 31, label: 'COUNTRY' },
    { value: '163', start: 46, end: 49, label: 'BUILDING' },
    { value: 'Conygre Grove', start: 62, end: 75, label: 'STREET' },
    { value: 'Bristol', start: 86, end: 93, label: 'CITY' },
    { value: 'ENG', start: 105, end: 108, label: 'STATE' },
    { value: 'BS34 7HU, BS34 7HZ', start: 123, end: 141, label: 'POSTCODE' },
    { value: 'q4R\\\\', start: 156, end: 161, label: 'PASS' },
    { value: 'Baasgaran', start: 179, end: 188, label: 'LASTNAME' },
    { value: 'Palmoso', start: 189, end: 196, label: 'LASTNAME' },
    { value: 'blerenbaasgara@gmail.com', start: 208, end: 232, label: 'EMAIL' },
    { value: '107-393-9036', start: 252, end: 264, label: 'SOCIALNUMBER' },
    { value: 'SC78428CU', start: 278, end: 287, label: 'IDCARD' },
    { value: 'United Kingdom', start: 301, end: 315, label: 'COUNTRY' },
    { value: '646', start: 330, end: 333, label: 'BUILDING' },
    { value: 'School Lane', start: 346, end: 357, label: 'STREET' },
    { value: 'Altrincham', start: 368, end: 378, label: 'CITY' },
    { value: 'ENG', start: 390, end: 393, label: 'STATE' },
  ],
});

/* ------------------------------------------------------------------ */
/*  Detector class                                                     */
/* ------------------------------------------------------------------ */

export class LlamaDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) {
      debug('collectMatches: empty text, skipping');
      return [];
    }
    if (process.env.PII_LLM_DISABLE === '1') {
      debug('collectMatches: PII_LLM_DISABLE=1, skipping');
      return [];
    }

    const systemPrompt = `You are a PII scrubbing assistant that expertly identifies and locates private data in text.

For each piece of PII found, return a JSON object with an "items" array. Each item must have:
- "value": the exact substring from the text (character-for-character)
- "start": the starting character offset (0-based)
- "end": the ending character offset (exclusive)
- "label": the PII category label

Supported labels: ${PII_TYPE_ENUM.join(', ')}

Rules:
- Only mark PII that is explicitly present in the text. Use the exact substring.
- "start" and "end" must be accurate character offsets into the original text.
- Never infer missing parts (e.g. do not add a city if the text only says "I live downtown").
- If unsure whether something is PII, do not include it.
- Return {"items": []} only if there is absolutely no PII present.`;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: FEW_SHOT_1_USER },
      { role: 'assistant', content: FEW_SHOT_1_ASSISTANT },
      { role: 'user', content: FEW_SHOT_2_USER },
      { role: 'assistant', content: FEW_SHOT_2_ASSISTANT },
      { role: 'user', content: text },
    ];

    const url = `${OLLAMA_BASE}/api/chat`;
    debug('request', { url, model: OLLAMA_MODEL, textLength: text.length, timeoutMs: OLLAMA_TIMEOUT_MS });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          format: getResponseSchema(),
          messages,
          options: {
            temperature: 0,
            top_p: 0,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      debug('response', { ok: res.ok, status: res.status, statusText: res.statusText });

      if (!res.ok) {
        const errBody = await res.text();
        debug('response not ok, body:', errBody.slice(0, 500));
        return [];
      }

      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data?.message?.content;
      const responseText = typeof content === 'string' ? content : content != null ? String(content) : '';
      debug('response body length:', responseText.length, 'preview (first 200):', responseText.slice(0, 200));

      let items: OllamaPiiItem[];
      try {
        items = parseJsonArray(responseText);
      } catch {
        return [];
      }

      const rawMatches: RawMatch[] = [];
      const typesWithNormalizedMatching = new Set<PiiType>([PiiType.PHONE, PiiType.CARD, PiiType.SOCIALNUMBER]);

      for (const item of items) {
        const type = mapType(item.label);
        if (!type) continue;
        const value = String(item.value).trim();
        if (!value) continue;
        const label = item.label.toUpperCase().trim();

        // First, validate LLM-provided positions
        if (item.start >= 0 && item.end > item.start && item.end <= text.length) {
          const textSlice = text.slice(item.start, item.end);
          if (textSlice === value) {
            rawMatches.push({
              type,
              start: item.start,
              end: item.end,
              value,
              source: this.getName(),
              label,
            });
            continue;
          }
          debug('position mismatch for', label, ':', JSON.stringify(value), 'vs', JSON.stringify(textSlice));
        }

        // Fallback: find occurrences by text search
        let occurrences = findOccurrences(text, value);
        if (
          occurrences.length === 0 &&
          typesWithNormalizedMatching.has(type) &&
          /\d/.test(value)
        ) {
          occurrences = findOccurrencesNormalized(text, value);
        }
        for (const { start, end, value: spanValue } of occurrences) {
          rawMatches.push({
            type,
            start,
            end,
            value: spanValue,
            source: this.getName(),
            label,
          });
        }
      }

      return selectNonOverlapping(rawMatches);
    } catch (err) {
      clearTimeout(timeoutId);
      debug('error:', err instanceof Error ? err.message : err);
      if (DEBUG && err instanceof Error && err.stack) {
        console.log('[PII LLM] stack:', err.stack);
      }
      return [];
    }
  }

  getName(): string {
    return 'LLM';
  }
}
