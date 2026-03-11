import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RawMatch, PIIDetector } from './types';
import { PiiType } from './types';

type PresidioEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
};

 // Presidio uses specific uppercase labels by default

const LABEL_MAP: Record<string, PiiType> = {
  'CREDIT_CARD': PiiType.CARD,
  'CRYPTO': PiiType.CARD,
  'DATE_TIME': PiiType.DATE,
  'EMAIL_ADDRESS': PiiType.EMAIL,
  'IBAN_CODE': PiiType.IBAN,
  'IP_ADDRESS': PiiType.IP,
  'LOCATION': PiiType.LOCATION,
  'PERSON': PiiType.NAME,
  'PHONE_NUMBER': PiiType.PHONE,
  'US_SSN': PiiType.SOCIALNUMBER, // Added common Presidio types
  'UK_NHS': PiiType.SOCIALNUMBER,
  'MEDICAL_LICENSE': PiiType.IDCARD,
}; 

export class PresidioDetector implements PIIDetector {
  async collectMatches(text: string): Promise<RawMatch[]> {
    if (!text.trim()) return [];

    const scriptPath = this.resolveScriptPath();
    const pythonBin = process.env.PII_PRESIDIO_PY ?? 'python3';

    if (!fs.existsSync(scriptPath)) {
      console.error(`Presidio script not found at: ${scriptPath}`);
      return [];
    }

    return new Promise((resolve, reject) => {
      // Use the '-u' flag for unbuffered output to ensure we get data immediately
      const proc = spawn(pythonBin, ['-u', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // 1. Write the input immediately and close stdin
      // This tells Python "This is all the text I have, go ahead and process it."
      proc.stdin.setDefaultEncoding('utf-8');
      proc.stdin.write(text);
      proc.stdin.end();

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      
      proc.on('error', (err) => {
        console.error("Failed to start Presidio process:", err);
        reject(err);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`Presidio process failed. Stderr: ${stderr}`);
          resolve([]); // Return empty instead of crashing the UI
          return;
        }

        try {
          // Log raw output to terminal for debugging
          console.log(`Presidio Raw Output: ${stdout}`);
          
          const entities = JSON.parse(stdout || '[]') as PresidioEntity[];
          const matches = entities.reduce<RawMatch[]>((acc, entity) => {
            const mapped = LABEL_MAP[entity.label];
            if (!mapped) return acc;
            if (entity.score < 0.3) return acc; // Lowered threshold slightly

            acc.push({
              type: mapped,
              start: entity.start,
              end: entity.end,
              value: entity.text,
              source: this.getName(),
            });
            return acc;
          }, []);
          resolve(matches);
        } catch (err) {
          console.error("Failed to parse Presidio JSON:", stdout);
          resolve([]);
        }
      });
    });
  }

  private resolveScriptPath(): string {
    if (process.env.PII_PRESIDIO_SCRIPT) return process.env.PII_PRESIDIO_SCRIPT;
    
    // Check if we are in dev or prod (ASAR)
    const base = app.isPackaged 
      ? path.join(process.resourcesPath, 'scripts') // Use resourcesPath for prod
      : path.join(app.getAppPath(), 'scripts');
      
    return path.join(base, 'presido_ner.py');
  }

  getName(): string {
    return "Presidio (Analyzer)";
  }
}