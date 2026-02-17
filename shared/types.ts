export enum PiiType {
  EMAIL = "EMAIL",
  PHONE = "PHONE",
  IP = "IP",
  CARD = "CARD",
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
}

export interface PIIDetector {
  collectMatches(text: string): Promise<RawMatch[]>;
  getName(): string;
}