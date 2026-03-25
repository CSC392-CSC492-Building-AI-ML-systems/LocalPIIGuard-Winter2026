"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegexDetector = void 0;
const types_1 = require("./types");
/**
 * Regex patterns for PII detection.
 * All patterns use capturing groups to extract the full match.
 */
const PATTERNS = [
    // Email: basic RFC 5322 simplified
    {
        type: types_1.PiiType.EMAIL,
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    },
    // Phone: North America style (xxx) xxx-xxxx, xxx-xxx-xxxx, xxxxxxxxxx
    {
        type: types_1.PiiType.PHONE,
        regex: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    },
    // IPv4 addresses
    {
        type: types_1.PiiType.IP,
        regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    },
    // Credit card: 13-19 digits with optional spaces/dashes
    {
        type: types_1.PiiType.CARD,
        regex: /\b(?:\d[-\s]*){12,18}\d\b/g,
    },
    // Dates
    // ISO 8601: 2024-01-31, 2024/01/31
    {
        type: types_1.PiiType.DATE,
        regex: /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g,
    },
    // US style: 01/31/2024, 1/5/2024, 01-31-2024
    {
        type: types_1.PiiType.DATE,
        regex: /\b(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])[-/]\d{4}\b/g,
    },
    // European style: 31/01/2024, 31.01.2024, 31-01-2024
    {
        type: types_1.PiiType.DATE,
        regex: /\b(?:0?[1-9]|[12]\d|3[01])[.\-/](?:0?[1-9]|1[0-2])[.\-/]\d{4}\b/g,
    },
    // Written month: January 31, 2024 | Jan 31, 2024 | 31 January 2024 | 31 Jan 2024
    {
        type: types_1.PiiType.DATE,
        regex: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
    },
    {
        type: types_1.PiiType.DATE,
        regex: /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4}\b/gi,
    },
    // Times
    // 12-hour: 3:45 PM, 03:45:12 AM, 3pm
    {
        type: types_1.PiiType.TIME,
        regex: /\b(?:0?[1-9]|1[0-2])(?::[0-5]\d){1,2}\s*[AaPp]\.?[Mm]\.?\b/g,
    },
    {
        type: types_1.PiiType.TIME,
        regex: /\b(?:0?[1-9]|1[0-2])\s*[AaPp]\.?[Mm]\.?\b/g,
    },
    // 24-hour: 13:45, 09:05:30, 23:59
    {
        type: types_1.PiiType.TIME,
        regex: /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g,
    },
    // Written: quarter past 3, half past 10, quarter to 5
    {
        type: types_1.PiiType.TIME,
        regex: /\b(?:quarter\s+(?:past|to)|half\s+past)\s+(?:0?[1-9]|1[0-2])\b/gi,
    },
    // Postal codes
    // US ZIP+4 only (plain 5-digit too ambiguous): 12345-6789
    {
        type: types_1.PiiType.LOCATION,
        regex: /\b\d{5}-\d{4}\b/g,
    },
    // Canadian: A1A 1A1 or A1A1A1
    {
        type: types_1.PiiType.LOCATION,
        regex: /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g,
    },
    // UK: SW1A 2AA, EC1A 1BB, W1A 0AX, M1 1AE, B1 1BB
    {
        type: types_1.PiiType.LOCATION,
        regex: /\b[A-Za-z]{1,2}\d{1,2}[A-Za-z]?\s*\d[A-Za-z]{2}\b/g,
    },
    // Social Security Number: 123-45-6789 or 123 45 6789
    {
        type: types_1.PiiType.SOCIALNUMBER,
        regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
    },
    // IPv6: full and compressed forms
    {
        type: types_1.PiiType.IPV6,
        regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:)*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b|\b::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:)+:\b/g,
    },
    // MAC address: AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF or AABBCCDDEEFF
    {
        type: types_1.PiiType.MAC,
        regex: /\b(?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}\b/g,
    },
    // IBAN: up to 34 alphanumeric chars, optional spaces every 4
    {
        type: types_1.PiiType.IBAN,
        regex: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
    },
];
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
class RegexDetector {
    async collectMatches(text) {
        const all = [];
        for (const { type, regex } of PATTERNS) {
            let m;
            const re = new RegExp(regex.source, regex.flags);
            while ((m = re.exec(text)) !== null) {
                all.push({
                    type,
                    start: m.index,
                    end: m.index + m[0].length,
                    value: m[0],
                    source: this.getName(),
                    score: 1
                });
            }
        }
        return selectNonOverlapping(all);
    }
    getName() {
        return "Regex";
    }
}
exports.RegexDetector = RegexDetector;
