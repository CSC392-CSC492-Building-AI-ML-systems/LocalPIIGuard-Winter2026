import type { Match, RawMatch } from './types';
import { PiiType } from './types';
import { findOccurrences } from './helper';

type TextRange = {
  start: number;
  end: number;
};

/**
 * Mask text by replacing matched spans with [LABEL] placeholders.
 * Applied from end to start to preserve indices during replacement.
 */
export function maskText(text: string, rawMatches: RawMatch[]): string {
  const sorted = [...rawMatches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    const tag = m.label ?? m.type;
    result = result.slice(0, m.start) + `[${tag}]` + result.slice(m.end);
  }
  return result;
}

/**
 * Reconstruct Match positions in the original text via exact string matching.
 * Called after the full pipeline to map collected { value, source, type } detections
 * back to spans in the original text for the inline preview.
 */
export function reconstructMatches(
  originalText: string,
  detections: Array<{ value: string; source: string; type: PiiType }>
): Match[] {
  const matches: Match[] = [];
  for (const { value, source, type } of detections) {
    for (const { start, end } of findOccurrences(originalText, value)) {
      matches.push({ type, start, end, value, source });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function isWholeTermMatch(text: string, start: number, end: number, term: string): boolean {
  const firstChar = term[0];
  const lastChar = term[term.length - 1];
  const before = text[start - 1];
  const after = text[end];

  if (isWordChar(firstChar) && isWordChar(before)) return false;
  if (isWordChar(lastChar) && isWordChar(after)) return false;
  return true;
}

function collectTermRanges(text: string, terms: string[]): TextRange[] {
  if (terms.length === 0 || !text) return [];

  const ranges: TextRange[] = [];
  const loweredText = text.toLowerCase();
  const normalized = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .map((term) => ({
      original: term,
      lowered: term.toLowerCase(),
    }))
    .sort((a, b) => b.lowered.length - a.lowered.length);

  for (const term of normalized) {
    let fromIndex = 0;

    while (fromIndex < loweredText.length) {
      const start = loweredText.indexOf(term.lowered, fromIndex);
      if (start === -1) break;

      const end = start + term.lowered.length;
      if (isWholeTermMatch(text, start, end, term.original)) {
        ranges.push({ start, end });
      }

      fromIndex = start + term.lowered.length;
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TextRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }

    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}

export function collectManualMatches(
  text: string,
  blacklist: string[],
  type: PiiType = PiiType.BLACKLIST
): RawMatch[] {
  return collectTermRanges(text, blacklist).map((range) => ({
    type,
    start: range.start,
    end: range.end,
    value: text.slice(range.start, range.end),
    source: 'Manual',
  }));
}

function subtractRange(segment: TextRange, blocked: TextRange): TextRange[] {
  if (blocked.end <= segment.start || blocked.start >= segment.end) return [segment];

  const remaining: TextRange[] = [];
  if (blocked.start > segment.start) {
    remaining.push({ start: segment.start, end: blocked.start });
  }
  if (blocked.end < segment.end) {
    remaining.push({ start: blocked.end, end: segment.end });
  }
  return remaining;
}

export function applyAllowlist(
  text: string,
  rawMatches: RawMatch[],
  allowlist: string[]
): RawMatch[] {
  const allowedRanges = collectTermRanges(text, allowlist);
  if (allowedRanges.length === 0) return rawMatches;

  const filtered = rawMatches.flatMap((match) => {
    let segments: TextRange[] = [{ start: match.start, end: match.end }];

    for (const allowed of allowedRanges) {
      if (allowed.start >= match.end) break;
      if (allowed.end <= match.start) continue;

      segments = segments.flatMap((segment) => subtractRange(segment, allowed));
      if (segments.length === 0) break;
    }

    return segments.map((segment) => ({
      ...match,
      start: segment.start,
      end: segment.end,
      value: text.slice(segment.start, segment.end),
    }));
  });

  return filtered.filter((match) => match.start < match.end);
}
