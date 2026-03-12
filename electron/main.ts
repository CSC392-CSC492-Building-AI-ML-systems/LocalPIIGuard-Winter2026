import { app, BrowserWindow, ipcMain, clipboard, Menu } from 'electron';
import path from 'path';
import { maskText, reconstructMatches } from '../shared/scanner';
import type { PiiType } from '../shared/types';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

import { RegexDetector } from '../shared/regex-detector'
import { NerDetector } from '../shared/ner-detector';
import { LlamaDetector } from '../shared/llm-detector';
const piiDetector = [
  new RegexDetector(),
  new NerDetector(),
  new LlamaDetector(),
]

type LayerState = Record<string, boolean>;
const layerState: LayerState = Object.fromEntries(
  piiDetector.map(detector => [detector.getName(), true])
);

let mainWindow: BrowserWindow | null = null;

function notifyLayerState(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send('pii:layers', { ...layerState });
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { role: 'editMenu' }, // Cut, Copy, Paste, Select All — required for text inputs
    {
      label: 'PII Layers',
      submenu: piiDetector.map(detector => ({
        label: detector.getName(), // Capitalize
        type: 'checkbox',
        checked: layerState[detector.getName()],
        click: (item) => {
          layerState[detector.getName()] = item.checked;
          notifyLayerState();
        },
      })),
    },
    { role: 'windowMenu' },
    { role: 'help' },
  ]);

  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Local PII Guard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs access to require
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

// IPC handlers
ipcMain.handle('pii:scan', async (_event, text: string) => {
  const input = text ?? '';
  const activeDetectors = piiDetector.filter(detector => layerState[detector.getName()]);
  const startMs = Date.now();
  console.log('[PII scan] start', { inputLen: input.length, active: activeDetectors.map(d => d.getName()) });
  if (PII_DEBUG) {
    console.log('[PII scan] input length:', input.length, 'active layers:', activeDetectors.map(d => d.getName()));
  }

  // Pipeline: run detectors sequentially, each on the masked output of the previous
  let currentText = input;
  const allDetections: Array<{ value: string; source: string; type: PiiType; confidence?: number }> = [];

  for (const detector of activeDetectors) {
    const matches = await detector.collectMatches(currentText);
    if (PII_DEBUG) {
      console.log('[PII scan]', detector.getName(), 'matches:', matches.length, matches.slice(0, 3));
    }
    for (const m of matches) {
      allDetections.push({ value: m.value, source: m.source, type: m.type, confidence: m.confidence });
    }
    currentText = maskText(currentText, matches);
  }

  if (PII_DEBUG) {
    console.log('[PII scan] total detections:', allDetections.length);
  }

  const finalMatches = reconstructMatches(input, allDetections);
  const result = { redactedText: currentText, matches: finalMatches };
  const elapsedMs = Date.now() - startMs;
  const llama = activeDetectors.find((d) => d.getName() === 'LLM');
  const llmTokens = llama && 'getLastEvalCount' in llama ? (llama as LlamaDetector).getLastEvalCount() : undefined;
  const llmElapsedMs = llama && 'getLastElapsedMs' in llama ? (llama as LlamaDetector).getLastElapsedMs() : undefined;
  if (PII_DEBUG) {
    console.log('[PII scan] redacted length:', result.redactedText.length, 'preview:', result.redactedText.slice(0, 120), 'elapsedMs:', elapsedMs, 'llmTokens:', llmTokens, 'llmElapsedMs:', llmElapsedMs);
  }
  return { ...result, elapsedMs, llmTokens, llmElapsedMs };
});

ipcMain.handle('pii:copy', (_event, text: string) => {
  clipboard.writeText(text ?? '');
});

ipcMain.handle('pii:get-layers', () => ({ ...layerState }));

ipcMain.handle('pii:set-layer', (_event, name: string, enabled: boolean) => {
  if (typeof name !== 'string' || typeof enabled !== 'boolean') return;
  if (name in layerState) {
    layerState[name] = enabled;
    notifyLayerState();
  }
});
