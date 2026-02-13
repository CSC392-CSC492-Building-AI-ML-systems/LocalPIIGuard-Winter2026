export enum PiiType {
  EMAIL = "EMAIL",
  PHONE = "PHONE",
  IP = "IP",
  CARD = "CARD",
  NAME = "NAME",
  LOCATION = "LOCATION",
  ORG = "ORG",
  DATE = "DATE"
}

export interface Match {
  type: PiiType;
  start: number;
  end: number;
  value: string;
}

export interface RawMatch {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  source: string;
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
}

export interface PIIDetector {
  collectMatches(text: string): Promise<RawMatch[]>;
  getName(): string;
}