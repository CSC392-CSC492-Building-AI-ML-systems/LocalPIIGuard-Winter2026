import type { Match, ScanResult } from './types';

/**
 * Regex patterns for PII detection.
 * All patterns use capturing groups to extract the full match.
 */
const PATTERNS: Array<{ type: string; regex: RegExp }> = [
  // Email: basic RFC 5322 simplified
  {
    type: 'EMAIL',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  // Phone: North America style (xxx) xxx-xxxx, xxx-xxx-xxxx, xxxxxxxxxx
  {
    type: 'PHONE',
    regex: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  },
  // IPv4 addresses
  {
    type: 'IP',
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  },
  // Credit card: 13-19 digits with optional spaces/dashes
  {
    type: 'CARD',
    regex: /\b(?:\d[-\s]*){12,18}\d\b/g,
  },
];

interface RawMatch {
  type: string;
  start: number;
  end: number;
  value: string;
}

/**
 * Find all matches from all patterns, then resolve overlaps.
 * Priority: longer matches first, then earlier start.
 */
function collectMatches(text: string): RawMatch[] {
  const all: RawMatch[] = [];

  for (const { type, regex } of PATTERNS) {
    let m: RegExpExecArray | null;
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(text)) !== null) {
      all.push({
        type,
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
      });
    }
  }

  // Sort: longer first, then earlier start
  all.sort((a, b) => {
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) return lenB - lenA;
    return a.start - b.start;
  });

  // Filter overlapping: keep only non-overlapping matches
  const selected: RawMatch[] = [];
  for (const m of all) {
    const overlaps = selected.some(
      (s) => !(m.end <= s.start || m.start >= s.end)
    );
    if (!overlaps) selected.push(m);
  }

  // Sort by start for stable ordering
  selected.sort((a, b) => a.start - b.start);

  return selected;
}

/**
 * Build placeholder map: same value => same placeholder within a scan.
 */
function buildPlaceholderMap(matches: RawMatch[]): Map<string, string> {
  const valueToPlaceholder = new Map<string, string>();
  const counters: Record<string, number> = {};

  for (const m of matches) {
    const key = `${m.type}:${m.value}`;
    if (!valueToPlaceholder.has(key)) {
      const n = (counters[m.type] ?? 0) + 1;
      counters[m.type] = n;
      valueToPlaceholder.set(key, `[${m.type}_${n}]`);
    }
  }

  return valueToPlaceholder;
}

/**
 * Scan text for PII and return redacted text + matches.
 */
export function scanText(text: string): ScanResult {
  const rawMatches = collectMatches(text);
  const placeholderMap = buildPlaceholderMap(rawMatches);

  const matches: Match[] = rawMatches.map((m) => ({
    type: m.type,
    start: m.start,
    end: m.end,
    value: m.value,
  }));

  // Build redacted text by replacing from end to start (preserves indices)
  let redactedText = text;
  const replacements = rawMatches
    .map((m) => {
      const key = `${m.type}:${m.value}`;
      const placeholder = placeholderMap.get(key)!;
      return { start: m.start, end: m.end, placeholder };
    })
    .sort((a, b) => b.start - a.start); // reverse order

  for (const { start, end, placeholder } of replacements) {
    redactedText =
      redactedText.slice(0, start) + placeholder + redactedText.slice(end);
  }

  return { redactedText, matches };
}
