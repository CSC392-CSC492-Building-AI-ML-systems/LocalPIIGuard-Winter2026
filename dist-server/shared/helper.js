"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.overlaps = overlaps;
exports.selectNonOverlapping = selectNonOverlapping;
exports.findOccurrences = findOccurrences;
function overlaps(a, b) {
    return !(a.end <= b.start || a.start >= b.end);
}
/**
 * Select non-overlapping matches.
 * Priority: longer matches first, then earlier start.
 */
function selectNonOverlapping(matches) {
    const ordered = [...matches].sort((a, b) => {
        const lenA = a.end - a.start;
        const lenB = b.end - b.start;
        if (lenB !== lenA)
            return lenB - lenA;
        return a.start - b.start;
    });
    const selected = [];
    for (const m of ordered) {
        const hasOverlap = selected.some((s) => overlaps(m, s));
        if (!hasOverlap)
            selected.push(m);
    }
    selected.sort((a, b) => a.start - b.start);
    return selected;
}
/**
 * Find all non-overlapping occurrences of needle in text.
 */
function findOccurrences(text, needle) {
    if (!needle)
        return [];
    const spans = [];
    let pos = 0;
    while (pos < text.length) {
        const idx = text.indexOf(needle, pos);
        if (idx === -1)
            break;
        spans.push({ start: idx, end: idx + needle.length });
        pos = idx + needle.length;
    }
    return spans;
}
