// @qbranch/core: shared plumbing for every tool in Q Branch.
export { projectRoot, expandPath, readJson, readStdin, selfCommand } from './project.mjs';
export { createStats, readStats, today } from './stats.mjs';
export { parseFrontmatter, renderFrontmatter } from './frontmatter.mjs';
export { embed, cosine, toBlob, fromBlob } from './embed.mjs';
export { sessions, registerReader, costOf, tierOf, modelId, PRICES } from './transcripts.mjs';
export { runHook, normalize, render, detectPlatform } from './hooks.mjs';
export { binaryNote, cmpVersion, installCommand, qbranchHome, VERSION } from './binary.mjs';
