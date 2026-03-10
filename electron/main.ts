import { app, BrowserWindow, ipcMain, clipboard, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import path from 'path';
import {
  applyAllowlist,
  collectManualMatches,
  maskText,
  reconstructMatches,
} from '../shared/scanner';
import type { PiiType } from '../shared/types';
import { RegexDetector } from '../shared/regex-detector';
import { NerDetector } from '../shared/ner-detector';
import { LlamaDetector } from '../shared/llm-detector';
import { BertNerDetector } from '../shared/bert-ner-detector';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

const piiDetectors = [new RegexDetector(), new NerDetector(), new LlamaDetector(), new BertNerDetector()];

type LayerState = Record<string, boolean>;
const layerState: LayerState = Object.fromEntries(
  piiDetectors.map((detector) => [detector.getName(), true])
);

const wordListState = {
  allowlist: [] as string[],
  blacklist: [] as string[],
};

let mainWindow: BrowserWindow | null = null;

function notifyLayerState(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send('pii:layers', { ...layerState });
}

function notifyWordLists(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send('pii:word-lists', {
    allowlist: [...wordListState.allowlist],
    blacklist: [...wordListState.blacklist],
  });
}

function openWordEditor(list: 'allowlist' | 'blacklist'): void {
  if (!mainWindow) return;
  mainWindow.webContents.send(
    'pii:open-word-editor',
    list === 'allowlist' ? 'whitelist' : 'blacklist'
  );
}

function normalizeWordList(items: string[] = []): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function updateWordLists(next: { allowlist?: string[]; blacklist?: string[] }): boolean {
  const nextAllowlist =
    next.allowlist == null ? wordListState.allowlist : normalizeWordList(next.allowlist);
  const nextBlacklist =
    next.blacklist == null ? wordListState.blacklist : normalizeWordList(next.blacklist);
  const changed =
    nextAllowlist.length !== wordListState.allowlist.length ||
    nextBlacklist.length !== wordListState.blacklist.length ||
    nextAllowlist.some((item, index) => item !== wordListState.allowlist[index]) ||
    nextBlacklist.some((item, index) => item !== wordListState.blacklist[index]);

  if (!changed) return false;

  wordListState.allowlist = nextAllowlist;
  wordListState.blacklist = nextBlacklist;
  buildMenu();
  notifyWordLists();
  return true;
}

function removeWord(list: 'allowlist' | 'blacklist', value: string): void {
  updateWordLists({
    allowlist:
      list === 'allowlist'
        ? wordListState.allowlist.filter((item) => item !== value)
        : wordListState.allowlist,
    blacklist:
      list === 'blacklist'
        ? wordListState.blacklist.filter((item) => item !== value)
        : wordListState.blacklist,
  });
}

function buildWordListMenu(
  label: string,
  list: 'allowlist' | 'blacklist'
): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Add Word...',
      click: () => {
        openWordEditor(list);
      },
    },
  ];

  const words = wordListState[list];
  if (words.length === 0) {
    items.push({
      label: 'No words added',
      enabled: false,
    });
  } else {
    items.push({ type: 'separator' });
    items.push(
      ...words.map((word) => ({
        label: `Remove: ${word}`,
        click: () => {
          removeWord(list, word);
        },
      }))
    );
  }

  return {
    label,
    submenu: items,
  };
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { role: 'editMenu' },
    {
      label: 'PII Layers',
      submenu: piiDetectors.map((detector) => ({
        label: detector.getName(),
        type: 'checkbox',
        checked: layerState[detector.getName()],
        click: (item) => {
          layerState[detector.getName()] = item.checked;
          notifyLayerState();
        },
      })),
    },
    buildWordListMenu('Whitelist', 'allowlist'),
    buildWordListMenu('Blacklist', 'blacklist'),
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
      sandbox: false,
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

type ScanPayload = { text?: string; allowlist?: string[]; blacklist?: string[] } | string;

ipcMain.handle('pii:scan', async (_event, payload: ScanPayload) => {
  const request =
    typeof payload === 'string'
      ? { text: payload, allowlist: [] as string[], blacklist: [] as string[] }
      : {
          text: payload?.text ?? '',
          allowlist: Array.isArray(payload?.allowlist) ? payload.allowlist : [],
          blacklist: Array.isArray(payload?.blacklist) ? payload.blacklist : [],
        };

  const input = request.text ?? '';
  const allowlist = normalizeWordList(request.allowlist);
  const blacklist = normalizeWordList(request.blacklist);
  const activeDetectors = piiDetectors.filter((detector) => layerState[detector.getName()]);
  const startMs = Date.now();

  if (PII_DEBUG) {
    console.log('[PII scan] start', {
      inputLen: input.length,
      active: activeDetectors.map((d) => d.getName()),
      allowlistCount: allowlist.length,
      blacklistCount: blacklist.length,
    });
  }

  let currentText = input;
  const allDetections: Array<{ value: string; source: string; type: PiiType }> = [];

  const manualMatches = applyAllowlist(
    currentText,
    collectManualMatches(currentText, blacklist),
    allowlist
  );
  if (manualMatches.length > 0) {
    for (const m of manualMatches) {
      allDetections.push({ value: m.value, source: m.source, type: m.type });
    }
    currentText = maskText(currentText, manualMatches);
  }

  for (const detector of activeDetectors) {
    const rawMatches = await detector.collectMatches(currentText);
    const matches = applyAllowlist(currentText, rawMatches, allowlist);

    if (PII_DEBUG) {
      console.log('[PII scan]', detector.getName(), {
        rawMatches: rawMatches.length,
        afterAllowlist: matches.length,
      });
    }

    for (const m of matches) {
      allDetections.push({ value: m.value, source: m.source, type: m.type });
    }
    currentText = maskText(currentText, matches);
  }

  const finalMatches = reconstructMatches(input, allDetections);
  const result = { redactedText: currentText, matches: finalMatches };
  const elapsedMs = Date.now() - startMs;
  const llama = activeDetectors.find((detector) => detector.getName() === 'LLM');
  const llmTokens =
    llama && 'getLastEvalCount' in llama
      ? (llama as LlamaDetector).getLastEvalCount()
      : undefined;
  const llmElapsedMs =
    llama && 'getLastElapsedMs' in llama
      ? (llama as LlamaDetector).getLastElapsedMs()
      : undefined;

  if (PII_DEBUG) {
    console.log('[PII scan] done', {
      detections: finalMatches.length,
      elapsedMs,
      llmTokens,
      llmElapsedMs,
    });
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

ipcMain.handle(
  'pii:sync-word-lists',
  (_event, lists: { allowlist?: string[]; blacklist?: string[] }) => {
    updateWordLists(lists ?? {});
  }
);
