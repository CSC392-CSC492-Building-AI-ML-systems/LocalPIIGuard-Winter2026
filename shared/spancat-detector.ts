import { NerHttpDetector } from './ner-http-detector';
import { PiiType } from './types';

const LABEL_MAP: Record<string, PiiType> = {
  NAME: PiiType.NAME,
  ADDRESS: PiiType.LOCATION,
  ORG: PiiType.ORG,
  DATE: PiiType.DATE,
  EMAIL: PiiType.EMAIL,
  PHONE: PiiType.PHONE,
  IP_ADDRESS: PiiType.IP,
  URL: PiiType.IPV6,
  USERNAME: PiiType.USERNAME,
  PASSWORD: PiiType.PASS,
  SSN: PiiType.SOCIALNUMBER,
  ID_NUMBER: PiiType.ID,
  CREDIT_CARD: PiiType.CARD,
  DATE_OF_BIRTH: PiiType.DATE,
};

export class SpancatDetector extends NerHttpDetector {
  protected readonly path = '/spancat';

  protected mapLabel(label: string): PiiType | null {
    return LABEL_MAP[label] ?? null;
  }

  getName(): string {
    return 'Spancat (Spacy)';
  }
}
