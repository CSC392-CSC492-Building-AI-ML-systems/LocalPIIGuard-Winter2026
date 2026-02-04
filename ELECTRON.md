# Electron App Guide — Local PII Guard

This document describes the Electron desktop application architecture, security model, IPC, and development workflow.

---

## Architecture Overview

The app uses a standard Electron architecture with three layers:

| Layer | Location | Role |
|-------|----------|------|
| **Main process** | `electron/main.ts` | Window management, IPC handlers, native APIs (clipboard) |
| **Preload script** | `electron/preload.ts` | Bridges main and renderer via `contextBridge` |
| **Renderer process** | `src/` (React + Vite) | UI, user input, display of scan results |

---

## Process Model

### Main Process
- Manages the application window (title: **Local PII Guard**)
- Loads the renderer:
  - **Dev**: `http://localhost:5173` (Vite dev server)
  - **Prod**: `dist/index.html` (built Vite output)
- Registers IPC handlers for `pii:scan` and `pii:copy`
- Uses Electron `clipboard` for copy operations

### Preload Script
- Runs in an isolated context before the renderer loads
- Exposes a minimal API to the renderer via `contextBridge`:
  - `window.pii.scanText(text: string)` → `Promise<{ redactedText: string; matches: Match[] }>`
  - `window.pii.copyToClipboard(text: string)` → `Promise<void>`
- No Node.js APIs are exposed to the renderer; all access goes through IPC

### Renderer Process
- React app served by Vite
- Calls `window.pii.scanText()` and `window.pii.copyToClipboard()` for core functionality
- Has no direct access to `require`, `process`, or Node modules

---

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `pii:scan` | Renderer → Main | Scan text for PII and return redacted text + matches |
| `pii:copy` | Renderer → Main | Write text to the system clipboard |

Both use `ipcRenderer.invoke()` / `ipcMain.handle()` for request–response style calls.

---

## Security Configuration

Configured in `electron/main.ts` under `webPreferences`:

| Option | Value | Purpose |
|--------|-------|---------|
| `contextIsolation` | `true` | Separates preload and renderer contexts; required for safe `contextBridge` use |
| `nodeIntegration` | `false` | Prevents renderer from using `require()` or Node APIs |
| `preload` | Path to `preload.js` | Loads the bridge script before the renderer |
| `sandbox` | `false` | Required for preload to access `ipcRenderer`; renderer remains sandboxed |

---

## File Structure

```
electron/
├── main.ts        # Main process entry, window, IPC handlers
└── preload.ts     # contextBridge API for renderer

shared/            # Used by main process (and could be shared with renderer if needed)
├── types.ts       # Match, ScanResult interfaces
└── scanner.ts     # Regex-based PII detection logic

dist-electron/     # Compiled output (after npm run build:electron)
├── electron/
│   ├── main.js
│   └── preload.js
└── shared/
    ├── scanner.js
    └── types.js
```

---

## Build and Output Paths

- **Main entry**: `package.json` → `"main": "dist-electron/electron/main.js"`
- **Preload**: Resolved at runtime via `path.join(__dirname, 'preload.js')` (relative to `main.js`)
- **Renderer (prod)**: `path.join(__dirname, '../../dist/index.html')` (Vite build output)

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Builds Electron, starts Vite, then launches Electron when Vite is ready |
| `npm run build:electron` | Compiles `electron/` and `shared/` with `tsc -p tsconfig.electron.json` |
| `npm run build` | Runs `build:vite` then `build:electron` |

---

## Packaging (electron-builder)

The project includes `electron-builder` configuration in `package.json` under the `"build"` key:

- **Output**: `release/`
- **Files**: `dist/**/*`, `dist-electron/**/*`
- **Targets**: `dmg` (macOS), `nsis` (Windows)

Commands:
```bash
npx electron-builder --mac
npx electron-builder --win
```

---

## TypeScript Configuration

- **Renderer**: `tsconfig.json` (Vite, React)
- **Main + preload + shared**: `tsconfig.electron.json`
  - `module: "commonjs"` (Node/Electron)
  - `outDir: "dist-electron"`
  - Includes `electron/**/*.ts` and `shared/**/*.ts`

---

## Dev Workflow

1. `npm install` — install dependencies
2. `npm run dev` — builds Electron, starts Vite, launches Electron
3. React UI hot-reloads; Electron main process changes require restarting `npm run dev`

---

## Environment Detection

- **Dev**: `process.env.NODE_ENV === 'development'` or `!app.isPackaged`
- In dev: loads `http://localhost:5173`, opens DevTools
- In prod: loads `dist/index.html`, no DevTools
