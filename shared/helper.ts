import type { RawMatch } from './types';

export function overlaps(a: RawMatch, b: RawMatch): boolean {
  return !(a.end <= b.start || a.start >= b.end);
}

/**
 * Select non-overlapping matches.
 * Priority: longer matches first, then earlier start.
 */
export function selectNonOverlapping(matches: RawMatch[]): RawMatch[] {
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
