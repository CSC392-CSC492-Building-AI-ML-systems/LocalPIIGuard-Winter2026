import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';

const PII_DEBUG = /^1|true|yes$/i.test(process.env.PII_DEBUG ?? '');

function log(...args: unknown[]): void {
  console.log('[PII GLiNER]', ...args);
}

function debug(...args: unknown[]): void {
  if (PII_DEBUG) {
    console.log('[PII GLiNER]', ...args);
  }
}

type GlinerEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score?: number;
};

const LABEL_MAP: Record<string, PiiType> = {
  // Personal information
  first_name: PiiType.FIRSTNAME,
  last_name: PiiType.LASTNAME,
  name: PiiType.NAME,
  date_of_birth: PiiType.DATE,
  date: PiiType.DATE,
  date_time: PiiType.DATE,
  time: PiiType.TIME,

  // Contact information
  email: PiiType.EMAIL,
  phone_number: PiiType.PHONE,
  city: PiiType.CITY,
  state: PiiType.STATE,
  country: PiiType.COUNTRY,
  street_address: PiiType.STREET,
  zip_code: PiiType.POSTCODE,
  po_box: PiiType.POSTCODE,
  county: PiiType.LOCATION,
  coordinate: PiiType.LOCATION,

  // Financial information
  credit_debit_card: PiiType.CARD,
  account_number: PiiType.CARD,
  bank_routing_number: PiiType.CARD,
  iban: PiiType.CARD,
  swift_bic: PiiType.CARD,
  cvv: PiiType.CARD,
  pin: PiiType.PASS,

  // Government identifiers
  passport_number: PiiType.IDCARD,
  driver_license: PiiType.IDCARD,
  license_plate: PiiType.IDCARD,
  national_id: PiiType.IDCARD,
  voter_id: PiiType.IDCARD,
  ssn: PiiType.SOCIALNUMBER,
  tax_id: PiiType.SOCIALNUMBER,
  ein: PiiType.SOCIALNUMBER,

  // Digital / technical identifiers
  ipv4: PiiType.IP,
  ipv6: PiiType.IP,
  user_name: PiiType.USERNAME,
  password: PiiType.PASS,

  // Organization information
  company_name: PiiType.ORG,
};

function mapLabel(label: string): PiiType | null {
  if (!label) return null;
  const key = label.toLowerCase().trim();
  return LABEL_MAP[key] ?? null;
}

function resolveScriptPath(): string {
  if (process.env.PII_GLINER_SCRIPT) return process.env.PII_GLINER_SCRIPT;
  return path.join(app.getAppPath(), 'scripts', 'gliner_pii.py');
}

export class GlinerDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) return [];
    if (process.env.PII_GLINER_DISABLE === '1') {
      debug('collectMatches: PII_GLINER_DISABLE=1, skipping');
      return [];
    }

    const scriptPath = resolveScriptPath();
    log('collectMatches start', {
      scriptPath,
      exists: fs.existsSync(scriptPath),
      textLength: text.length,
    });
    if (!fs.existsSync(scriptPath)) {
      log('script not found, returning []');
      return [];
    }

    const pythonBin = process.env.PII_GLINER_PY ?? 'python3';
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
        log('process closed', {
          code,
          signal,
          stdoutLen: stdout.length,
          stderrLen: stderr.length,
        });
        if (code !== 0) {
          debug('non-zero exit, stderr:', stderr);
          reject(new Error(stderr || `GLiNER process exited with code ${code}`));
          return;
        }

        try {
          const entities = JSON.parse(stdout) as GlinerEntity[];
          const matches = entities.reduce<RawMatch[]>((acc, entity) => {
            const mapped = mapLabel(entity.label);
            if (!mapped) return acc;
            acc.push({
              type: mapped,
              start: entity.start,
              end: entity.end,
              value: entity.text,
              source: this.getName(),
            });
            return acc;
          }, []);
          log('done', {
            entities: entities.length,
            matches: matches.length,
          });
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
    return 'GLiNER';
  }
}

