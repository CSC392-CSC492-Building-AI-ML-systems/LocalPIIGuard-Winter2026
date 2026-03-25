"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpancatDetector = void 0;
const ner_http_detector_1 = require("./ner-http-detector");
const types_1 = require("./types");
const LABEL_MAP = {
    NAME: types_1.PiiType.NAME,
    ADDRESS: types_1.PiiType.LOCATION,
    ORG: types_1.PiiType.ORG,
    DATE: types_1.PiiType.DATE,
    EMAIL: types_1.PiiType.EMAIL,
    PHONE: types_1.PiiType.PHONE,
    IP_ADDRESS: types_1.PiiType.IP,
    URL: types_1.PiiType.IPV6,
    USERNAME: types_1.PiiType.USERNAME,
    PASSWORD: types_1.PiiType.PASS,
    SSN: types_1.PiiType.SOCIALNUMBER,
    ID_NUMBER: types_1.PiiType.ID,
    CREDIT_CARD: types_1.PiiType.CARD,
    DATE_OF_BIRTH: types_1.PiiType.DATE,
};
class SpancatDetector extends ner_http_detector_1.NerHttpDetector {
    constructor() {
        super(...arguments);
        this.path = '/spancat';
    }
    mapLabel(label) {
        return LABEL_MAP[label] ?? null;
    }
    getName() {
        return 'Spancat (Spacy)';
    }
}
exports.SpancatDetector = SpancatDetector;
