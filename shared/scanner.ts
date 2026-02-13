import type { Match, RawMatch, ScanResult } from './types';
import { selectNonOverlapping, overlaps } from './helper';

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