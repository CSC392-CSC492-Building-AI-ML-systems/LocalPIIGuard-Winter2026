import { useState, useCallback, useEffect } from 'react';


interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
  source: string;
}

const SOURCE_COLORS: Record<string, string> = {
  Regex:           '#fde68a', // amber
  'Ner (Spacy)':   '#a5f3fc', // cyan
  GLiNER:          '#bbf7d0', // green
  LLM:             '#e9d5ff', // purple
};

const DEFAULT_SOURCE_COLOR = '#fed7aa'; // orange fallback

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

declare global {
    interface Window {
    pii?: {
      scanText: (text: string) => Promise<ScanResult>;
      copyToClipboard: (text: string) => Promise<void>;
      getLayerState: () => Promise<LayerState>;
      setLayer: (name: string, enabled: boolean) => Promise<void>;
      onLayerState: (handler: (state: LayerState) => void) => () => void;
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
  const tokPerS = (llmTokens / (llmElapsedMs / 1000));
  if (msPerTok >= 1) {
    return `${msPerTok.toFixed(1)} ms/tok · ${tokPerS.toFixed(1)} tok/s`;
  }
  return `${(msPerTok * 1000).toFixed(0)} µs/tok · ${tokPerS.toFixed(0)} tok/s`;
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
        title={`${m.type} · ${m.source}`}
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

function App() {
  const [input, setInput] = useState('');
  const [redacted, setRedacted] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);
  const [llmTokens, setLlmTokens] = useState<number | undefined>(undefined);
  const [llmElapsedMs, setLlmElapsedMs] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [layerState, setLayerState] = useState<LayerState>({});
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const init = async () => {
      if (!window.pii?.getLayerState || !window.pii?.onLayerState) return;
      try {
        const current = await window.pii.getLayerState();
        setLayerState(current);
      } catch {
        return;
      }

      cleanup = window.pii.onLayerState((state) => {
        setLayerState(state);
      });
    };

    init();

    return () => {
      if (cleanup) cleanup();
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
      const result = await window.pii.scanText(input);
      setRedacted(result.redactedText);
      setMatches(result.matches);
      setElapsedMs(result.elapsedMs);
      setLlmTokens(result.llmTokens);
      setLlmElapsedMs(result.llmElapsedMs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, [input]);

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

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const previewNodes = buildHighlightedPreview(input, matches);
  const layerEntries = Object.entries(layerState).sort(([a], [b]) => a.localeCompare(b));

  const handleLayerToggle = useCallback((name: string, enabled: boolean) => {
    window.pii?.setLayer?.(name, enabled);
  }, []);

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={handleScan} disabled={isScanning}>
          {isScanning && <span className="spinner" aria-hidden />}
          {isScanning ? 'Scanning…' : 'Scan'}
        </button>
        <button type="button" onClick={handleCopy} disabled={!redacted || isScanning}>
          Copy Redacted
        </button>
        <button type="button" onClick={handleClear} disabled={isScanning}>
          Clear
        </button>
      </div>

      <div className="stats" role="status" aria-live="polite" aria-busy={isScanning}>
        <strong>{isScanning ? '—' : matches.length}</strong> match{isScanning || matches.length !== 1 ? 'es' : ''} found
        {elapsedMs != null && !isScanning && (
          <span className="elapsed" style={{ marginLeft: 8, color: '#888', fontWeight: 'normal' }}>
            in {formatElapsed(elapsedMs)}
            {llmTokens != null && llmElapsedMs != null && llmTokens > 0 && (
              <span style={{ marginLeft: 8 }}>
                · {llmTokens.toLocaleString()} tok
                {llmElapsedMs > 0 && (
                  <> · {formatTimePerToken(llmElapsedMs, llmTokens)}</>
                )}
              </span>
            )}
          </span>
        )}
        {detectedTypes.length > 0 && !isScanning && (
          <div className="detected-types">
            Detected: {detectedTypes.map((t) => <span key={t}>{t}</span>) }
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

      {error && (
        <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>
      )}

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
          <label>Redacted Output</label>
          <textarea
            value={redacted}
            readOnly
            placeholder="Click Scan to see redacted text..."
            spellCheck={false}
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
