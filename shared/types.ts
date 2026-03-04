export enum PiiType {
  EMAIL = "EMAIL",
  PHONE = "PHONE",
  IP = "IP",
  IPV6 = "IPV6",
  MAC = "MAC",
  CARD = "CARD",
  IBAN = "IBAN",
  NAME = "NAME",
  FIRSTNAME = "FIRSTNAME",
  LASTNAME = "LASTNAME",
  LOCATION = "LOCATION",
  ORG = "ORG",
  DATE = "DATE",
  USERNAME = "USERNAME",
  TIME = "TIME",
  IDCARD = "IDCARD",
  COUNTRY = "COUNTRY",
  BUILDING = "BUILDING",
  STREET = "STREET",
  CITY = "CITY",
  STATE = "STATE",
  POSTCODE = "POSTCODE",
  PASS = "PASS",
  SOCIALNUMBER = "SOCIALNUMBER",
}

export interface Match {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  source: string;
}

export interface RawMatch {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  source: string;
  label?: string;
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