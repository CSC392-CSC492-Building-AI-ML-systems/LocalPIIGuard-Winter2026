import { app, BrowserWindow, ipcMain, clipboard, Menu } from 'electron';
import path from 'path';
import { buildRedaction, mergeMatches } from '../shared/scanner';

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
  console.log('[PII scan] start', { inputLen: input.length, active: activeDetectors.map(d => d.getName()) });
  if (PII_DEBUG) {
    console.log('[PII scan] input length:', input.length, 'active layers:', activeDetectors.map(d => d.getName()));
  }

  // Collect all matches from active detectors
  const allMatches = await Promise.all(
    activeDetectors.map(detector => detector.collectMatches(input))
  );

  if (PII_DEBUG) {
    activeDetectors.forEach((detector, i) => {
      const count = allMatches[i]?.length ?? 0;
      console.log('[PII scan]', detector.getName(), 'matches:', count, allMatches[i]?.slice(0, 3));
    });
  }

  // Merge all matches starting from regexMatches
  const merged = allMatches.reduce(
    (acc, matches) => mergeMatches(acc, matches ?? []),
    []
  );

  if (PII_DEBUG) {
    console.log('[PII scan] merged total:', merged.length, 'merged (first 5):', merged.slice(0, 5));
  }

  const result = buildRedaction(input, merged);
  if (PII_DEBUG) {
    console.log('[PII scan] redacted length:', result.redactedText.length, 'preview:', result.redactedText.slice(0, 120));
  }
  return result;
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
