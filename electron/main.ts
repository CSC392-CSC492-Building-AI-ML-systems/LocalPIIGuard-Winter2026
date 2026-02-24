import { app, BrowserWindow, ipcMain, clipboard, Menu } from 'electron';
import path from 'path';
import { buildRedaction, mergeMatches } from '../shared/scanner';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

import { RegexDetector } from '../shared/regex-detector'
import { NerDetector } from '../shared/ner-detector';
import { PresidioDetector } from '../shared/presidio-detector';

const piiDetector = [
  new RegexDetector(),
  new NerDetector(),
  new PresidioDetector()
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

// IPC handlers
ipcMain.handle('pii:scan', async (_event, text: string) => {
  const input = text ?? '';
  // Collect all matches from active detectors
  const allMatches = await Promise.all(
    piiDetector
      .filter(detector => layerState[detector.getName()]) 
      .map(detector => detector.collectMatches(input))
  );

  // Merge all matches starting from regexMatches
  const merged = allMatches.reduce(
    (acc, matches) => mergeMatches(acc, matches ?? []),
    []
  );

  return buildRedaction(input, merged);
});

ipcMain.handle('pii:copy', (_event, text: string) => {
  clipboard.writeText(text ?? '');
});

ipcMain.handle('pii:get-layers', () => ({ ...layerState }));
