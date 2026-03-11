import { contextBridge, ipcRenderer } from 'electron';

export interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
  source: string;
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
  elapsedMs?: number;
  llmTokens?: number;
  llmElapsedMs?: number;
}

type LayerState = Record<string, boolean>;

export interface ScanRequest {
  text: string;
  allowlist?: string[];
  blacklist?: string[];
}

export interface WordLists {
  allowlist: string[];
  blacklist: string[];
}

export type WordListMenu = 'whitelist' | 'blacklist';

contextBridge.exposeInMainWorld('pii', {
  scanText: (request: ScanRequest | string) => ipcRenderer.invoke('pii:scan', request),
  copyToClipboard: (text: string) => ipcRenderer.invoke('pii:copy', text),
  syncWordLists: (lists: WordLists) => ipcRenderer.invoke('pii:sync-word-lists', lists),
  getLayerState: () => ipcRenderer.invoke('pii:get-layers') as Promise<LayerState>,
  setLayer: (name: string, enabled: boolean) => ipcRenderer.invoke('pii:set-layer', name, enabled),
  onLayerState: (handler: (state: LayerState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: LayerState) => {
      handler(state);
    };
    ipcRenderer.on('pii:layers', wrapped);
    return () => ipcRenderer.removeListener('pii:layers', wrapped);
  },
  onWordLists: (handler: (lists: WordLists) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, lists: WordLists) => {
      handler(lists);
    };
    ipcRenderer.on('pii:word-lists', wrapped);
    return () => ipcRenderer.removeListener('pii:word-lists', wrapped);
  },
  onOpenWordListEditor: (handler: (menu: WordListMenu) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, menu: WordListMenu) => {
      handler(menu);
    };
    ipcRenderer.on('pii:open-word-editor', wrapped);
    return () => ipcRenderer.removeListener('pii:open-word-editor', wrapped);
  },
});
