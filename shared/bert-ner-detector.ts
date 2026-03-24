import { NerHttpDetector } from './ner-http-detector';
import { PiiType } from './types';
import type { RawMatch } from './types';
import { selectNonOverlapping } from './helper';

// dslim/bert-large-NER outputs: PER, ORG, LOC, MISC
const LABEL_MAP: Record<string, PiiType> = {
  PER: PiiType.NAME,
  ORG: PiiType.ORG,
  LOC: PiiType.LOCATION,
};

export class BertNerDetector extends NerHttpDetector {
  protected readonly path = '/bert';

  protected mapLabel(label: string): PiiType | null {
    return LABEL_MAP[label] ?? null;
  }

  override async collectMatches(text: string): Promise<RawMatch[]> {
    const matches = await super.collectMatches(text);
    return selectNonOverlapping(matches);
  }

  getName(): string {
    return 'NER (BERT)';
  }
}
