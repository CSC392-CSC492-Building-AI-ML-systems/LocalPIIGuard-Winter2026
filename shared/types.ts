export interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
}

export interface RawMatch {
  type: string;
  start: number;
  end: number;
  value: string;
  source: 'regex' | 'ner';
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
}
