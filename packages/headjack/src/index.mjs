// Library entry point: use headjack's engine from any agent runtime (VoltAgent, Quorum, ...), not only Claude Code.
export { loadConfig, projectRoot, DEFAULTS } from './config.mjs';
export { reindex, search, isStrong, load, renderSkill, parseSkill, gapTerms } from './library.mjs';
export { searchRegistry, searchRegistryByGap, acquire } from './registry.mjs';
export { suggest } from './suggest.mjs';
export { upsert as upsertStats, summarize as summarizeStats } from './stats.mjs';
