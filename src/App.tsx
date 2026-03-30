import { useState, useCallback, useEffect, useRef } from 'react';
import { PiiType } from '@shared/types';

interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
  source: string;
  score?: number;
}

const SOURCE_COLORS: Record<string, string> = {
  Regex: '#fde68a',
  'Ner (Spacy)': '#a5f3fc',
  LLM: '#e9d5ff',
  Manual: '#fecaca',
  'Presidio': '#11f3fc',
  
};

const DEFAULT_SOURCE_COLOR = '#fed7aa';

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? DEFAULT_SOURCE_COLOR;
}

interface ScanResult {
  redactedText: string;
  matches: Match[];
  elapsedMs?: number;
  llmTokens?: number;
  llmElapsedMs?: number;
}

interface ScanRequest {
  text: string;
  allowlist?: string[];
  blacklist?: string[];
}

interface WordLists {
  allowlist: string[];
  blacklist: string[];
}

type LayerState = Record<string, boolean>;
type WordListMenu = 'allowlist' | 'blacklist' | null;


interface BlacklistEntry {
  term: string;
  type: string;
}

const PII_TYPES = Object.values(PiiType);
const COMMON_PII_TYPES: PiiType[] = [
  PiiType.EMAIL, PiiType.PHONE, PiiType.NAME, PiiType.LOCATION,
  PiiType.ORG, PiiType.ID, PiiType.DATE, PiiType.CARD,
];

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const SCAN_HINT = isMac ? '⌘ Return' : 'Ctrl+Enter';

type NerStatus = 'starting' | 'ready' | 'unavailable';

const ALLOWLIST_STORAGE_KEY = 'pii-allowlist';
const BLACKLIST_STORAGE_KEY = 'pii-blacklist';

declare global {
  interface Window {
    pii?: {
      scanText: (request: ScanRequest | string) => Promise<ScanResult>;
      copyToClipboard: (text: string) => Promise<void>;
      syncWordLists: (lists: WordLists) => Promise<void>;
      getLayerState: () => Promise<LayerState>;
      setLayer: (name: string, enabled: boolean) => Promise<void>;
      onLayerState: (handler: (state: LayerState) => void) => () => void;
      onWordLists: (handler: (lists: WordLists) => void) => () => void;
      onOpenWordListEditor: (
        handler: (menu: Exclude<WordListMenu, null>) => void
      ) => () => void;
      getNerStatus: () => Promise<NerStatus>;
      onNerStatus: (handler: (status: NerStatus) => void) => () => void;
      saveRedacted: (text: string) => Promise<{ success: boolean; filePath?: string; reason?: string }>;
    };
  }
}
/*
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}*/

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return s % 1 === 0 ? `${s} s` : `${s.toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`;
}

function formatTimePerToken(llmElapsedMs: number, llmTokens: number): string {
  if (llmTokens <= 0) return '';
  const msPerTok = llmElapsedMs / llmTokens;
  const tokPerS = llmTokens / (llmElapsedMs / 1000);
  if (msPerTok >= 1) {
    return `${msPerTok.toFixed(1)} ms/tok | ${tokPerS.toFixed(1)} tok/s`;
  }
  return `${(msPerTok * 1000).toFixed(0)} us/tok | ${tokPerS.toFixed(0)} tok/s`;
}

