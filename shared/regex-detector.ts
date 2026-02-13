import type { RawMatch, PIIDetector,  } from './types';
import { PiiType } from './types'
/**
 * Regex patterns for PII detection.
 * All patterns use capturing groups to extract the full match.
 */
const PATTERNS: Array<{ type: PiiType; regex: RegExp }> = [
  // Email: basic RFC 5322 simplified
  {
    type: PiiType.EMAIL,
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  // Phone: North America style (xxx) xxx-xxxx, xxx-xxx-xxxx, xxxxxxxxxx
  {
    type: PiiType.PHONE,
    regex: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  },
  // IPv4 addresses
  {
    type: PiiType.IP,
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  },
  // Credit card: 13-19 digits with optional spaces/dashes
  {
    type: PiiType.CARD,
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

export class RegexDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
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
          source: this.getName(),
        });
      }
    }

    return selectNonOverlapping(all);
  }

  getName(): string {
      return "Regex"
  }
}
