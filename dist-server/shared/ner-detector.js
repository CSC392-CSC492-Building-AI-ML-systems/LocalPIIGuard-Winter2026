"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NerDetector = void 0;
const ner_http_detector_1 = require("./ner-http-detector");
const types_1 = require("./types");
const LABEL_MAP = {
    PERSON: types_1.PiiType.NAME,
    GPE: types_1.PiiType.LOCATION,
    LOC: types_1.PiiType.LOCATION,
    FAC: types_1.PiiType.LOCATION,
    ORG: types_1.PiiType.ORG,
    DATE: types_1.PiiType.DATE,
    TIME: types_1.PiiType.TIME,
};
class NerDetector extends ner_http_detector_1.NerHttpDetector {
    constructor() {
        super(...arguments);
        this.path = '/spacy';
    }
    mapLabel(label) {
        return LABEL_MAP[label] ?? null;
    }
    getName() {
        return 'Ner (Spacy)';
    }
}
exports.NerDetector = NerDetector;
