import { useState, useCallback, useEffect, useRef } from 'react';

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
type WordListMenu = 'whitelist' | 'blacklist' | null;

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
      nodes.push(
        <mark
          key={nodeKey++}
          style={{ background: color, borderRadius: 3, padding: '0 2px' }}
          title={`${m.type} | ${m.source}`}
        >
          {text.slice(m.start, m.end)}
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
  revealedSet: Set<number>;
  onToggle: (matchIndex: number) => void;
  placeholder: string;
}

/**
 * Parses the redacted text and injects interactive chips for each redacted span.
 * Strategy: walk the original `matches` sorted by start offset; for each match
 * find the corresponding placeholder in `redactedText` and replace with a chip.
 */
function RedactedPanel({ redactedText, matches, revealedSet, onToggle, placeholder }: RedactedPanelProps) {
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
          isRevealed={revealedSet.has(idx)}
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
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);
  const [llmTokens, setLlmTokens] = useState<number | undefined>(undefined);
  const [llmElapsedMs, setLlmElapsedMs] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // track which match indices have been revealed
  const [revealedSet, setRevealedSet] = useState<Set<number>>(new Set());

  const [activeMenu, setActiveMenu] = useState<WordListMenu>(null);
  const [allowlistInput, setAllowlistInput] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>(() => loadTermList(ALLOWLIST_STORAGE_KEY));
  const [blacklist, setBlacklist] = useState<string[]>(() => loadTermList(BLACKLIST_STORAGE_KEY));
  const [layerState, setLayerState] = useState<LayerState>({});

  useEffect(() => {
    try { window.localStorage.setItem(ALLOWLIST_STORAGE_KEY, JSON.stringify(allowlist)); } catch { return; }
  }, [allowlist]);

  useEffect(() => {
    try { window.localStorage.setItem(BLACKLIST_STORAGE_KEY, JSON.stringify(blacklist)); } catch { return; }
  }, [blacklist]);

  useEffect(() => {
    if (!window.pii?.syncWordLists) return;
    void window.pii.syncWordLists({ allowlist, blacklist });
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
        setAllowlist((current) => listsEqual(current, lists.allowlist) ? current : lists.allowlist);
        setBlacklist((current) => listsEqual(current, lists.blacklist) ? current : lists.blacklist);
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

  const handleScan = useCallback(async () => {
    setError(null);
    if (!window.pii?.scanText) { setError('Electron API not available'); return; }
    setIsScanning(true);
    try {
      const result = await window.pii.scanText({ text: input, allowlist, blacklist });
      // console.log('[PII scan] redactedText:', JSON.stringify(result.redactedText));
      // console.log('[PII scan] all matches:', result.matches);
      setRedacted(result.redactedText);
      setMatches(result.matches);
      setElapsedMs(result.elapsedMs);
      setLlmTokens(result.llmTokens);
      setLlmElapsedMs(result.llmElapsedMs);
      setRevealedSet(new Set()); // reset reveals on new scan
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
    if (revealedSet.size > 0) {
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
        if (correspondingMatch && revealedSet.has(correspondingMatch.origIdx)) {
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

    if (!window.pii?.copyToClipboard) {
      try { await navigator.clipboard.writeText(visibleText); } catch { setError('Clipboard not available'); }
      return;
    }
    try { await window.pii.copyToClipboard(visibleText); } catch (e) {
      setError(e instanceof Error ? e.message : 'Copy failed');
    }
  }, [redacted, matches, revealedSet]);

  const handleClear = useCallback(() => {
    setInput(''); setRedacted(''); setMatches([]);
    setElapsedMs(undefined); setLlmTokens(undefined); setLlmElapsedMs(undefined);
    setError(null); setRevealedSet(new Set());
  }, []);

  const handleTokenToggle = useCallback((matchIndex: number) => {
    setRevealedSet((prev) => {
      const next = new Set(prev);
      if (next.has(matchIndex)) next.delete(matchIndex);
      else next.add(matchIndex);
      return next;
    });
  }, []);

  const addTerm = useCallback(
    (value: string, setValue: (next: string) => void, setList: React.Dispatch<React.SetStateAction<string[]>>) => {
      const candidate = value.trim();
      if (!candidate) return;
      setList((current) => {
        if (current.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) return current;
        return [...current, candidate];
      });
      setValue('');
      setActiveMenu(null);
    }, []
  );

  const handleAddAllowlist = useCallback(() => addTerm(allowlistInput, setAllowlistInput, setAllowlist), [addTerm, allowlistInput]);
  const handleAddBlacklist = useCallback(() => addTerm(blacklistInput, setBlacklistInput, setBlacklist), [addTerm, blacklistInput]);

  const removeTerm = useCallback((entry: string, setList: React.Dispatch<React.SetStateAction<string[]>>) => {
    setList((current) => current.filter((item) => item !== entry));
  }, []);

  const handleAllowlistKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); handleAddAllowlist();
  }, [handleAddAllowlist]);

  const handleBlacklistKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); handleAddBlacklist();
  }, [handleAddBlacklist]);

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const previewNodes = buildHighlightedPreview(input, matches);
  const layerEntries = Object.entries(layerState).sort(([a], [b]) => a.localeCompare(b));

  const handleLayerToggle = useCallback((name: string, enabled: boolean) => {
    void window.pii?.setLayer?.(name, enabled);
  }, []);

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={handleScan} disabled={isScanning}>
          {isScanning && <span className="spinner" aria-hidden />}
          {isScanning ? 'Scanning...' : 'Scan'}
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
                  <button type="button" onClick={() => removeTerm(entry, setAllowlist)}>Remove</button>
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
                <span key={`block-${entry}`}>
                  {entry}
                  <button type="button" onClick={() => removeTerm(entry, setBlacklist)}>Remove</button>
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
          {layerEntries.map(([name, enabled]) => (
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
            placeholder="Paste text containing PII here..."
            spellCheck={false}
          />
        </div>
        <div className="pane">
          <label>
            Redacted Output
            {revealedSet.size > 0 && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#7b9eff', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                {revealedSet.size} revealed
              </span>
            )}
          </label>
          <RedactedPanel
            redactedText={redacted}
            matches={matches}
            revealedSet={revealedSet}
            onToggle={handleTokenToggle}
            placeholder="Click Scan to see redacted text..."
          />
        </div>
      </div>

      <div className="preview-section">
        <label style={{ fontSize: 12, color: '#a0a0a0', marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Inline Preview (matches highlighted)
        </label>
        <div className={`preview ${!input ? 'preview-empty' : ''}`}>
          {input ? previewNodes : 'No input yet. Paste text and click Scan.'}
        </div>
      </div>
    </div>
  );
}

export default App;