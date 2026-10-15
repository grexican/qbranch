// Library entry point: use middleout's engine from any agent runtime (VoltAgent, Quorum, ...), not only Claude Code.
export { createEngine, PLAN_DOC } from './engine.mjs';
export { loadConfig, projectRoot, DEFAULTS } from './config.mjs';
export { upsert as upsertStats, summarize as summarizeStats } from './stats.mjs';