function buildHighlightedPreview(text: string, matches: Match[]): React.ReactNode[] {
  if (!text || matches.length === 0) {
    return [<span key={0}>{text}</span>];
  }

  // Deduplicate exact spans and collapse overlaps 
  const seen = new Set<string>();
  const deduped: Match[] = [];
  [...matches]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .forEach((m) => {
      const key = `${m.start}-${m.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      const last = deduped[deduped.length - 1];
      if (last && m.start < last.end) return; // skip overlapping
      deduped.push(m);
    });

  const nodes: React.ReactNode[] = [];
  let lastEnd = 0;
  let nodeKey = 0;

  for (const m of deduped) {
    if (m.start > lastEnd) {
      nodes.push(<span key={nodeKey++}>{text.slice(lastEnd, m.start)}</span>);
    }
    if (m.start >= lastEnd) {
      const color = sourceColor(m.source);
      const confidencePct = m.score != null ? Math.round(m.score * 100) : null;
      const tooltipParts = [m.type, m.source];
      if (confidencePct != null) tooltipParts.push(`confidence ${confidencePct}%`);

      nodes.push(
        <mark
          key={nodeKey++}
          style={{ background: color, borderRadius: 3, padding: '0 2px' }}
          title={`${m.type} | ${m.source}`}
        >
          {text.slice(m.start, m.end)}
          {confidencePct != null && (
            <sup
              style={{
                fontSize: '0.65em',
                fontWeight: 600,
                marginLeft: 2,
                opacity: 0.75,
                letterSpacing: 0,
              }}
            >
              {confidencePct}%
            </sup>
          )}
        </mark>
      );
      lastEnd = m.end;
    }
  }

  if (lastEnd < text.length) {
    nodes.push(<span key={nodeKey++}>{text.slice(lastEnd)}</span>);
  }

  return nodes;
}


function isWordChar(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

function computeBlacklistMatches(text: string, blacklist: BlacklistEntry[], allowlist: string[]): Match[] {
  if (!text || blacklist.length === 0) return [];

  const textLower = text.toLowerCase();
  const matches: Match[] = [];
  const entries = blacklist
    .filter((e) => e.term.trim())
    .sort((a, b) => b.term.length - a.term.length);

  for (const entry of entries) {
    const termLower = entry.term.toLowerCase();
    let i = 0;
    while (i < textLower.length) {
      const start = textLower.indexOf(termLower, i);
      if (start === -1) break;
      const end = start + entry.term.length;
      if (!isWordChar(text[start - 1]) && !isWordChar(text[end])) {
        matches.push({ type: entry.type, start, end, value: text.slice(start, end), source: 'Manual' });
      }
      i = end;
    }
  }

  if (allowlist.length === 0) return matches;

  const allowedRanges: Array<{ start: number; end: number }> = [];
  for (const term of allowlist) {
    const termLower = term.toLowerCase().trim();
    if (!termLower) continue;
    let i = 0;
    while (i < textLower.length) {
      const start = textLower.indexOf(termLower, i);
      if (start === -1) break;
      allowedRanges.push({ start, end: start + term.length });
      i = start + term.length;
    }
  }

  return matches.filter((m) => !allowedRanges.some((r) => r.start <= m.start && r.end >= m.end));
}

function mergeMatches(base: Match[], extra: Match[]): Match[] {
  const sorted = [...base, ...extra].sort((a, b) => a.start - b.start);
  const result: Match[] = [];
  let lastEnd = 0;
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      result.push(m);
      lastEnd = m.end;
    }
  }
  return result;
}

function buildRedactedString(text: string, matches: Match[]): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.start) + `[${m.type}]` + result.slice(m.end);
  }
  return result;
}

// function buildRedactedPreview(
//   text: string,
//   matches: Match[],
//   revealedIndices: Set<number>,
//   onToggle: (index: number) => void
// ): React.ReactNode[] {
//   if (!text || matches.length === 0) return [text || ''];

//   const sorted = matches
//     .map((m, i) => ({ ...m, originalIndex: i }))
//     .sort((a, b) => a.start - b.start);

//   const nodes: React.ReactNode[] = [];
//   let lastEnd = 0;

//   for (const m of sorted) {
//     if (m.start > lastEnd) {
//       nodes.push(text.slice(lastEnd, m.start));
//     }

//     const revealed = revealedIndices.has(m.originalIndex);
//     if (revealed) {
//       nodes.push(
//         <span
//           key={`${m.originalIndex}-revealed`}
//           className="redacted-revealed"
//           onClick={() => onToggle(m.originalIndex)}
//           title={`${m.type} | ${m.source} — click to re-redact`}
//         >
//           {m.value}
//         </span>
//       );
//     } else {
//       nodes.push(
//         <span
//           key={`${m.originalIndex}-tag`}
//           className="redacted-tag"
//           onClick={() => onToggle(m.originalIndex)}
//           title={`${m.type} | ${m.source} — click to reveal`}
//         >
//           [{m.type}]
//         </span>
//       );
//     }

//     lastEnd = m.end;
//   }

//   if (lastEnd < text.length) {
//     nodes.push(text.slice(lastEnd));
//   }

//   return nodes;
// }

function loadTermList(storageKey: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}


function loadBlacklist(): BlacklistEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BLACKLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        typeof item === 'string'
          ? { term: item, type: 'BLACKLIST' }
          : typeof item?.term === 'string'
            ? (item as BlacklistEntry)
            : null
      )
      .filter((item): item is BlacklistEntry => item !== null);
  } catch {
    return [];
  }
}

function listsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

// redacted token tooltip 

interface TooltipProps {
  match: Match;
  isRevealed: boolean;
  onToggle: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function RedactedTooltip({ match, isRevealed, onToggle, anchorRef, onMouseEnter, onMouseLeave }: TooltipProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();

    const tooltipW = 220;
    const GAP = 8;
    let left = anchorRect.left + anchorRect.width / 2;
    left = Math.max(tooltipW / 2 + GAP, Math.min(window.innerWidth - tooltipW / 2 - GAP, left));
    const top = anchorRect.top - GAP;

    setPos({ top, left });
  }, [anchorRef]);

  const score = match.score;
  const scoreLabel =
    score == null
      ? 'N/A'
      : score >= 0.9
      ? 'High'
      : score >= 0.7
      ? 'Medium'
      : 'Low';
  const scoreColor =
    score == null
      ? '#888'
      : score >= 0.9
      ? '#4ade80'
      : score >= 0.7
      ? '#facc15'
      : '#f87171';

  const color = sourceColor(match.source);

  return (
    <div
      className="redacted-tooltip"
      style={
        pos
          ? {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: 'translate(-50%, -100%)',
            }
          : { visibility: 'hidden', position: 'fixed' }
      }
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="tooltip-arrow" />

      <div className="tooltip-row tooltip-meta">
        <span
          className="tooltip-badge"
          style={{ background: color, color: '#111' }}
        >
          {match.type}
        </span>
      </div>

      <div className="tooltip-row">
        <span className="tooltip-label">Original</span>
        <span className="tooltip-value tooltip-original">{match.value}</span>
      </div>

      {score != null && (
        <div className="tooltip-row">
          <span className="tooltip-label">Confidence</span>
          <span className="tooltip-value">
            <span className="tooltip-score-bar">
              <span
                className="tooltip-score-fill"
                style={{ width: `${Math.round(score * 100)}%`, background: scoreColor }}
              />
            </span>
            <span style={{ color: scoreColor, fontWeight: 600, marginLeft: 6 }}>
              {Math.round(score * 100)}%
            </span>
            <span style={{ color: '#888', marginLeft: 4, fontSize: 10 }}>
              ({scoreLabel})
            </span>
          </span>
        </div>
      )}

      <div className="tooltip-actions">
        <button
          className={`tooltip-btn ${isRevealed ? 'tooltip-btn-redo' : 'tooltip-btn-undo'}`}
          onClick={onToggle}
        >
          {isRevealed ? (
            <>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Re-redact
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M10 6H2M6 10L2 6l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Reveal
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// redacted token chip 

interface TokenProps {
  match: Match;
  redactedLabel: string;
  isRevealed: boolean;
  onToggle: () => void;
}

function RedactedToken({ match, redactedLabel, isRevealed, onToggle }: TokenProps) {
  const [hovered, setHovered] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const color = sourceColor(match.source);

  const handleMouseEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHovered(true);
  };

  const handleMouseLeave = () => {
    hideTimer.current = setTimeout(() => setHovered(false), 120);
  };

  return (
    <span
      className="redacted-token-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {hovered && (
        <RedactedTooltip
          match={match}
          isRevealed={isRevealed}
          onToggle={onToggle}
          anchorRef={chipRef as React.RefObject<HTMLElement>}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        />
      )}
      <span
        ref={chipRef}
        className={`redacted-chip ${isRevealed ? 'redacted-chip--revealed' : ''}`}
        style={
          isRevealed
            ? { background: `${color}33`, borderColor: color, color }
            : {}
        }
      >
        {isRevealed ? match.value : redactedLabel}
      </span>
    </span>
  );
}

// redacted output panel 

interface RedactedPanelProps {
  redactedText: string;
  matches: Match[];
  revealedMatches: Set<number>;
  onToggle: (matchIndex: number) => void;
  placeholder: string;
}

/**
 * Parses the redacted text and injects interactive chips for each redacted span.
 * Strategy: walk the original `matches` sorted by start offset; for each match
 * find the corresponding placeholder in `redactedText` and replace with a chip.
 */
function RedactedPanel({ redactedText, matches, revealedMatches, onToggle, placeholder }: RedactedPanelProps) {
  if (!redactedText) {
    return (
      <div className="redacted-output-panel redacted-output-panel--empty">
        {placeholder}
      </div>
    );
  }

  // deduplicate matches 
  const seen = new Set<string>();
  const deduped: (Match & { origIdx: number })[] = [];
  [...matches]
    .map((m, i) => ({ ...m, origIdx: i }))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .forEach((m) => {
      const key = `${m.start}-${m.end}`;
      if (seen.has(key)) return; // exact duplicate span, skip
      seen.add(key);
      const last = deduped[deduped.length - 1];
      if (last && m.start < last.end) {
        // overlapping but not identical, keep higher confidence 
        if ((m.score ?? 0) > (last.score ?? 0)) {
          seen.delete(`${last.start}-${last.end}`);
          deduped[deduped.length - 1] = m;
        }
        // either way, don't push a second entry
      } else {
        deduped.push(m);
      }
    });

  // Log for debugging 
  // console.debug('[RedactedPanel] redactedText:', JSON.stringify(redactedText));
  // console.debug('[RedactedPanel] deduped matches:', deduped.map(m => `${m.start}-${m.end} ${m.type} (${m.source})`));

  // scan redactedText for placeholders and zip with deduped matches 
  // no spaces allowed inside brackets 
  const PLACEHOLDER_RE = /(\[[\w:/.-]+\]|<[\w:/.-]+>|█+|\*{3,})/g;

  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let matchCursor = 0;
  let segKey = 0; // monotonically increasing key — never duplicates
  let placeholderMatch: RegExpExecArray | null;

  while ((placeholderMatch = PLACEHOLDER_RE.exec(redactedText)) !== null) {
    const before = redactedText.slice(lastIndex, placeholderMatch.index);
    if (before) segments.push(<span key={segKey++}>{before}</span>);

    const correspondingMatch = deduped[matchCursor];
    if (correspondingMatch) {
      const idx = correspondingMatch.origIdx;
      segments.push(
        <RedactedToken
          key={segKey++}
          match={correspondingMatch}
          redactedLabel={placeholderMatch[0]}
          isRevealed={revealedMatches.has(idx)}
          onToggle={() => onToggle(idx)}
        />
      );
      matchCursor++;
    } else {
      // more placeholders in text than matches, render as plain text
      segments.push(<span key={segKey++}>{placeholderMatch[0]}</span>);
    }

    lastIndex = placeholderMatch.index + placeholderMatch[0].length;
  }

  if (lastIndex < redactedText.length) {
    segments.push(<span key={segKey++}>{redactedText.slice(lastIndex)}</span>);
  }

  // if no placeholders were detected at all, show text as is
  if (segments.length === 0 || matchCursor === 0) {
    return (
      <div className="redacted-output-panel">
        <pre className="redacted-pre">{redactedText}</pre>
      </div>
    );
  }

  return (
    <div className="redacted-output-panel">
      <pre className="redacted-pre">{segments}</pre>
    </div>
  );
}

// Main App 

function App() {
  const [input, setInput] = useState('');
  const [redacted, setRedacted] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [revealedMatches, setRevealedMatches] = useState<Set<number>>(new Set());
  const [scannedInput, setScannedInput] = useState('');
  const [detectorMatches, setDetectorMatches] = useState<Match[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);
  const [llmTokens, setLlmTokens] = useState<number | undefined>(undefined);
  const [llmElapsedMs, setLlmElapsedMs] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nerStatus, setNerStatus] = useState<NerStatus | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showWordLists, setShowWordLists] = useState(() =>
    loadTermList(ALLOWLIST_STORAGE_KEY).length > 0 || loadBlacklist().length > 0
  );

  const [activeMenu, setActiveMenu] = useState<WordListMenu>(null);
  const [allowlistInput, setAllowlistInput] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [blacklistTypeInput, setBlacklistTypeInput] = useState('BLACKLIST');
  const [allowlist, setAllowlist] = useState<string[]>(() => loadTermList(ALLOWLIST_STORAGE_KEY));
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>(() => loadBlacklist());
  const [layerState, setLayerState] = useState<LayerState>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string; step: 'main' | 'blacklist-type'; showAll?: boolean } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(ALLOWLIST_STORAGE_KEY, JSON.stringify(allowlist)); } catch { return; }
  }, [allowlist]);

  useEffect(() => {
    try { window.localStorage.setItem(BLACKLIST_STORAGE_KEY, JSON.stringify(blacklist)); } catch { return; }
  }, [blacklist]);

  useEffect(() => {
    if (!window.pii?.syncWordLists) return;
    void window.pii.syncWordLists({ allowlist, blacklist: blacklist.map((e) => e.term) });
  }, [allowlist, blacklist]);

  useEffect(() => {
    let cleanupLayers: (() => void) | undefined;
    let cleanupWordLists: (() => void) | undefined;
    let cleanupOpenEditor: (() => void) | undefined;

    const init = async () => {
      if (
        !window.pii?.getLayerState ||
        !window.pii?.onLayerState ||
        !window.pii?.onWordLists ||
        !window.pii?.onOpenWordListEditor
      ) return;

      try {
        const current = await window.pii.getLayerState();
        setLayerState(current);
      } catch { return; }

      cleanupLayers = window.pii.onLayerState((state) => setLayerState(state));
      cleanupWordLists = window.pii.onWordLists((lists) => {
        setAllowlist((current) =>
          listsEqual(current, lists.allowlist) ? current : lists.allowlist
        );

        setBlacklist((current) => {
          const existingMap = new Map(current.map((e) => [e.term.toLowerCase(), e]));
          const merged = lists.blacklist.map(
            (term) => existingMap.get(term.toLowerCase()) ?? { term, type: 'BLACKLIST' }
          );
          const same =
            merged.length === current.length &&
            merged.every((e, i) => e.term === current[i].term && e.type === current[i].type);
          return same ? current : merged;
        });
      });
      cleanupOpenEditor = window.pii.onOpenWordListEditor((menu) => setActiveMenu(menu));
    };

    void init();
    return () => {
      if (cleanupLayers) cleanupLayers();
      if (cleanupWordLists) cleanupWordLists();
      if (cleanupOpenEditor) cleanupOpenEditor();
    };
  }, []);

  useEffect(() => {
    if (!scannedInput) return;
    const newBlacklistMatches = computeBlacklistMatches(scannedInput, blacklist, allowlist);
    const merged = mergeMatches(detectorMatches, newBlacklistMatches);
    setMatches(merged);
    setRedacted(buildRedactedString(scannedInput, merged));
    setRevealedMatches(new Set());
  }, [blacklist, scannedInput, detectorMatches, allowlist]);

  useEffect(() => {
    if (scannedInput) setIsStale(input !== scannedInput);
  }, [input, scannedInput]);

  useEffect(() => {
    if (!window.pii?.getNerStatus || !window.pii?.onNerStatus) return;
    void window.pii.getNerStatus().then(setNerStatus).catch(() => {});
    const cleanup = window.pii.onNerStatus(setNerStatus);
    return cleanup;
  }, []);



  const handleScan = useCallback(async () => {
    setError(null);
    if (!input.trim()) { setError('Paste some text to scan first.'); return; }
    if (!window.pii?.scanText) { setError('Electron API not available'); return; }
    setIsScanning(true);
    try {
      const result = await window.pii.scanText({
        text: input,
        allowlist,
        blacklist: blacklist.map((e) => e.term),
      });
      setRedacted(result.redactedText);
      setMatches(result.matches);
      setRevealedMatches(new Set());
      setScannedInput(input);
      setDetectorMatches(result.matches.filter((m) => m.source !== 'Manual'));
      setElapsedMs(result.elapsedMs);
      setLlmTokens(result.llmTokens);
      setLlmElapsedMs(result.llmElapsedMs);
      setIsStale(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, [allowlist, blacklist, input]);

  const handleCopy = useCallback(async () => {
    if (!redacted) return;

    // Build a version of the redacted text where revealed tokens are substituted back
    let visibleText = redacted;
    if (revealedMatches.size > 0) {
      // Reconstruct deduped match list the same way RedactedPanel does
      const seen = new Set<string>();
      const deduped: (Match & { origIdx: number })[] = [];
      [...matches]
        .map((m, i) => ({ ...m, origIdx: i }))
        .sort((a, b) => a.start - b.start || b.end - a.end)
        .forEach((m) => {
          const key = `${m.start}-${m.end}`;
          if (seen.has(key)) return;
          seen.add(key);
          const last = deduped[deduped.length - 1];
          if (last && m.start < last.end) {
            if ((m.score ?? 0) > (last.score ?? 0)) {
              seen.delete(`${last.start}-${last.end}`);
              deduped[deduped.length - 1] = m;
            }
          } else {
            deduped.push(m);
          }
        });

      // Walk placeholders in redactedText and replace revealed ones with original values
      const PLACEHOLDER_RE = /(\[[\w:/.-]+\]|<[\w:/.-]+>|█+|\*{3,})/g;
      let result = '';
      let lastIndex = 0;
      let matchCursor = 0;
      let placeholderMatch: RegExpExecArray | null;

      while ((placeholderMatch = PLACEHOLDER_RE.exec(redacted)) !== null) {
        result += redacted.slice(lastIndex, placeholderMatch.index);
        const correspondingMatch = deduped[matchCursor];
        if (correspondingMatch && revealedMatches.has(correspondingMatch.origIdx)) {
          result += correspondingMatch.value;
        } else {
          result += placeholderMatch[0];
        }
        if (correspondingMatch) matchCursor++;
        lastIndex = placeholderMatch.index + placeholderMatch[0].length;
      }
      result += redacted.slice(lastIndex);
      visibleText = result;
    }

    const flashCopied = () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    };

    if (!window.pii?.copyToClipboard) {
      try {
        await navigator.clipboard.writeText(visibleText);
        flashCopied();
      } catch { setError('Clipboard not available'); }
      return;
    }
    try {
      await window.pii.copyToClipboard(visibleText);
      flashCopied();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copy failed');
    }
  }, [redacted, matches, revealedMatches]);

  const handleSave = useCallback(async () => {
    if (!redacted) return;
    if (!window.pii?.saveRedacted) {
      setError('Save not available outside Electron');
      return;
    }
    try {
      const result = await window.pii.saveRedacted(redacted);
      if (!result.success && result.reason !== 'canceled') {
        setError(result.reason ?? 'Save failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }, [redacted]);

  const handleClear = useCallback(() => {
    setInput(''); 
    setRedacted(''); 
    setMatches([]);
    setScannedInput('');
    setDetectorMatches([]);
    setElapsedMs(undefined); 
    setLlmTokens(undefined); 
    setLlmElapsedMs(undefined);
    setError(null); 
    setRevealedMatches(new Set());
    setIsStale(false);
  }, []);

  const handleTokenToggle = useCallback((matchIndex: number) => {
    setRevealedMatches((prev) => {
      const next = new Set(prev);
      if (next.has(matchIndex)) next.delete(matchIndex);
      else next.add(matchIndex);
      return next;
    });
  }, []);

  const handleAddAllowlist = useCallback(() => {
    const candidate = allowlistInput.trim();
    if (!candidate) return;
    setAllowlist((current) => {
      if (current.some((e) => e.toLowerCase() === candidate.toLowerCase())) return current;
      return [...current, candidate];
    });
    setAllowlistInput('');
    setActiveMenu(null);
    setShowWordLists(true);
  }, [allowlistInput]);

  const handleAddBlacklist = useCallback(() => {
    const candidate = blacklistInput.trim();
    if (!candidate) return;
    setBlacklist((current) => {
      if (current.some((e) => e.term.toLowerCase() === candidate.toLowerCase())) return current;
      return [...current, { term: candidate, type: blacklistTypeInput }];
    });
    setBlacklistInput('');
    setActiveMenu(null);
    setShowWordLists(true);
  }, [blacklistInput, blacklistTypeInput]);

  const removeAllowlistTerm = useCallback((term: string) => {
    setAllowlist((current) => current.filter((e) => e !== term));
  }, []);

  const removeBlacklistTerm = useCallback((term: string) => {
    setBlacklist((current) => current.filter((e) => e.term !== term));
  }, []);

  const handleAllowlistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); handleAddAllowlist(); }
    },
    [handleAddAllowlist]
  );

  const handleBlacklistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); handleAddBlacklist(); }
    },
    [handleAddBlacklist]
  );

  const toggleReveal = useCallback((index: number) => {
    setRevealedMatches((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleScan();
      }
    },
    [handleScan]
  );

  const handleTextareaContextMenu = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const selected = textarea.value
        .slice(textarea.selectionStart, textarea.selectionEnd)
        .trim();
      if (!selected) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, text: selected, step: 'main' });
    },
    []
  );

  const addSelectedToBlacklist = useCallback((type: string) => {
    if (!contextMenu) return;
    const term = contextMenu.text;
    setBlacklist((current) => {
      if (current.some((e) => e.term.toLowerCase() === term.toLowerCase())) return current;
      return [...current, { term, type }];
    });
    setContextMenu(null);
    setShowWordLists(true);
  }, [contextMenu]);

  const addSelectedToAllowlist = useCallback(() => {
    if (!contextMenu) return;
    const term = contextMenu.text;
    setAllowlist((current) => {
      if (current.some((e) => e.toLowerCase() === term.toLowerCase())) return current;
      return [...current, term];
    });
    setContextMenu(null);
    setShowWordLists(true);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleLayerToggle = useCallback((name: string, enabled: boolean) => {
    void window.pii?.setLayer?.(name, enabled);
    if (scannedInput) setIsStale(true);
  }, [scannedInput]);

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const layerEntries = Object.entries(layerState).sort(([a], [b]) => a.localeCompare(b));


  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 2L4 5v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V5l-8-3z" fill="#7b9eff"/>
            <path d="M10 13l-2-2-1.4 1.4L10 15.8l6-6L14.6 8.4 10 13z" fill="#1a1a2e"/>
          </svg>
          Local PII Guard
        </div>
        <span className="app-header-sub">Local-first PII detection &amp; redaction</span>
      </header>
      <div className="toolbar">
        <button type="button" onClick={handleScan} disabled={isScanning}>
          {isScanning && <span className="spinner" aria-hidden />}
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>
        <button type="button" onClick={handleCopy} disabled={!redacted || isScanning} className={copied ? 'btn--copied' : ''}>
          {copied ? 'Copied ✓' : 'Copy Redacted'}
        </button>
        <button type="button" onClick={handleSave} disabled={!redacted || isScanning}>
          Save…
        </button>
        <button type="button" onClick={handleClear} disabled={isScanning}>
          Clear
        </button>
      </div>

      {nerStatus === 'starting' && (
        <div className="ner-banner ner-banner--starting">
          <span className="ner-banner-spinner" aria-hidden />
          NER models loading — first scan may be regex-only
        </div>
      )}
      {nerStatus === 'unavailable' && (
        <div className="ner-banner ner-banner--unavailable">
          ⚠ NER server unavailable — only regex detections will run
        </div>
      )}

      {activeMenu === 'allowlist' && (
        <div className="word-editor">
          <label>Add Allowlisted Term</label>
          <div className="word-editor-row">
            <input type="text" value={allowlistInput} onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={handleAllowlistKeyDown} placeholder="Allow a word or phrase..." spellCheck={false} autoFocus />
            <button type="button" onClick={handleAddAllowlist}>Add</button>
            <button type="button" onClick={() => { setActiveMenu(null); setAllowlistInput(''); }}>Close</button>
          </div>
        </div>
      )}

      {activeMenu === 'blacklist' && (
        <div className="word-editor">
          <label>Add Blacklisted Term</label>
          <div className="word-editor-row">
            <input
              type="text"
              value={blacklistInput}
              onChange={(e) => setBlacklistInput(e.target.value)}
              onKeyDown={handleBlacklistKeyDown}
              placeholder="Always redact a word or phrase..."
              spellCheck={false}
              autoFocus
            />
            <select
              value={blacklistTypeInput}
              onChange={(e) => setBlacklistTypeInput(e.target.value)}
              className="type-select"
            >
              {PII_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button type="button" onClick={handleAddBlacklist}>Add</button>
            <button type="button" onClick={() => { setActiveMenu(null); setBlacklistInput(''); }}>Close</button>
          </div>
        </div>
      )}

      <div className="word-lists-header">
        <button
          type="button"
          className="word-lists-toggle"
          onClick={() => setShowWordLists((v) => !v)}
          aria-expanded={showWordLists}
        >
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden
            style={{ transform: showWordLists ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
          >
            <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Word Lists
          {(allowlist.length > 0 || blacklist.length > 0) && (
            <span className="word-lists-count">
              {allowlist.length + blacklist.length}
            </span>
          )}
        </button>
        <div className="word-lists-actions">
          <button
            type="button"
            className="word-lists-add-btn"
            onClick={() => { setShowWordLists(true); setActiveMenu('allowlist'); }}
            title="Add allowlisted term"
          >
            + Allowlist
          </button>
          <button
            type="button"
            className="word-lists-add-btn word-lists-add-btn--block"
            onClick={() => { setShowWordLists(true); setActiveMenu('blacklist'); }}
            title="Add blocklisted term"
          >
            + Blocklist
          </button>
        </div>
      </div>

      {showWordLists && (
        <div className="list-panels">
          <div className="list-panel">
            <label>Allowlisted Terms</label>
            {allowlist.length > 0 ? (
              <div className="list-items">
                {allowlist.map((entry) => (
                  <span key={`allow-${entry}`}>
                    {entry}
                    <button type="button" onClick={() => removeAllowlistTerm(entry)} aria-label={`Remove ${entry}`}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="list-empty">No allowlisted terms.</div>
            )}
          </div>
          <div className="list-panel">
            <label>Blocklisted Terms</label>
            {blacklist.length > 0 ? (
              <div className="list-items">
                {blacklist.map((entry) => (
                  <span key={`block-${entry.term}`}>
                    {entry.term}
                    <em className="entry-type-badge">{entry.type}</em>
                    <button type="button" onClick={() => removeBlacklistTerm(entry.term)} aria-label={`Remove ${entry.term}`}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="list-empty">No blocklisted terms.</div>
            )}
          </div>
        </div>
      )}

      <div className="stats" role="status" aria-live="polite" aria-busy={isScanning}>
        {(scannedInput || isScanning) && (
          <>
            <strong>{isScanning ? '…' : matches.length}</strong> match
            {isScanning || matches.length !== 1 ? 'es' : ''} found
            {elapsedMs != null && !isScanning && (
              <span className="elapsed" style={{ marginLeft: 8, color: '#888', fontWeight: 'normal' }}>
                in {formatElapsed(elapsedMs)}
                {llmTokens != null && llmElapsedMs != null && llmTokens > 0 && (
                  <span style={{ marginLeft: 8 }}>
                    | {llmTokens.toLocaleString()} tok
                    {llmElapsedMs > 0 && <> | {formatTimePerToken(llmElapsedMs, llmTokens)}</>}
                  </span>
                )}
              </span>
            )}
            {detectedTypes.length > 0 && !isScanning && (
              <div className="detected-types">
                Detected:{' '}
                {detectedTypes.map((t) => <span key={t}>{t}</span>)}
              </div>
            )}
          </>
        )}
        <div className="layer-toggles">
          <span style={{ fontSize: 12, color: '#a0a0a0', marginRight: 8 }}>PII layers:</span>
          {layerEntries.map(([name, enabled]) => (
            <label key={name} className="layer-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => handleLayerToggle(name, e.target.checked)} />
              <span style={{ background: sourceColor(name), borderRadius: 3, padding: '1px 6px', color: '#111', opacity: enabled ? 1 : 0.4 }}>
                {name}
              </span>
            </label>
          ))}
        </div>
      </div>  {/* stats */}

      {error && (
        <div className="error-banner">
          <span className="error-banner-text">{error}</span>
          <button type="button" className="error-banner-dismiss" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
        </div>
      )}

      <div className="panes">
        <div className="pane pane--input">
          <label>
            Raw Input
            <span className="pane-hint">{SCAN_HINT} to scan</span>
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            onContextMenu={handleTextareaContextMenu}
            placeholder="Paste text containing PII here..."
            spellCheck={false}
            aria-label="Raw input text"
          />
        </div>
        <div className={`pane pane--output${isScanning ? ' pane--scanning' : ''}`}>
          <label>
            Redacted Output
            {revealedMatches.size > 0 && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#7b9eff', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                {revealedMatches.size} revealed
              </span>
            )}
            {isStale && (
              <span className="stale-badge">⚠ outdated</span>
            )}
          </label>
          <RedactedPanel
            redactedText={redacted}
            matches={matches}
            revealedMatches={revealedMatches}
            onToggle={handleTokenToggle}
            placeholder="Paste text and click Scan (or Ctrl+Enter)…"
          />
        </div>
      </div>


      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-label">"{contextMenu.text}"</div>
          {contextMenu.step === 'main' ? (
            <>
              <button
                type="button"
                onClick={() => setContextMenu((c) => c && { ...c, step: 'blacklist-type', showAll: false })}
              >
                Add to Blocklist →
              </button>
              <button type="button" onClick={addSelectedToAllowlist}>Add to Allowlist</button>
              <button type="button" onClick={() => setContextMenu(null)}>Cancel</button>
            </>
          ) : (
            <>
              <div className="context-menu-section">Pick type:</div>
              <div className="context-menu-types">
                {COMMON_PII_TYPES.map((t) => (
                  <button key={t} type="button" onClick={() => addSelectedToBlacklist(t)}>
                    {t}
                  </button>
                ))}
                {!contextMenu.showAll && PII_TYPES.filter((t) => !COMMON_PII_TYPES.includes(t)).length > 0 && (
                  <button
                    type="button"
                    className="context-menu-more"
                    onClick={(e) => { e.stopPropagation(); setContextMenu((c) => c && { ...c, showAll: true }); }}
                  >
                    More…
                  </button>
                )}
                {contextMenu.showAll && PII_TYPES.filter((t) => !COMMON_PII_TYPES.includes(t)).map((t) => (
                  <button key={t} type="button" onClick={() => addSelectedToBlacklist(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="context-menu-back"
                onClick={() => setContextMenu((c) => c && { ...c, step: 'main' })}
              >
                ← Back
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;