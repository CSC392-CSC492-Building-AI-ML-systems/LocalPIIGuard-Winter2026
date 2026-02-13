import { contextBridge, ipcRenderer } from 'electron';

export interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
}

contextBridge.exposeInMainWorld('pii', {
  scanText: (text: string) => ipcRenderer.invoke('pii:scan', text),
  copyToClipboard: (text: string) => ipcRenderer.invoke('pii:copy', text),
});
