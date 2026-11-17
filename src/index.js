// @ts-check
export { SPEC_VERSION, CLASSES, DECISIONS, DEFAULT_CONFIG, loadConfig, hashId, subjectKey, attributeCost, normalizeSignals, score } from './scoring.js';
export { decide, fallbackDecision } from './engine.js';
export { explain, REASON_TEXT } from './explain.js';
export { analyzeLines, analyzeFile, parseLine, uaClass, renderAudit } from './logAnalyzer.js';
export { newStats, arrive, complete, observe, behaviorOf, isErrorStatus, ASSET } from './features.js';
export { STORE_METHODS, assertStore } from './store/interface.js';
export { createMemoryStore } from './store/memory.js';
export { createPostgresStore } from './store/postgres.js';
