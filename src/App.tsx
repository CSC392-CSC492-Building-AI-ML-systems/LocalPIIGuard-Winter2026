import { useState, useCallback } from 'react';

interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
}

interface ScanResult {
  redactedText: string;
  matches: Match[];
}

declare global {
  interface Window {
    pii?: {
      scanText: (text: string) => Promise<ScanResult>;
      copyToClipboard: (text: string) => Promise<void>;
    };
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    nodes.push(<mark key={`${m.start}-${m.end}`}>{escapeHtml(m.value)}</mark>);
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
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    setError(null);
    if (!window.pii?.scanText) {
      setError('Electron API not available');
      return;
    }
    try {
      const result = await window.pii.scanText(input);
      setRedacted(result.redactedText);
      setMatches(result.matches);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
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
    setError(null);
  }, []);

  const detectedTypes = [...new Set(matches.map((m) => m.type))];
  const previewNodes = buildHighlightedPreview(input, matches);

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={handleScan}>
          Scan
        </button>
        <button type="button" onClick={handleCopy} disabled={!redacted}>
          Copy Redacted
        </button>
        <button type="button" onClick={handleClear}>
          Clear
        </button>
      </div>

      <div className="stats">
        <strong>{matches.length}</strong> match{matches.length !== 1 ? 'es' : ''} found
        {detectedTypes.length > 0 && (
          <div className="detected-types">
            Detected: {detectedTypes.map((t) => <span key={t}>{t}</span>)}
          </div>
        )}
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
