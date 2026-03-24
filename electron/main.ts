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
import { SpancatDetector } from '../shared/spancat-detector';
import { PresidioDetector } from '../shared/presidio-detector';
import { LlamaDetector } from '../shared/llm-detector';
import { BertNerDetector } from '../shared/bert-ner-detector';

const isDev = process.env.NODE_ENV === 'development';
const openDevTools = /^1|true|yes$/i.test(process.env.PII_ELECTRON_DEVTOOLS ?? '');
const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');


const piiDetectors = [new RegexDetector(), new NerDetector(), new SpancatDetector, new PresidioDetector, new LlamaDetector(), new BertNerDetector()];

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
    if (openDevTools) {
      mainWindow.webContents.openDevTools();
    }
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
  const startMs = Date.now();

  // Split detectors into pipeline stages
  const enabledDetectors = piiDetectors.filter((d) => layerState[d.getName()]);
  const activeRegex = enabledDetectors.find((d) => d instanceof RegexDetector);
  const activeNer = enabledDetectors.filter(
    (d) =>
      d instanceof NerDetector ||
      d instanceof SpancatDetector ||
      d instanceof PresidioDetector ||
      d instanceof BertNerDetector
  );
  const activeLlm = enabledDetectors.find((d) => d instanceof LlamaDetector);

  if (PII_DEBUG) {
    console.log('[PII scan] start', {
      inputLen: input.length,
      regex: activeRegex?.getName() ?? 'disabled',
      ner: activeNer.map((d) => d.getName()),
      llm: activeLlm?.getName() ?? 'disabled',
      allowlistCount: allowlist.length,
      blacklistCount: blacklist.length,
    });
  }

  const allDetections: Array<{ value: string; source: string; type: PiiType; score?: number | null }> = [];

  // --- Stage 0: Manual blacklist (always on original text) ---
  const manualMatches = applyAllowlist(input, collectManualMatches(input, blacklist), allowlist);
  for (const m of manualMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  // --- Stage 1: Regex on original text ---
  const regexRawMatches = activeRegex ? await activeRegex.collectMatches(input) : [];
  const regexMatches = applyAllowlist(input, regexRawMatches, allowlist);
  if (PII_DEBUG) console.log('[PII scan] Regex', { raw: regexRawMatches.length, afterAllowlist: regexMatches.length });
  for (const m of regexMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  // Mask regex + manual findings so NER models see pre-cleaned text
  const stage1Masks = [...manualMatches, ...regexMatches];
  const stage1Text = stage1Masks.length > 0 ? maskText(input, stage1Masks) : input;

  // --- Stage 2: NER models in parallel on regex-masked text ---
  const nerResultArrays = await Promise.all(
    activeNer.map(async (d) => {
      const raw = await d.collectMatches(stage1Text);
      const filtered = applyAllowlist(stage1Text, raw, allowlist);
      if (PII_DEBUG) console.log('[PII scan]', d.getName(), { raw: raw.length, afterAllowlist: filtered.length });
      return filtered;
    })
  );
  const allNerMatches = nerResultArrays.flat();
  for (const m of allNerMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  // Mask NER findings on top of stage1Text so the LLM sees a fully pre-cleaned text
  const stage2Text = allNerMatches.length > 0 ? maskText(stage1Text, allNerMatches) : stage1Text;

  // --- Stage 3: LLM on fully pre-masked text ---
  if (activeLlm) {
    const llmRaw = await activeLlm.collectMatches(stage2Text);
    const llmMatches = applyAllowlist(stage2Text, llmRaw, allowlist);
    if (PII_DEBUG) console.log('[PII scan] LLM', { raw: llmRaw.length, afterAllowlist: llmMatches.length });
    for (const m of llmMatches) {
      allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
    }
  }

  // Reconstruct all detections back to original text coordinate space, then produce final redacted output
  const finalMatches = reconstructMatches(input, allDetections);
  const redactedText = maskText(input, finalMatches);
  const result = { redactedText, matches: finalMatches };
  const elapsedMs = Date.now() - startMs;
  const llmTokens =
    activeLlm && 'getLastEvalCount' in activeLlm
      ? (activeLlm as LlamaDetector).getLastEvalCount()
      : undefined;
  const llmElapsedMs =
    activeLlm && 'getLastElapsedMs' in activeLlm
      ? (activeLlm as LlamaDetector).getLastElapsedMs()
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