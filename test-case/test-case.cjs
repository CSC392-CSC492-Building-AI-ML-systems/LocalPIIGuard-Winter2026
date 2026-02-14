// ner-detector-cli.cjs
const { NerDetector } = require('../dist-electron/shared/ner-detector.js'); 
const { RegexDetector } = require('../dist-electron/shared/regex-detector.js');

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
    switch (parseInt(detectorType)) {
        case 1:
            detector = new RegexDetector();
            break;
        case 2:
            detector = new NerDetector();
            break;
        default:
            console.error("Unknown detector type:", detectorType);
            process.exit(1);
    }

    const results = [];
    for (const text of texts) {
        try {
            const r = await detector.collectMatches(text);
            results.push(r);
        } catch (err) {
            results.push({ error: err.message });
        }
    }

    console.log(JSON.stringify(results));
})();
