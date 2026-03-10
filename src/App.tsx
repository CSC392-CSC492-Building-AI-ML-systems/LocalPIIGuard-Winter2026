import { useState, useCallback, useEffect } from 'react';

interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
  source: string;
}

const SOURCE_COLORS: Record<string, string> = {
  Regex: '#fde68a',
  'Ner (Spacy)': '#a5f3fc',
  LLM: '#e9d5ff',
  Manual: '#fecaca',
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

function buildHighlightedPreview(text: string, matches: Match[]): React.ReactNode[] {
  if (!text || matches.length === 0) {
    return [escapeHtml(text || '')];
  }

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const nodes: React.ReactNode[] = [];
  let lastEnd = 0;

  for (const m of sorted) {
    if (m.start > lastEnd) {
      nodes.push(escapeHtml(text.slice(lastEnd, m.start)));
    }
    const color = sourceColor(m.source);
    nodes.push(
      <mark
        key={`${m.start}-${m.end}`}
        style={{ background: color, borderRadius: 3, padding: '0 2px' }}
        title={`${m.type} | ${m.source}`}
      >
        {escapeHtml(m.value)}
      </mark>
    );
    lastEnd = m.end;
  }

  if (lastEnd < text.length) {
    nodes.push(escapeHtml(text.slice(lastEnd)));
  }

  return nodes;
}

function buildRedactedPreview(
  text: string,
  matches: Match[],
  revealedIndices: Set<number>,
  onToggle: (index: number) => void
): React.ReactNode[] {
  if (!text || matches.length === 0) return [text || ''];

  const sorted = matches
    .map((m, i) => ({ ...m, originalIndex: i }))
    .sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let lastEnd = 0;

  for (const m of sorted) {
    if (m.start > lastEnd) {
      nodes.push(text.slice(lastEnd, m.start));
    }

    const revealed = revealedIndices.has(m.originalIndex);
    if (revealed) {
      nodes.push(
        <span
          key={`${m.originalIndex}-revealed`}
          className="redacted-revealed"
          onClick={() => onToggle(m.originalIndex)}
          title={`${m.type} | ${m.source} — click to re-redact`}
        >
          {m.value}
        </span>
      );
    } else {
      nodes.push(
        <span
          key={`${m.originalIndex}-tag`}
          className="redacted-tag"
          onClick={() => onToggle(m.originalIndex)}
          title={`${m.type} | ${m.source} — click to reveal`}
        >
          [{m.type}]
        </span>
      );
    }

    lastEnd = m.end;
  }

  if (lastEnd < text.length) {
    nodes.push(text.slice(lastEnd));
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

function App() {
  const [input, setInput] = useState('');
  const [redacted, setRedacted] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [revealedMatches, setRevealedMatches] = useState<Set<number>>(new Set());
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);
  const [llmTokens, setLlmTokens] = useState<number | undefined>(undefined);
  const [llmElapsedMs, setLlmElapsedMs] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const [activeMenu, setActiveMenu] = useState<WordListMenu>(null);
  const [allowlistInput, setAllowlistInput] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>(() => loadTermList(ALLOWLIST_STORAGE_KEY));
  const [blacklist, setBlacklist] = useState<string[]>(() => loadTermList(BLACKLIST_STORAGE_KEY));
  const [layerState, setLayerState] = useState<LayerState>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(ALLOWLIST_STORAGE_KEY, JSON.stringify(allowlist));
    } catch {
      return;
    }
  }, [allowlist]);

  useEffect(() => {
    try {
      window.localStorage.setItem(BLACKLIST_STORAGE_KEY, JSON.stringify(blacklist));
    } catch {
      return;
    }
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
      ) {
        return;
      }

      try {
        const current = await window.pii.getLayerState();
        setLayerState(current);
      } catch {
        return;
      }

      cleanupLayers = window.pii.onLayerState((state) => {
        setLayerState(state);
      });

      cleanupWordLists = window.pii.onWordLists((lists) => {
        setAllowlist((current) =>
          listsEqual(current, lists.allowlist) ? current : lists.allowlist
        );
        setBlacklist((current) =>
          listsEqual(current, lists.blacklist) ? current : lists.blacklist
        );
      });

      cleanupOpenEditor = window.pii.onOpenWordListEditor((menu) => {
        setActiveMenu(menu);
      });
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
    if (!window.pii?.scanText) {
      setError('Electron API not available');
      return;
    }
    setIsScanning(true);
    try {
      const result = await window.pii.scanText({
        text: input,
        allowlist,
        blacklist,
      });
      setRedacted(result.redactedText);
      setMatches(result.matches);
      setRevealedMatches(new Set());
      setElapsedMs(result.elapsedMs);
      setLlmTokens(result.llmTokens);
      setLlmElapsedMs(result.llmElapsedMs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, [allowlist, blacklist, input]);

  const handleCopy = useCallback(async () => {
    if (!redacted) return;
    if (!window.pii?.copyToClipboard) {
      try {
        await navigator.clipboard.writeText(redacted);
      } catch {
        setError('Clipboard not available');
      }
      return;
    }

    try {
      await window.pii.copyToClipboard(redacted);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copy failed');
    }
  }, [redacted]);

  const handleClear = useCallback(() => {
    setInput('');
    setRedacted('');
    setMatches([]);
    setElapsedMs(undefined);
    setLlmTokens(undefined);
    setLlmElapsedMs(undefined);
    setError(null);
  }, []);

  const addTerm = useCallback(
    (
      value: string,
      setValue: (next: string) => void,
      setList: React.Dispatch<React.SetStateAction<string[]>>
    ) => {
      const candidate = value.trim();
      if (!candidate) return;

      setList((current) => {
        if (current.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
          return current;
        }
        return [...current, candidate];
      });

      setValue('');
      setActiveMenu(null);
    },
    []
  );

  const handleAddAllowlist = useCallback(() => {
    addTerm(allowlistInput, setAllowlistInput, setAllowlist);
  }, [addTerm, allowlistInput]);

  const handleAddBlacklist = useCallback(() => {
    addTerm(blacklistInput, setBlacklistInput, setBlacklist);
  }, [addTerm, blacklistInput]);

  const removeTerm = useCallback(
    (entry: string, setList: React.Dispatch<React.SetStateAction<string[]>>) => {
      setList((current) => current.filter((item) => item !== entry));
    },
    []
  );

  const handleAllowlistKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      handleAddAllowlist();
    },
    [handleAddAllowlist]
  );

  const handleBlacklistKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      handleAddBlacklist();
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

  const handleTextareaContextMenu = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const selected = textarea.value
        .slice(textarea.selectionStart, textarea.selectionEnd)
        .trim();
      if (!selected) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, text: selected });
    },
    []
  );

  const addSelectedToBlacklist = useCallback(() => {
    if (!contextMenu) return;
    const term = contextMenu.text;
    setBlacklist((current) => {
      if (current.some((e) => e.toLowerCase() === term.toLowerCase())) return current;
      return [...current, term];
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
    void window.pii?.setLayer?.(name, enabled);
  }, []);

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const previewNodes = buildHighlightedPreview(input, matches);
  const redactedPreviewNodes = buildRedactedPreview(input, matches, revealedMatches, toggleReveal);
  const layerEntries = Object.entries(layerState).sort(([a], [b]) =>
    a.localeCompare(b)
  );

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
            <input
              type="text"
              value={allowlistInput}
              onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={handleAllowlistKeyDown}
              placeholder="Allow a word or phrase..."
              spellCheck={false}
            />
            <button type="button" onClick={handleAddAllowlist}>
              Add
            </button>
            <button type="button" onClick={() => setActiveMenu(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {activeMenu === 'blacklist' && (
        <div className="word-editor">
          <label>Add Blacklisted Word</label>
          <div className="word-editor-row">
            <input
              type="text"
              value={blacklistInput}
              onChange={(e) => setBlacklistInput(e.target.value)}
              onKeyDown={handleBlacklistKeyDown}
              placeholder="Always redact a word or phrase..."
              spellCheck={false}
            />
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
                  <button type="button" onClick={() => removeTerm(entry, setAllowlist)}>
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
                <span key={`block-${entry}`}>
                  {entry}
                  <button type="button" onClick={() => removeTerm(entry, setBlacklist)}>
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
            {detectedTypes.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        )}
        <div className="layer-toggles">
          <span style={{ fontSize: 12, color: '#a0a0a0', marginRight: 8 }}>PII layers:</span>
          {layerEntries.map(([name, enabled]) => (
            <label key={name} className="layer-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => handleLayerToggle(name, e.target.checked)}
              />
              <span
                style={{
                  background: sourceColor(name),
                  borderRadius: 3,
                  padding: '1px 6px',
                  color: '#111',
                  opacity: enabled ? 1 : 0.4,
                }}
              >
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
          <label>Redacted Output</label>
          {matches.length > 0 ? (
            <div
              className="redacted-preview"
              onContextMenu={(e) => {
                const selected = window.getSelection()?.toString().trim() ?? '';
                if (!selected) return;
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, text: selected });
              }}
            >
              {redactedPreviewNodes}
            </div>
          ) : (
            <textarea
              value={redacted}
              readOnly
              onContextMenu={handleTextareaContextMenu}
              placeholder="Click Scan to see redacted text..."
              spellCheck={false}
            />
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-label">"{contextMenu.text}"</div>
          <button type="button" onClick={addSelectedToBlacklist}>Add to Blacklist</button>
          <button type="button" onClick={addSelectedToAllowlist}>Add to Whitelist</button>
          <button type="button" onClick={() => setContextMenu(null)}>Cancel</button>
        </div>
      )}

      <div className="preview-section">
        <label
          style={{
            fontSize: 12,
            color: '#a0a0a0',
            marginBottom: 4,
            display: 'block',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
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
