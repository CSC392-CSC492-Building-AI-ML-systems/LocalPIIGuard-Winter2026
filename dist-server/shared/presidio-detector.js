"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresidioDetector = void 0;
const ner_http_detector_1 = require("./ner-http-detector");
const types_1 = require("./types");
const LABEL_MAP = {
    CREDIT_CARD: types_1.PiiType.CARD,
    CRYPTO: types_1.PiiType.CARD,
    DATE_TIME: types_1.PiiType.DATE,
    EMAIL_ADDRESS: types_1.PiiType.EMAIL,
    IBAN_CODE: types_1.PiiType.IBAN,
    IP_ADDRESS: types_1.PiiType.IP,
    LOCATION: types_1.PiiType.LOCATION,
    PERSON: types_1.PiiType.NAME,
    PHONE_NUMBER: types_1.PiiType.PHONE,
    US_SSN: types_1.PiiType.SOCIALNUMBER,
    UK_NHS: types_1.PiiType.SOCIALNUMBER,
    MEDICAL_LICENSE: types_1.PiiType.ID,
};
class PresidioDetector extends ner_http_detector_1.NerHttpDetector {
    constructor() {
        super(...arguments);
        this.path = '/presidio';
    }
    mapLabel(label) {
        return LABEL_MAP[label] ?? null;
    }
    getName() {
        return 'Presidio (Analyzer)';
    }
}
exports.PresidioDetector = PresidioDetector;
