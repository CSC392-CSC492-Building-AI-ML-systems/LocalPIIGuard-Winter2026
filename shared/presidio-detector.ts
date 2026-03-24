import { NerHttpDetector } from './ner-http-detector';
import { PiiType } from './types';

const LABEL_MAP: Record<string, PiiType> = {
  CREDIT_CARD: PiiType.CARD,
  CRYPTO: PiiType.CARD,
  DATE_TIME: PiiType.DATE,
  EMAIL_ADDRESS: PiiType.EMAIL,
  IBAN_CODE: PiiType.IBAN,
  IP_ADDRESS: PiiType.IP,
  LOCATION: PiiType.LOCATION,
  PERSON: PiiType.NAME,
  PHONE_NUMBER: PiiType.PHONE,
  US_SSN: PiiType.SOCIALNUMBER,
  UK_NHS: PiiType.SOCIALNUMBER,
  MEDICAL_LICENSE: PiiType.ID,
};

export class PresidioDetector extends NerHttpDetector {
  protected readonly path = '/presidio';

  protected mapLabel(label: string): PiiType | null {
    return LABEL_MAP[label] ?? null;
  }

  getName(): string {
    return 'Presidio (Analyzer)';
  }
}
