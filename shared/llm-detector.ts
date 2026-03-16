import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';
import { selectNonOverlapping } from './helper';

const OLLAMA_BASE = process.env.PII_OLLAMA_BASE ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.PII_OLLAMA_MODEL ?? 'phi4-mini';
const OLLAMA_TIMEOUT_MS = Number(process.env.PII_OLLAMA_TIMEOUT_MS) || 300000;

const DEBUG = /^1|true|yes$/i.test(process.env.PII_LLM_DEBUG ?? '') || /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[PII LLM]', ...args);
  }
}

type OllamaPiiItem = { value: string; label: string };

/** A single token entry from Ollama's logprobs array. */
type LogprobToken = { token: string; logprob: number };

/**
 * Compute a confidence score for a specific PII value by finding the tokens
 * that generated it in the JSON output and averaging their log-probabilities.
 *
 * Strategy:
 *  1. Reconstruct the full generated text by concatenating all tokens.
 *  2. Find the value string within the context of a JSON "value":"..." pair.
 *  3. Build a char-to-token-index map and collect the token indices
 *     that cover the value string characters.
 *  4. Return exp(mean logprob) — the geometric mean of per-token probabilities.
 *
 * Returns undefined if logprobs are unavailable or the value cannot be located.
 */
function computeConfidence(tokens: LogprobToken[], valueStr: string): number | undefined {
  if (!tokens || tokens.length === 0 || !valueStr) return undefined;

  // Reconstruct full generated text from token strings
  const fullText = tokens.map((t) => t.token).join('');

  // Build char-to-token-index map
  const charToTokenIdx: number[] = new Array(fullText.length);
  let charPos = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens[i].token.length; j++) {
      charToTokenIdx[charPos++] = i;
    }
  }

  // Try to locate the value inside a JSON "value":"<valueStr>" pattern first,
  // then fall back to the first quoted occurrence.
  const jsonPattern = `"value":"${valueStr}"`;
  const jsonIdx = fullText.indexOf(jsonPattern);
  let valueStart: number;
  if (jsonIdx !== -1) {
    valueStart = jsonIdx + '"value":"'.length;
  } else {
    const quotedIdx = fullText.indexOf(`"${valueStr}"`);
    if (quotedIdx === -1) return undefined;
    valueStart = quotedIdx + 1;
  }
  const valueEnd = valueStart + valueStr.length;

  // Collect unique token indices that cover the value characters
  const tokenIndices = new Set<number>();
  for (let i = valueStart; i < valueEnd && i < charToTokenIdx.length; i++) {
    tokenIndices.add(charToTokenIdx[i]);
  }
  if (tokenIndices.size === 0) return undefined;

  // Geometric mean of per-token probabilities: exp(mean of logprobs)
  const sum = [...tokenIndices].reduce((acc, idx) => acc + tokens[idx].logprob, 0);
  return Math.exp(sum / tokenIndices.size);
}

const VALID_PII_TYPES = new Set<string>([
  PiiType.EMAIL,
  PiiType.PHONE,
  PiiType.IP,
  PiiType.IPV6,
  PiiType.MAC,
  PiiType.CARD,
  PiiType.IBAN,
  PiiType.NAME,
  PiiType.FIRSTNAME,
  PiiType.LASTNAME,
  PiiType.LOCATION,
  PiiType.ORG,
  PiiType.DATE,
  PiiType.USERNAME,
  PiiType.TIME,
  PiiType.ID,
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
  'EMAIL', 'PHONE', 'IP', 'IPV6', 'MAC', 'CARD', 'IBAN',
  'NAME', 'FIRSTNAME', 'LASTNAME', 'LOCATION', 'ORG', 'DATE',
  'USERNAME', 'TIME', 'ID', 'COUNTRY', 'BUILDING', 'STREET',
  'CITY', 'STATE', 'POSTCODE', 'PASS', 'SOCIALNUMBER',
];

/** JSON schema for chat format: root object with items array. Optional enum restricts labels per pass. */
function getResponseSchema(allowedLabels: string[]): Record<string, unknown> {
  const itemSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      value: { type: 'string' },
      label: { type: 'string', enum: allowedLabels.length > 0 ? allowedLabels : PII_TYPE_ENUM },
    },
    required: ['value', 'label'],
  };
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: itemSchema,
        description: 'All PII spans found; use [] only when there are none. Return all items, even if there are many (200+ is OK).',
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
 * Fallback: extract { value, label } objects from text via regex
 * when JSON.parse fails or returns no items.
 */
