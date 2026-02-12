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

type LayerState = Record<string, boolean>;

contextBridge.exposeInMainWorld('pii', {
  scanText: (text: string) => ipcRenderer.invoke('pii:scan', text),
  copyToClipboard: (text: string) => ipcRenderer.invoke('pii:copy', text),
  getLayerState: () => ipcRenderer.invoke('pii:get-layers') as Promise<LayerState>,
  onLayerState: (handler: (state: LayerState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: LayerState) => {
      handler(state);
    };
    ipcRenderer.on('pii:layers', wrapped);
    return () => ipcRenderer.removeListener('pii:layers', wrapped);
  },
});
