import http from 'http';
import { URL } from 'url';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

import type { PiiType } from '../shared/types';
import {
  applyAllowlist,
  collectManualMatches,
  maskText,
  reconstructMatches,
} from '../shared/scanner';
import { RegexDetector } from '../shared/regex-detector';
import { NerDetector } from '../shared/ner-detector';
import { SpancatDetector } from '../shared/spancat-detector';
import { PresidioDetector } from '../shared/presidio-detector';
import { LlamaDetector } from '../shared/llm-detector';
import { BertNerDetector } from '../shared/bert-ner-detector';

const PORT = Number(process.env.PII_WEB_PORT) || 8787;
const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

let nerServer: ReturnType<typeof spawn> | null = null;
let nerServerReady = false;
let isQuitting = false;
let nerRestartAttempt = 0;
const MAX_NER_RESTART_ATTEMPTS = 5;

function resolveNerServerScript(): string {
  if (process.env.PII_NER_SCRIPT) return process.env.PII_NER_SCRIPT;
  return path.join(process.cwd(), 'scripts', 'ner_server.py');
}

function startNerServer(): void {
  const scriptPath = resolveNerServerScript();
  if (!fs.existsSync(scriptPath)) {
    console.warn('[NER server] script not found at', scriptPath, '— NER detectors disabled');
    return;
  }

  const pythonBin = process.env.PII_NER_PY ?? process.env.PII_SPACY_PY ?? 'python3';
  if (PII_DEBUG) console.log('[NER server] spawning', pythonBin, scriptPath);

  nerServer = spawn(pythonBin, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdoutBuf = '';

  nerServer.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (PII_DEBUG) console.log('[NER server] stdout:', trimmed);

      const portMatch = trimmed.match(/^PORT=(\d+)$/);
      if (portMatch) {
        const port = portMatch[1];
        process.env.PII_NER_BASE = `http://127.0.0.1:${port}`;
        if (PII_DEBUG) console.log('[NER server] port set to', port);
      }

      if (trimmed === 'READY') {
        nerRestartAttempt = 0;
        nerServerReady = true;
        console.log('[NER server] ready at', process.env.PII_NER_BASE);
      }
    }
  });

  nerServer.stderr?.on('data', (chunk: Buffer) => {
    console.log('[NER server] stderr:', chunk.toString().trimEnd());
  });

  nerServer.on('error', (err) => {
    console.error('[NER server] spawn error:', err.message);
    scheduleNerRestart();
  });

  nerServer.on('exit', (code, signal) => {
    nerServer = null;
    nerServerReady = false;
    if (isQuitting) return;
    console.warn(`[NER server] exited unexpectedly (code=${code}, signal=${signal})`);
    scheduleNerRestart();
  });
}

function scheduleNerRestart(): void {
  if (isQuitting) return;
  if (nerRestartAttempt >= MAX_NER_RESTART_ATTEMPTS) {
    console.error('[NER server] max restart attempts reached — NER detectors disabled');
    return;
  }
  const delayMs = Math.min(1_000 * 2 ** nerRestartAttempt, 30_000);
  nerRestartAttempt += 1;
  console.log(
    `[NER server] restarting in ${delayMs}ms (attempt ${nerRestartAttempt}/${MAX_NER_RESTART_ATTEMPTS})`
  );
  setTimeout(startNerServer, delayMs);
}

function stopNerServer(): void {
  if (!nerServer) return;
  isQuitting = true;
  nerServer.kill('SIGTERM');
  const forceKill = setTimeout(() => nerServer?.kill('SIGKILL'), 3_000);
  nerServer.once('exit', () => clearTimeout(forceKill));
  nerServer = null;
}

const piiDetectors = [
  new RegexDetector(),
  new NerDetector(),
  new SpancatDetector(),
  new PresidioDetector(),
  new LlamaDetector(),
  new BertNerDetector(),
];

type LayerState = Record<string, boolean>;
const layerState: LayerState = Object.fromEntries(
  piiDetectors.map((detector) => {
    const name = detector.getName();
    if (name === 'LLM' && process.env.PII_LLM_DISABLE === '1') {
      return [name, false];
    }
    return [name, true];
  })
);

function normalizeWordList(items: string[] = []): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

type ScanPayload = { text?: string; allowlist?: string[]; blacklist?: string[] } | string;

