import type { Match, RawMatch } from './types';
import type { PiiType } from './types';
import { findOccurrences } from './helper';

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
  detections: Array<{ value: string; source: string; type: PiiType; confidence?: number }>
): Match[] {
  const matches: Match[] = [];
  for (const { value, source, type, confidence } of detections) {
    for (const { start, end } of findOccurrences(originalText, value)) {
      matches.push({ type, start, end, value, source, confidence });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
