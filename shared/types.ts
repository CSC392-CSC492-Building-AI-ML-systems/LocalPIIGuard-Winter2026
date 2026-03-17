export enum PiiType {
  EMAIL = "EMAIL",
  PHONE = "PHONE",
  IP = "IP",
  IPV6 = "IPV6",
  MAC = "MAC",
  CARD = "CARD",
  IBAN = "IBAN",
  NAME = "NAME",
  LOCATION = "LOCATION",
  ORG = "ORG",
  DATE = "DATE",
  USERNAME = "USERNAME",
  TIME = "TIME",
  IDCARD = "IDCARD",
  PASS = "PASS",
  SOCIALNUMBER = "SOCIALNUMBER",
  BLACKLIST = "BLACKLIST",
}

export interface Match {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  source: string;
  score?: number | null;
}

export interface RawMatch {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  source: string;
  label?: string;
  score?: number | null;
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
  /** Time taken for the scan in milliseconds (for UI display). */
  elapsedMs?: number;
  /** LLM output token count (when LLM detector was used). */
  llmTokens?: number;
  /** LLM-only elapsed time in ms (for tokens/s and ms/token). */
  llmElapsedMs?: number;
}

export interface PIIDetector {
  collectMatches(text: string): Promise<RawMatch[]>;
  getName(): string;
}