import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';

const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function log(...args: unknown[]): void {
  console.log('[PII NER]', ...args);
}
function debug(...args: unknown[]): void {
  if (PII_DEBUG) {
    console.log('[PII NER]', ...args);
  }
}

type SpacyEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
};

const LABEL_MAP: Record<string, PiiType> = {
  PERSON: PiiType.NAME,
  GPE: PiiType.LOCATION,
  LOC: PiiType.LOCATION,
  FAC: PiiType.LOCATION,
  ORG: PiiType.ORG,
  DATE: PiiType.DATE,
  TIME: PiiType.TIME,
};

function mapLabel(label: string): PiiType | null {
  return LABEL_MAP[label] ?? null;
}

function resolveScriptPath(): string {
  if (process.env.PII_SPACY_SCRIPT) return process.env.PII_SPACY_SCRIPT;
  return path.join(app.getAppPath(), 'scripts', 'spacy_ner.py');
}

export class NerDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) return [];
    if (process.env.PII_SPACY_DISABLE === '1') return [];

    const scriptPath = resolveScriptPath();
    log('collectMatches start', { scriptPath, exists: fs.existsSync(scriptPath), textLength: text.length });
    if (!fs.existsSync(scriptPath)) {
      log('script not found, returning []');
      return [];
    }

    const pythonBin = process.env.PII_SPACY_PY ?? 'python3';
    log('spawning', pythonBin, scriptPath);

    return new Promise((resolve, reject) => {
        const proc = spawn(pythonBin, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PII_DEBUG: process.env.PII_DEBUG ?? '' },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => {
        const s = chunk.toString();
        stdout += s;
        debug('stdout chunk:', s.length, 'bytes');
        });
        proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        stderr += s;
        debug('stderr chunk:', s.length, 'bytes:', s.slice(0, 200));
        });
        proc.on('error', (err) => {
        debug('spawn error:', err);
        reject(err);
        });
        proc.on('close', (code, signal) => {
        log('process closed', { code, signal, stdoutLen: stdout.length, stderrLen: stderr.length });
        if (code !== 0) {
            debug('non-zero exit, stderr:', stderr);
            reject(new Error(stderr || `spaCy process exited with code ${code}`));
            return;
        }

        try {
            const entities = JSON.parse(stdout) as SpacyEntity[];
            const matches = entities.reduce<RawMatch[]>((acc, entity) => {
            const mapped = mapLabel(entity.label);
            if (!mapped) return acc;
            acc.push({
                type: mapped,
                start: entity.start,
                end: entity.end,
                value: entity.text,
                source: this.getName(),
                score: undefined
            });
            return acc;
            }, []);
            log('done', { entities: entities.length, matches: matches.length });
            resolve(matches);
        } catch (err) {
            log('parse error', err, 'stdout preview:', stdout.slice(0, 300));
            reject(err);
        }
        });

        log('writing to stdin, then ending');
        proc.stdin.write(text);
        proc.stdin.end();
    });
  }

  getName(): string {
    return "Ner (Spacy)"
  }

}