import { NerHttpDetector } from './ner-http-detector';
import { PiiType } from './types';

const LABEL_MAP: Record<string, PiiType> = {
  PERSON: PiiType.NAME,
  GPE: PiiType.LOCATION,
  LOC: PiiType.LOCATION,
  FAC: PiiType.LOCATION,
  ORG: PiiType.ORG,
  DATE: PiiType.DATE,
  TIME: PiiType.TIME,
};

export class NerDetector extends NerHttpDetector {
  protected readonly path = '/spacy';

  protected mapLabel(label: string): PiiType | null {
    return LABEL_MAP[label] ?? null;
  }

  getName(): string {
    return 'NER (Spacy)';
  }
}
