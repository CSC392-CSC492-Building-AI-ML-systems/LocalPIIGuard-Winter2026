"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskText = maskText;
exports.reconstructMatches = reconstructMatches;
exports.collectManualMatches = collectManualMatches;
exports.applyAllowlist = applyAllowlist;
const types_1 = require("./types");
const helper_1 = require("./helper");
/**
 * Mask text by replacing matched spans with [LABEL] placeholders.
 * Merges overlapping/adjacent spans first so multiple detectors flagging the
 * same region Within a merged group the
 * highest score span's label wins; ties go to the widest span.
 * Applied from end to start to preserve indices during replacement.
 */
function maskText(text, rawMatches) {
    if (rawMatches.length === 0)
        return text;
    // Sort by start asc, then by span width desc (widest first within same start)
    const sorted = [...rawMatches].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    // merge overlapping spans, keeping the representative with the highest score
    const merged = [];
    for (const m of sorted) {
        const prev = merged[merged.length - 1];
        if (prev && m.start < prev.end) {
            // overlapping, keep higher score label
            if (m.end > prev.end)
                prev.end = m.end;
            const prevScore = prev.score ?? 0;
            const mScore = m.score ?? 0;
            if (mScore > prevScore) {
                prev.type = m.type;
                prev.label = m.label ?? m.type;
                prev.source = m.source;
                prev.score = m.score;
                prev.value = text.slice(prev.start, prev.end);
            }
        }
        else {
            merged.push({ ...m });
        }
    }
    let result = text;
    for (const m of merged.sort((a, b) => b.start - a.start)) {
        const tag = m.label ?? m.type;
        result = result.slice(0, m.start) + `[${tag}]` + result.slice(m.end);
    }
    return result;
}
/**
 * Reconstruct Match positions in the original text via exact string matching.
 * Called after the full pipeline to map collected { value, source, type, score } detections
 * back to spans in the original text for the inline preview.
 */
function reconstructMatches(originalText, detections) {
    // deduplicate spans that multiple detectors find. keep entry with higher confidence score
    const spanMap = new Map();
    for (const { value, source, type, score } of detections) {
        for (const { start, end } of (0, helper_1.findOccurrences)(originalText, value)) {
            const key = `${start}-${end}`;
            const existing = spanMap.get(key);
            const incomingScore = score ?? 0;
            const existingScore = existing?.score ?? 0;
            if (!existing || incomingScore > existingScore) {
                spanMap.set(key, { type, start, end, value, source, score: score ?? undefined });
            }
        }
    }
    // merge overlapping spans 
    const sorted = [...spanMap.values()].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const merged = [];
    for (const m of sorted) {
        const prev = merged[merged.length - 1];
        if (prev && m.start < prev.end) {
            if (m.end > prev.end) {
                prev.end = m.end;
                prev.value = originalText.slice(prev.start, prev.end);
            }
            if ((m.score ?? 0) > (prev.score ?? 0)) {
                prev.type = m.type;
                prev.source = m.source;
                prev.score = m.score ?? undefined;
            }
        }
        else {
            merged.push({ ...m });
        }
    }
    return merged;
}
function isWordChar(char) {
    return !!char && /[A-Za-z0-9_]/.test(char);
}
function isWholeTermMatch(text, start, end, term) {
    const firstChar = term[0];
    const lastChar = term[term.length - 1];
    const before = text[start - 1];
    const after = text[end];
    if (isWordChar(firstChar) && isWordChar(before))
        return false;
    if (isWordChar(lastChar) && isWordChar(after))
        return false;
    return true;
}
function collectTermRanges(text, terms) {
    if (terms.length === 0 || !text)
        return [];
    const ranges = [];
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
            if (start === -1)
                break;
            const end = start + term.lowered.length;
            if (isWholeTermMatch(text, start, end, term.original)) {
                ranges.push({ start, end });
            }
            fromIndex = start + term.lowered.length;
        }
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
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
function collectManualMatches(text, blacklist, type = types_1.PiiType.BLACKLIST) {
    return collectTermRanges(text, blacklist).map((range) => ({
        type,
        start: range.start,
        end: range.end,
        value: text.slice(range.start, range.end),
        source: 'Manual',
        confidence: 1,
    }));
}
function subtractRange(segment, blocked) {
    if (blocked.end <= segment.start || blocked.start >= segment.end)
        return [segment];
    const remaining = [];
    if (blocked.start > segment.start) {
        remaining.push({ start: segment.start, end: blocked.start });
    }
    if (blocked.end < segment.end) {
        remaining.push({ start: blocked.end, end: segment.end });
    }
    return remaining;
}
function applyAllowlist(text, rawMatches, allowlist) {
    const allowedRanges = collectTermRanges(text, allowlist);
    if (allowedRanges.length === 0)
        return rawMatches;
    const filtered = rawMatches.flatMap((match) => {
        let segments = [{ start: match.start, end: match.end }];
        for (const allowed of allowedRanges) {
            if (allowed.start >= match.end)
                break;
            if (allowed.end <= match.start)
                continue;
            segments = segments.flatMap((segment) => subtractRange(segment, allowed));
            if (segments.length === 0)
                break;
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
