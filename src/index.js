export { createEngine } from './engine.js';
export { createHttpServer } from './http/server.js';
export { normalizeConfig, DEFAULTS } from './config.js';
export { openDatabase, migrate, SCHEMA_VERSION, schemaInfo } from './db/database.js';
export { gateContent, CONTENT_CLASSES, DEFAULT_MATRIX } from './core/gate.js';
export {
  deriveSignals, scoreFromSignals, blendScore, tierFromScore, applyDecay, TIERS, atLeastTier,
} from './core/relationship.js';
export { encodeHeuristic, detectContentClass } from './core/encoder.js';
export { rankMemories, renderMemories, sensitivityAllows } from './core/recall.js';
export { EmbeddingProvider } from './core/embedding.js';
export {
  tokenize, keywordScore, cosine, clamp01, logScale, daysBetween,
} from './util/misc.js';
