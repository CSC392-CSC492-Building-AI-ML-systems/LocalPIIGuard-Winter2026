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

type LayerState = Record<string, boolean>;
type WordListMenu = 'whitelist' | 'blacklist' | null;

interface BlacklistEntry {
  term: string;
  type: string;
}

const PII_TYPES = Object.values(PiiType);

const ALLOWLIST_STORAGE_KEY = 'pii-allowlist';
const BLACKLIST_STORAGE_KEY = 'pii-blacklist';

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

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

interface RedactedPanelProps {
  redactedText: string;
  matches: Match[];
  revealedMatches: Set<number>;
  onToggle: (matchIndex: number) => void;
  placeholder: string;
}

function RedactedPanel({ redactedText, matches, revealedMatches, onToggle, placeholder }: RedactedPanelProps) {
  if (!redactedText) {
    return (
      <div className="redacted-output-panel redacted-output-panel--empty">
        {placeholder}
      </div>
    );
  }

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

  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let matchCursor = 0;
  let segKey = 0; // monotonically increasing key — never duplicates
  let placeholderMatch: RegExpExecArray | null;

  const PLACEHOLDER_RE = /(\[[\w:/.-]+\]|<[\w:/.-]+>|█+|\*{3,})/g;

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

  return (
    <div className="redacted-output-panel">
      <pre className="redacted-pre">{segments}</pre>
    </div>
  );
}

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

  const [activeMenu, setActiveMenu] = useState<WordListMenu>(null);
  const [allowlistInput, setAllowlistInput] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [blacklistTypeInput, setBlacklistTypeInput] = useState('BLACKLIST');
  const [allowlist, setAllowlist] = useState<string[]>(() => loadTermList(ALLOWLIST_STORAGE_KEY));
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>(() => loadBlacklist());
  const [layerState, setLayerState] = useState<LayerState>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string; step: 'main' | 'blacklist-type' } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(ALLOWLIST_STORAGE_KEY, JSON.stringify(allowlist)); } catch { return; }
  }, [allowlist]);

  useEffect(() => {
    try { window.localStorage.setItem(BLACKLIST_STORAGE_KEY, JSON.stringify(blacklist)); } catch { return; }
  }, [blacklist]);

  useEffect(() => {
    const init = async () => {
      try {
        const current = await apiJson<LayerState>('/api/layers');
        setLayerState(current);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load PII layer state');
      }
    };
    void init();
  }, []);

  useEffect(() => {
    if (!scannedInput) return;
    const newBlacklistMatches = computeBlacklistMatches(scannedInput, blacklist, allowlist);
    const merged = mergeMatches(detectorMatches, newBlacklistMatches);
    setMatches(merged);
    setRedacted(buildRedactedString(scannedInput, merged));
    setRevealedMatches(new Set());
  }, [blacklist, scannedInput, detectorMatches, allowlist]);

  const handleScan = useCallback(async () => {
    setError(null);
    setIsScanning(true);
    const controller = new AbortController();
    const timeoutMs = layerState['LLM'] ? 5 * 60_000 : 30_000;
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      console.log('[ui] scan start', { inputLen: input.length });
      const result = await apiJson<ScanResult>('/api/scan', {
        method: 'POST',
        body: JSON.stringify({
          text: input,
          allowlist,
          blacklist: blacklist.map((e) => e.term),
        }),
        signal: controller.signal,
      });
      console.log('[ui] scan response', { redactedLen: result.redactedText?.length ?? 0, matches: result.matches?.length ?? 0 });
      setRedacted(result.redactedText);
      setMatches(result.matches);
      setRevealedMatches(new Set());
      setScannedInput(input);
      setDetectorMatches(result.matches.filter((m) => m.source !== 'Manual'));
      setElapsedMs(result.elapsedMs);
      setLlmTokens(result.llmTokens);
      setLlmElapsedMs(result.llmElapsedMs);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('Scan timed out');
      } else {
        setError(e instanceof Error ? e.message : 'Scan failed');
      }
    } finally {
      window.clearTimeout(timeoutId);
      controller.abort();
      setIsScanning(false);
      console.log('[ui] scan finally');
    }
  }, [allowlist, blacklist, input, layerState]);

  const handleCopy = useCallback(async () => {
    if (!redacted) return;

    let visibleText = redacted;
    if (revealedMatches.size > 0) {
      const deduped: (Match & { origIdx: number })[] = [];
      [...matches]
        .map((m, i) => ({ ...m, origIdx: i }))
        .sort((a, b) => a.start - b.start || b.end - a.end)
        .forEach((m) => {
          if (deduped.some((e) => e.start === m.start && e.end === m.end)) return;
          deduped.push(m);
        });

      let result = '';
      let lastIndex = 0;
      let matchCursor = 0;
      const PLACEHOLDER_RE = /(\[[\w:/.-]+\]|<[\w:/.-]+>|█+|\*{3,})/g;
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

    try { await navigator.clipboard.writeText(visibleText); } catch { setError('Clipboard not available'); }
  }, [redacted, matches, revealedMatches]);

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
  }, [contextMenu]);

  const addSelectedToAllowlist = useCallback(() => {
    if (!contextMenu) return;
    const term = contextMenu.text;
    setAllowlist((current) => {
      if (current.some((e) => e.toLowerCase() === term.toLowerCase())) return current;
      return [...current, term];
    });
    setContextMenu(null);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleLayerToggle = useCallback((name: string, enabled: boolean) => {
    setLayerState((current) => ({ ...current, [name]: enabled }));
    void apiJson<LayerState>('/api/layers/set', {
      method: 'POST',
      body: JSON.stringify({ name, enabled }),
    }).then((next) => setLayerState(next)).catch(() => {
      return;
    });
  }, []);

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const layerEntries = (Object.entries(layerState) as Array<[string, boolean]>).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={handleScan} disabled={isScanning}>
          {isScanning && <span className="spinner" aria-hidden />}
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>
        <button type="button" onClick={() => setActiveMenu('whitelist')} disabled={isScanning}>
          Whitelist
        </button>
        <button type="button" onClick={() => setActiveMenu('blacklist')} disabled={isScanning}>
          Blacklist
        </button>
        <button type="button" onClick={handleCopy} disabled={!redacted || isScanning}>
          Copy Redacted
        </button>
        <button type="button" onClick={handleClear} disabled={isScanning}>
          Clear
        </button>
      </div>

      {activeMenu === 'whitelist' && (
        <div className="word-editor">
          <label>Add Whitelisted Word</label>
          <div className="word-editor-row">
            <input type="text" value={allowlistInput} onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={handleAllowlistKeyDown} placeholder="Allow a word or phrase..." spellCheck={false} />
            <button type="button" onClick={handleAddAllowlist}>Add</button>
            <button type="button" onClick={() => setActiveMenu(null)}>Close</button>
          </div>
        </div>
      )}

      {activeMenu === 'blacklist' && (
        <div className="word-editor">
          <label>Add Blacklisted Word</label>
          <div className="word-editor-row">
            <input type="text" value={blacklistInput} onChange={(e) => setBlacklistInput(e.target.value)}
              onKeyDown={handleBlacklistKeyDown} placeholder="Always redact a word or phrase..." spellCheck={false} />
            <button type="button" onClick={handleAddBlacklist}>Add</button>
            <button type="button" onClick={() => setActiveMenu(null)}>Close</button>
            <input
              type="text"
              value={blacklistInput}
              onChange={(e) => setBlacklistInput(e.target.value)}
              onKeyDown={handleBlacklistKeyDown}
              placeholder="Always redact a word or phrase..."
              spellCheck={false}
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
            <button type="button" onClick={handleAddBlacklist}>
              Add
            </button>
            <button type="button" onClick={() => setActiveMenu(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="list-panels">
        <div className="list-panel">
          <label>Whitelisted Words</label>
          {allowlist.length > 0 ? (
            <div className="list-items">
              {allowlist.map((entry) => (
                <span key={`allow-${entry}`}>
                  {entry}
                  <button type="button" onClick={() => removeAllowlistTerm(entry)}>
                    Remove
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="list-empty">No whitelisted words added.</div>
          )}
        </div>
        <div className="list-panel">
          <label>Blacklisted Words</label>
          {blacklist.length > 0 ? (
            <div className="list-items">
              {blacklist.map((entry) => (
                <span key={`block-${entry.term}`}>
                  {entry.term}
                  <em className="entry-type-badge">{entry.type}</em>
                  <button type="button" onClick={() => removeBlacklistTerm(entry.term)}>
                    Remove
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="list-empty">No blacklisted words added.</div>
          )}
        </div>
      </div>

      <div className="stats" role="status" aria-live="polite" aria-busy={isScanning}>
        <strong>{isScanning ? '-' : matches.length}</strong> match
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
        <div className="layer-toggles">
          <span style={{ fontSize: 12, color: '#a0a0a0', marginRight: 8 }}>PII layers:</span>
          {layerEntries.length === 0 ? (
            <span style={{ fontSize: 12, color: '#a0a0a0' }}>Unavailable (backend not connected)</span>
          ) : layerEntries.map(([name, enabled]) => (
            <label key={name} className="layer-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => handleLayerToggle(name, e.target.checked)} />
              <span style={{ background: sourceColor(name), borderRadius: 3, padding: '1px 6px', color: '#111', opacity: enabled ? 1 : 0.4 }}>
                {name}
              </span>
            </label>
          ))}
        </div>
      </div>

      {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

      <div className="panes">
        <div className="pane">
          <label>Raw Input</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onContextMenu={handleTextareaContextMenu}
            placeholder="Paste text containing PII here..."
            spellCheck={false}
          />
        </div>
        <div className="pane">
          <label>
            Redacted Output
            {revealedMatches.size > 0 && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#7b9eff', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                {revealedMatches.size} revealed
              </span>
            )}
          </label>
          <RedactedPanel
            redactedText={redacted}
            matches={matches}
            revealedMatches={revealedMatches}
            onToggle={handleTokenToggle}
            placeholder="Click Scan to see redacted text..."
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
                onClick={() => setContextMenu((c) => c && { ...c, step: 'blacklist-type' })}
              >
                Add to Blacklist →
              </button>
              <button type="button" onClick={addSelectedToAllowlist}>Add to Whitelist</button>
              <button type="button" onClick={() => setContextMenu(null)}>Cancel</button>
            </>
          ) : (
            <>
              <div className="context-menu-section">Pick type:</div>
              <div className="context-menu-types">
                {PII_TYPES.map((t) => (
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