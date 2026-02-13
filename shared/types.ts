export interface Match {
  type: string;
  start: number;
  end: number;
  value: string;
}

export interface ScanResult {
  redactedText: string;
  matches: Match[];
}