function parseJsonArrayFallback(response: string): OllamaPiiItem[] {
  const items: OllamaPiiItem[] = [];
  const re = /"value"\s*:\s*"([^"]*)"\s*,\s*"label"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const value = m[1] ?? '';
    const label = m[2] ?? '';
    if (value && label) {
      items.push({ value, label });
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
  const label = typeof o.label === 'string' ? o.label : '';
  if (!value || !label) return null;
  return { value, label };
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
});

const FEW_SHOT_2_USER = 'Card: KB90324ER\n Country: GB\n Building: 163\n Street: Conygre Grove\n City: Bristol\n State: ENG\n Postcode: BS34 7HU, BS34 7HZ\n Password: q4R\\n\n2. Applicant: Baasgaran Palmoso\n Email: blerenbaasgara@gmail.com\n Social Number: 107-393-9036\n ID Card: SC78428CU\n Country: United Kingdom\n Building: 646\n Street: School Lane\n City: Altrincham\n State: ENG\n Postcode: WA14 5R';

const FEW_SHOT_2_ASSISTANT = JSON.stringify({
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
});

/* ------------------------------------------------------------------ */
/*  Single-chunk, single-pass detection (used by collectMatches)        */
/* ------------------------------------------------------------------ */

const TYPES_WITH_NORMALIZED_MATCHING = new Set<PiiType>([PiiType.PHONE, PiiType.CARD, PiiType.SOCIALNUMBER]);

type ChunkPassResult = { matches: RawMatch[]; evalCount: number };

