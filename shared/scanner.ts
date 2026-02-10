import type { Match, RawMatch, ScanResult } from './types';

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

function overlaps(a: RawMatch, b: RawMatch): boolean {
  return !(a.end <= b.start || a.start >= b.end);
}

/**
 * Select non-overlapping matches.
 * Priority: longer matches first, then earlier start.
 */
function selectNonOverlapping(matches: RawMatch[]): RawMatch[] {
  const ordered = [...matches].sort((a, b) => {
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) return lenB - lenA;
    return a.start - b.start;
  });

  const selected: RawMatch[] = [];
  for (const m of ordered) {
    const hasOverlap = selected.some((s) => overlaps(m, s));
    if (!hasOverlap) selected.push(m);
  }

  selected.sort((a, b) => a.start - b.start);
  return selected;
}

/**
 * Collect regex matches and resolve internal overlaps.
 */
export function collectRegexMatches(text: string): RawMatch[] {
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
        source: 'regex',
      });
    }
  }

  return selectNonOverlapping(all);
}

/**
 * Merge base (regex) matches with extra (NER) matches.
 * Extra matches that overlap base are discarded.
 */
export function mergeMatches(
  baseMatches: RawMatch[],
  extraMatches: RawMatch[]
): RawMatch[] {
  const base = selectNonOverlapping(baseMatches);
  const extra = selectNonOverlapping(extraMatches).filter(
    (m) => !base.some((b) => overlaps(m, b))
  );

  const merged = [...base, ...extra];
  merged.sort((a, b) => a.start - b.start);
  return merged;
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
 * Build redacted text and matches from a RawMatch list.
 */
export function buildRedaction(text: string, rawMatches: RawMatch[]): ScanResult {
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

/**
 * Scan text for PII using regex rules only.
 */
export function scanText(text: string): ScanResult {
  const rawMatches = collectRegexMatches(text);
  return buildRedaction(text, rawMatches);
}
