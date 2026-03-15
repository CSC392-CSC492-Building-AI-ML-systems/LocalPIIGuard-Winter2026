import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';

const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function log(...args: unknown[]): void {
  console.log('[PII SPANCAT]', ...args);
}
function debug(...args: unknown[]): void {
  if (PII_DEBUG) {
    console.log('[PII SPANCAT]', ...args);
  }
}

type SpacyEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number | null;
};

const LABEL_MAP: Record<string, PiiType> = {
  NAME: PiiType.NAME,
  ADDRESS: PiiType.LOCATION,
  ORG: PiiType.ORG,
  DATE: PiiType.DATE,
  EMAIL: PiiType.EMAIL,
  PHONE: PiiType.PHONE,
  IP_ADDRESS: PiiType.IP,
  //JOB_TITLE: PiiType.ORG, // CHANGE!!!!! ADD A MISC FIELD PROBS
  URL: PiiType.IPV6,
  USERNAME: PiiType.USERNAME,
  PASSWORD: PiiType.PASS,
  SSN: PiiType.SOCIALNUMBER,
  ID_NUMBER: PiiType.IDCARD,
  CREDIT_CARD: PiiType.CARD,
  DATE_OF_BIRTH: PiiType.DATE,

  // DEMOGRAPHIC
  // MEDICAL
};

function mapLabel(label: string): PiiType | null {
  return LABEL_MAP[label] ?? null;
}

function resolveScriptPath(): string {
  if (process.env.PII_SPANCAT_SCRIPT) return process.env.PII_SPANCAT_SCRIPT;
  return path.join(app.getAppPath(), 'scripts', 'spancat.py');
}

export class SpancatDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) return [];
    if (process.env.PII_SPANCAT_DISABLE === '1') return [];

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
            reject(new Error(stderr || `Spancat process exited with code ${code}`));
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
                score: entity.score ?? null,
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
    return "Spancat (Spacy)"
  }

}