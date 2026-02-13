import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RawMatch } from '../shared/types';

type SpacyEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
};

const LABEL_MAP: Record<string, string> = {
  PERSON: 'NAME',
  GPE: 'LOCATION',
  LOC: 'LOCATION',
  FAC: 'LOCATION',
  ORG: 'ORG',
  DATE: 'DATE',
  TIME: 'DATE',
};

function mapLabel(label: string): string | null {
  return LABEL_MAP[label] ?? null;
}

function resolveScriptPath(): string {
  if (process.env.PII_SPACY_SCRIPT) return process.env.PII_SPACY_SCRIPT;
  return path.join(app.getAppPath(), 'scripts', 'spacy_ner.py');
}

export async function getSpacyMatches(text: string): Promise<RawMatch[]> {
  if (!text.trim()) return [];
  if (process.env.PII_SPACY_DISABLE === '1') return [];

  const scriptPath = resolveScriptPath();
  if (!fs.existsSync(scriptPath)) return [];

  const pythonBin = process.env.PII_SPACY_PY ?? 'python';

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
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
            source: 'ner',
          });
          return acc;
        }, []);
        resolve(matches);
      } catch (err) {
        reject(err);
      }
    });

    proc.stdin.write(text);
    proc.stdin.end();
  });
}