async function detectChunk(
  chunk: { text: string; offset: number },
  allowedLabels: string[],
  sourceName: string
): Promise<ChunkPassResult> {
  const labelsList = allowedLabels.join(', ');
  const systemPrompt = `You are a PII scrubbing assistant operating as the final stage of a detection pipeline.

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

YOUR TASK — find any remaining unredacted PII of these output types only: ${labelsList}.

Return a JSON object with an "items" array. Each item must have:
- "value": the exact substring from the text (character-for-character, copy it exactly)
- "label": one of ${labelsList}

Rules:
- Only mark PII that is explicitly present as real text, not inside a [PLACEHOLDER].
- Never reconstruct or infer content that is hidden behind a placeholder.
- If unsure whether something is PII, do not include it.
- Return all items, even if there are many. It is OK if items length is 200+.
- Return {"items": []} only if there is no remaining unredacted PII of these types.`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: FEW_SHOT_1_USER },
    { role: 'assistant', content: FEW_SHOT_1_ASSISTANT },
    { role: 'user', content: FEW_SHOT_2_USER },
    { role: 'assistant', content: FEW_SHOT_2_ASSISTANT },
    { role: 'user', content: chunk.text },
  ];

  const url = `${OLLAMA_BASE}/api/chat`;
  const startMs = performance.now();
  debug('request', { url, model: OLLAMA_MODEL, chunkLen: chunk.text.length, offset: chunk.offset, labels: labelsList });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: getResponseSchema(allowedLabels),
        messages,
        logprobs: true,
        options: {
          temperature: 0,
          top_p: 0,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const elapsedMs = Math.round(performance.now() - startMs);
    debug('response', { ok: res.ok, status: res.status, elapsedMs });

    if (!res.ok) {
      const errBody = await res.text();
      debug('response not ok', res.status, errBody.slice(0, 300));
      return { matches: [], evalCount: 0 };
    }

    const data = (await res.json()) as {
      message?: { content?: unknown };
      logprobs?: unknown;
      eval_count?: number;
    };
    const evalCount = typeof data?.eval_count === 'number' ? data.eval_count : 0;
    const content = data?.message?.content;
    const responseText = typeof content === 'string' ? content : content != null ? String(content) : '';

    // Extract logprob tokens if the model returned them.
    // Ollama returns logprobs as a top-level array of {token, logprob, bytes} objects.
    // We also handle the wrapped {content: [{token, logprob}]} shape defensively.
    let logprobTokens: LogprobToken[] | undefined;
    const rawLogprobs = data?.logprobs;
    if (Array.isArray(rawLogprobs)) {
      logprobTokens = (rawLogprobs as unknown[]).flatMap((entry) => {
        if (entry == null || typeof entry !== 'object') return [];
        const e = entry as Record<string, unknown>;
        // Handle flat {token, logprob} entries
        if (typeof e.token === 'string' && typeof e.logprob === 'number') {
          return [{ token: e.token, logprob: e.logprob }];
        }
        // Handle wrapped {content: [{token, logprob}]} shape
        if (Array.isArray(e.content)) {
          return (e.content as unknown[]).flatMap((c) => {
            if (c == null || typeof c !== 'object') return [];
            const ce = c as Record<string, unknown>;
            if (typeof ce.token === 'string' && typeof ce.logprob === 'number') {
              return [{ token: ce.token, logprob: ce.logprob }];
            }
            return [];
          });
        }
        return [];
      });
      if (logprobTokens.length === 0) logprobTokens = undefined;
    }
    debug('logprobs', { available: logprobTokens != null, tokenCount: logprobTokens?.length ?? 0 });

    let items: OllamaPiiItem[];
    try {
      items = parseJsonArray(responseText);
    } catch {
      return { matches: [], evalCount };
    }

    const allowedSet = new Set(allowedLabels.map((l) => l.toUpperCase()));
    const rawMatches: RawMatch[] = [];

    for (const item of items) {
      const type = mapType(item.label);
      if (!type || !allowedSet.has(item.label.toUpperCase().trim())) continue;
      const value = String(item.value).trim();
      if (!value) continue;
      const label = item.label.toUpperCase().trim();

      let occurrences = findOccurrences(chunk.text, value);
      if (
        occurrences.length === 0 &&
        TYPES_WITH_NORMALIZED_MATCHING.has(type) &&
        /\d/.test(value)
      ) {
        occurrences = findOccurrencesNormalized(chunk.text, value);
      }
      const confidence = logprobTokens != null ? computeConfidence(logprobTokens, value) : undefined;
      for (const { start, end, value: spanValue } of occurrences) {
        rawMatches.push({
          type,
          start: chunk.offset + start,
          end: chunk.offset + end,
          value: spanValue,
          source: sourceName,
          label,
          confidence,
        });
      }
    }

    debug('pass done', { labels: labelsList, itemsFound: rawMatches.length, evalCount, elapsedMs: Math.round(performance.now() - startMs) });
    return { matches: rawMatches, evalCount };
  } catch (err) {
    clearTimeout(timeoutId);
    debug('error:', err instanceof Error ? err.message : err);
    if (DEBUG && err instanceof Error && err.stack) {
      console.log('[PII LLM] stack:', err.stack);
    }
    return { matches: [], evalCount: 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Detector class (single-pass over all labels)                      */
/* ------------------------------------------------------------------ */

export class LlamaDetector implements PIIDetector {
  private lastEvalCount = 0;
  private lastElapsedMs = 0;

  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) {
      debug('collectMatches: empty text, skipping');
      return [];
    }
    if (process.env.PII_LLM_DISABLE === '1') {
      debug('collectMatches: PII_LLM_DISABLE=1, skipping');
      return [];
    }

    const singleChunk = { text, offset: 0 };
    this.lastEvalCount = 0;
    const startMs = Date.now();

    const { matches, evalCount } = await detectChunk(singleChunk, PII_TYPE_ENUM, this.getName());
    this.lastEvalCount = evalCount;

    this.lastElapsedMs = Date.now() - startMs;
    return selectNonOverlapping(matches);
  }

  getLastEvalCount(): number {
    return this.lastEvalCount;
  }

  getLastElapsedMs(): number {
    return this.lastElapsedMs;
  }

  getName(): string {
    return 'LLM';
  }
}
