"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BertNerDetector = void 0;
const ner_http_detector_1 = require("./ner-http-detector");
const types_1 = require("./types");
const helper_1 = require("./helper");
// dslim/bert-large-NER outputs: PER, ORG, LOC, MISC
const LABEL_MAP = {
    PER: types_1.PiiType.NAME,
    ORG: types_1.PiiType.ORG,
    LOC: types_1.PiiType.LOCATION,
};
class BertNerDetector extends ner_http_detector_1.NerHttpDetector {
    constructor() {
        super(...arguments);
        this.path = '/bert';
    }
    mapLabel(label) {
        return LABEL_MAP[label] ?? null;
    }
    async collectMatches(text) {
        const matches = await super.collectMatches(text);
        return (0, helper_1.selectNonOverlapping)(matches);
    }
    getName() {
        return 'NER (BERT)';
    }
}
exports.BertNerDetector = BertNerDetector;
