"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NerHttpDetector = void 0;
const NER_TIMEOUT_MS = Number(process.env.PII_NER_TIMEOUT_MS) || 60000;
/**
 * Read base URL lazily so that main.ts can update PII_NER_BASE after the
 * server starts (and set the dynamic port) before any scan is triggered.
 */
function nerBase() {
    return process.env.PII_NER_BASE ?? 'http://127.0.0.1:5001';
}
/**
 * Base class for NER detectors backed by the persistent ner_server.py HTTP
 * server. Subclasses only need to declare the endpoint path and a label map.
 *
 * On any network/timeout error the method returns [] and logs a warning so
 * that the pipeline degrades gracefully (e.g. while the server is restarting).
 */
class NerHttpDetector {
    async collectMatches(text) {
        if (!text.trim())
            return [];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), NER_TIMEOUT_MS);
        try {
            const res = await fetch(`${nerBase()}${this.path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                console.warn(`[${this.getName()}] NER server returned HTTP ${res.status}`);
                return [];
            }
            const entities = (await res.json());
            return entities.reduce((acc, entity) => {
                const mapped = this.mapLabel(entity.label);
                if (!mapped)
                    return acc;
                acc.push({
                    type: mapped,
                    start: entity.start,
                    end: entity.end,
                    value: entity.text,
                    source: this.getName(),
                    score: entity.score ?? undefined,
                });
                return acc;
            }, []);
        }
        catch (err) {
            clearTimeout(timeoutId);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[${this.getName()}] request failed (server may be starting): ${msg}`);
            return [];
        }
    }
}
exports.NerHttpDetector = NerHttpDetector;
