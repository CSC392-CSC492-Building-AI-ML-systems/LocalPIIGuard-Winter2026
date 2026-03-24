// ner-detector-cli.cjs
const { RegexDetector } = require('../dist-electron/shared/regex-detector.js');
const { NerDetector } = require('../dist-electron/shared/ner-detector.js');
const { SpancatDetector } = require('../dist-electron/shared/spancat-detector.js');
const { PresidioDetector } = require('../dist-electron/shared/presidio-detector.js');
const { LlamaDetector } = require('../dist-electron/shared/llm-detector.js');
const { BertNerDetector } = require('../dist-electron/shared/bert-ner-detector.js');
const process = require('process');

const data = process.argv[2];   // JSON array of strings
const detectorType = process.argv[3]; // integer to select detector

if (!data || !detectorType) {
    console.error("Usage: node ner-detector-cli.cjs '<json array>' <detectorType>");
    process.exit(1);
}

(async () => {
    let texts;
    try {
        texts = JSON.parse(data);
        if (!Array.isArray(texts)) throw new Error("Expected an array of strings");
    } catch (err) {
        console.error("Invalid JSON input:", err.message);
        process.exit(1);
    }

    // Choose detector based on integer
    let detector;
    switch (parseInt(detectorType, 10)) {
        case 1:
            detector = new NerDetector();
            break;
        case 2:
            detector = new RegexDetector();
            break;
        case 3:
            detector = new SpancatDetector();
            break;
        case 4:
            detector = new PresidioDetector();
            break;
        case 5:
            detector = new LlamaDetector();
            break;
        case 6:
            detector = new BertNerDetector();
            break;
        default:
            console.error("Unknown detector type:", detectorType);
            process.exit(1);
    }

    const results = await Promise.all(
    texts.map(text =>
        detector.collectMatches(text).catch(err => ({ error: err.message }))
    )
    );


    console.log(JSON.stringify(results));
})();
