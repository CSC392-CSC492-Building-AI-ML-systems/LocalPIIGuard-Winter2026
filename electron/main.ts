import { app, BrowserWindow, ipcMain, clipboard, Menu } from 'electron';
import path from 'path';
import { buildRedaction, collectRegexMatches, mergeMatches } from '../shared/scanner';
import { getSpacyMatches } from './ner';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

const layerState = {
  regex: true,
  ner: true,
};

let mainWindow: BrowserWindow | null = null;

function notifyLayerState(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send('pii:layers', { ...layerState });
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'PII Layers',
      submenu: [
        {
          label: 'Regex',
          type: 'checkbox',
          checked: layerState.regex,
          click: (item) => {
            layerState.regex = item.checked;
            notifyLayerState();
          },
        },
        {
          label: 'NER (spaCy)',
          type: 'checkbox',
          checked: layerState.ner,
          click: (item) => {
            layerState.ner = item.checked;
            notifyLayerState();
          },
        },
      ],
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
  const regexMatches = layerState.regex ? collectRegexMatches(input) : [];

  if (!layerState.ner) {
    return buildRedaction(input, regexMatches);
  }

  try {
    const nerMatches = await getSpacyMatches(input);
    const merged = mergeMatches(regexMatches, nerMatches);
    return buildRedaction(input, merged);
  } catch (error) {
    if (isDev) {
      console.warn('spaCy NER failed, falling back to regex-only scan.', error);
    }
    return buildRedaction(input, regexMatches);
  }
});

ipcMain.handle('pii:copy', (_event, text: string) => {
  clipboard.writeText(text ?? '');
});

ipcMain.handle('pii:get-layers', () => ({ ...layerState }));
