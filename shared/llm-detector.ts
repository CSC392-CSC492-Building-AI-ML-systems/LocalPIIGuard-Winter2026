import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';
import { selectNonOverlapping } from './helper';

const OLLAMA_BASE = process.env.PII_OLLAMA_BASE ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.PII_OLLAMA_MODEL ?? 'mistral:7b-instruct-v0.3-q4_K_M';
const OLLAMA_TIMEOUT_MS = Number(process.env.PII_OLLAMA_TIMEOUT_MS) || 60000;

const DEBUG = /^1|true|yes$/i.test(process.env.PII_LLM_DEBUG ?? '') || /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[PII LLM]', ...args);
  }
}

type OllamaPiiItem = { type: string; value: string; reason?: string };

const VALID_PII_TYPES = new Set<string>([
  PiiType.EMAIL,
  PiiType.PHONE,
  PiiType.IP,
  PiiType.CARD,
  PiiType.NAME,
  PiiType.LOCATION,
  PiiType.ORG,
  PiiType.DATE,
]);

const PII_TYPE_ENUM = ['EMAIL', 'PHONE', 'IP', 'CARD', 'NAME', 'LOCATION', 'ORG', 'DATE'];

/** JSON schema for chat format: root object with items array. Ensures model returns array, not a single object. */
function getResponseSchema(): Record<string, unknown> {
  const itemSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: PII_TYPE_ENUM },
      value: { type: 'string' },
    },
    required: ['type', 'value'],
  };
  if (DEBUG) {
    (itemSchema.properties as Record<string, unknown>)['reason'] = { type: 'string', description: 'Brief reason for this detection (debug only)' };
  }
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

function mapType(raw: string): PiiType | null {
  const upper = raw?.toUpperCase?.()?.trim?.();
  if (upper && VALID_PII_TYPES.has(upper)) return upper as PiiType;
  return null;
}

/**
 * Find all non-overlapping occurrences of `needle` in `text`, returning [start, end] pairs.
 * The returned span uses the exact substring from text (so value can differ from needle).
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
 * Fallback: extract one or more {"type":"...","value":"..."} from text via regex.
 * Handles pretty-printed or truncated JSON when JSON.parse fails or returns no items.
 */
function parseJsonArrayFallback(response: string): OllamaPiiItem[] {
  const items: OllamaPiiItem[] = [];
  const re = /"type"\s*:\s*"([^"]*)"\s*,\s*"value"\s*:\s*"([^"]*)"|"value"\s*:\s*"([^"]*)"\s*,\s*"type"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const type = m[1] ?? m[4] ?? '';
    const value = m[2] ?? m[3] ?? '';
    if (type && value) items.push({ type, value });
  }
  return items;
}

/**
 * Normalize item to OllamaPiiItem (optional reason in debug).
 */
function normalizeItem(obj: unknown): OllamaPiiItem | null {
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  const value = typeof o.value === 'string' ? o.value : '';
  if (!type || !value) return null;
  const item: OllamaPiiItem = { type, value };
  if (DEBUG && typeof o.reason === 'string') item.reason = o.reason;
  return item;
}

/**
 * Extract items from the model response. Expects { items: [...] } from schema, or raw array.
 * May be wrapped in markdown code block. Falls back to regex if parse yields no items.
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

    const systemPrompt = `You are a PII (personally identifiable information) detector. Your task is to list every PII span in the user's text.

Coverage: You MUST find all instances of PII in the text. Output an empty list only if there is absolutely no PII present. Do not guess or infer. If unsure whether something is PII, do not include it.

Rules:
- Only mark PII that is explicitly present in the text. Use the exact substring (character-for-character).
- Never infer missing parts (e.g. do not add "Toronto" if the text only says "I live downtown").
- "type" must be one of: EMAIL, PHONE, IP, CARD, NAME, LOCATION, ORG, DATE
- "value" must be the exact substring that appears in the text.
${DEBUG ? '- "reason": optional brief explanation for this detection (one line).' : ''}

Respond with a single JSON object of the form: { "items": [ { "type": "...", "value": "..."${DEBUG ? ', "reason": "..."' : ''} }, ... ] }. Use "items": [] only when there are no PII spans at all.`;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
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
      const typesWithNormalizedMatching = new Set<PiiType>([PiiType.PHONE, PiiType.CARD]);

      for (const item of items) {
        if (DEBUG && item.reason) debug('item reason:', item.type, item.value, item.reason);
        const type = mapType(item.type);
        if (!type) continue;
        const value = String(item.value).trim();
        if (!value) continue;
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