async function handleScan(payload: ScanPayload): Promise<unknown> {
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

  const allDetections: Array<{ value: string; source: string; type: PiiType; score?: number | null }> = [];

  const manualMatches = applyAllowlist(input, collectManualMatches(input, blacklist), allowlist);
  for (const m of manualMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  const regexRawMatches = activeRegex ? await activeRegex.collectMatches(input) : [];
  const regexMatches = applyAllowlist(input, regexRawMatches, allowlist);
  for (const m of regexMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  const stage1Masks = [...manualMatches, ...regexMatches];
  const stage1Text = stage1Masks.length > 0 ? maskText(input, stage1Masks) : input;

  if (activeNer.length > 0 && !nerServerReady) {
    console.warn('[PII scan] NER server not ready — skipping NER stage');
  }

  if (PII_DEBUG) {
    console.log('[PII scan] NER stage', {
      nerServerReady,
      nerBase: process.env.PII_NER_BASE ?? 'http://127.0.0.1:5001',
      detectors: activeNer.map((d) => d.getName()),
      stage1Len: stage1Text.length,
    });
  }

  const summarizeMatches = (
    matches: Array<{ value: string; source: string; type: PiiType; score?: number | null }> 
  ) => {
    const limit = 50;
    const valueLimit = 80;
    const mapped = matches.slice(0, limit).map((m) => ({
      type: m.type,
      source: m.source,
      score: m.score ?? undefined,
      value:
        (m.value ?? '').length > valueLimit
          ? `${(m.value ?? '').slice(0, valueLimit)}…`
          : (m.value ?? ''),
    }));
    return matches.length > limit ? { items: mapped, truncated: matches.length - limit } : { items: mapped };
  };

  const nerResultArrays = nerServerReady
    ? await Promise.all(
        activeNer.map(async (d) => {
          const start = Date.now();
          const raw = await d.collectMatches(stage1Text);
          const filtered = applyAllowlist(stage1Text, raw, allowlist);
          if (PII_DEBUG) {
            console.log('[PII scan] NER detector done', {
              detector: d.getName(),
              raw: raw.length,
              afterAllowlist: filtered.length,
              elapsedMs: Date.now() - start,
            });
            console.log('[PII scan] NER detector raw matches', {
              detector: d.getName(),
              ...summarizeMatches(raw),
            });
            console.log('[PII scan] NER detector filtered matches', {
              detector: d.getName(),
              ...summarizeMatches(filtered),
            });
          }
          return filtered;
        })
      )
    : [];

  const allNerMatches = nerResultArrays.flat();
  for (const m of allNerMatches) {
    allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
  }

  const stage2Text = allNerMatches.length > 0 ? maskText(stage1Text, allNerMatches) : stage1Text;

  if (activeLlm) {
    try {
      const llmRaw = await activeLlm.collectMatches(stage2Text);
      const llmMatches = applyAllowlist(stage2Text, llmRaw, allowlist);
      for (const m of llmMatches) {
        allDetections.push({ value: m.value, source: m.source, type: m.type, score: m.score });
      }
    } catch (err) {
      console.warn('[PII scan] LLM stage failed:', err instanceof Error ? err.message : String(err));
    }
  }

  const finalMatches = reconstructMatches(input, allDetections);
  const redactedText = maskText(input, finalMatches);

  const elapsedMs = Date.now() - startMs;
  const llmTokens =
    activeLlm && 'getLastEvalCount' in activeLlm
      ? (activeLlm as LlamaDetector).getLastEvalCount()
      : undefined;
  const llmElapsedMs =
    activeLlm && 'getLastElapsedMs' in activeLlm
      ? (activeLlm as LlamaDetector).getLastElapsedMs()
      : undefined;

  return { redactedText, matches: finalMatches, elapsedMs, llmTokens, llmElapsedMs };
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

const distDir = path.join(process.cwd(), 'dist');

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (u.pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, nerReady: nerServerReady });
      return;
    }

    if (u.pathname === '/api/ner/health' && req.method === 'GET') {
      const base = process.env.PII_NER_BASE ?? 'http://127.0.0.1:5001';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3_000);
      try {
        const r = await fetch(`${base}/health`, { signal: controller.signal });
        const text = await r.text();
        clearTimeout(timeoutId);
        sendJson(res, 200, { ok: r.ok, status: r.status, base, body: text });
      } catch (err) {
        clearTimeout(timeoutId);
        sendJson(res, 200, {
          ok: false,
          base,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (u.pathname === '/api/layers' && req.method === 'GET') {
      sendJson(res, 200, { ...layerState });
      return;
    }

    if (u.pathname === '/api/layers/set' && req.method === 'POST') {
      const body = (await readJson(req)) as { name?: string; enabled?: boolean } | null;
      const name = body?.name;
      const enabled = body?.enabled;
      if (typeof name !== 'string' || typeof enabled !== 'boolean') {
        sendJson(res, 400, { error: 'Invalid payload' });
        return;
      }
      if (name in layerState) {
        layerState[name] = enabled;
      }
      sendJson(res, 200, { ...layerState });
      return;
    }

    if (u.pathname === '/api/scan' && req.method === 'POST') {
      const reqStart = Date.now();
      if (PII_DEBUG) {
        console.log('[PII web] /api/scan start', {
          contentLength: req.headers['content-length'],
        });
      }

      res.on('finish', () => {
        if (PII_DEBUG) {
          console.log('[PII web] /api/scan finish', {
            statusCode: res.statusCode,
            elapsedMs: Date.now() - reqStart,
          });
        }
      });

      res.on('close', () => {
        if (PII_DEBUG) {
          console.log('[PII web] /api/scan close', {
            finished: res.writableEnded,
            elapsedMs: Date.now() - reqStart,
          });
        }
      });

      try {
        const body = (await readJson(req)) as ScanPayload;
        const result = await handleScan(body);
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[PII web] /api/scan failed', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'Scan failed' });
        } else {
          res.end();
        }
      }
      return;
    }

    // Static files (production)
    if (fs.existsSync(distDir)) {
      const pathname = u.pathname === '/' ? '/index.html' : u.pathname;
      const safePath = path.normalize(pathname).replace(/^\.\.(\/|\\)/, '');
      const filePath = path.join(distDir, safePath);

      if (
        filePath.startsWith(distDir) &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const buf = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': guessContentType(filePath),
          'Content-Length': buf.length,
        });
        res.end(buf);
        return;
      }

      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Server error' });
    } else {
      res.end();
    }
  }
});

process.on('SIGINT', () => {
  stopNerServer();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopNerServer();
  server.close(() => process.exit(0));
});

startNerServer();
server.listen(PORT, () => {
  console.log(`[PII web] backend listening on http://localhost:${PORT}`);
});
