// moneyball.config.json at the project root (all keys optional).
import path from 'node:path';
import { projectRoot as coreRoot, readJson } from '@qbranch/core';

export const projectRoot = (start) => coreRoot(['moneyball.config.json'], start);

export const DEFAULTS = {
  mode: 'suggest',         // report (measure only) | suggest | enforce | explore
  minRuns: 10,             // evidence a cheaper tier needs before it is recommended
  bar: 0.9,                // success rate the cheaper tier must reach (UD's 18-of-20)
  margin: 0.05,            // ...and be no more than this below the bigger tier's own success rate
  exploreRate: 0.1,        // share of eligible dispatches routed one tier down in explore mode
  respectExplicit: true,   // never override a model the caller set explicitly (command/agent pins)
  days: 30,                // history window for scans
  stats: '.moneyball-stats.json',
};

export function loadConfig(root = projectRoot()) {
  const cfg = { ...DEFAULTS, ...readJson(path.join(root, 'moneyball.config.json')), root };
  cfg.dataDir = path.join(root, '.moneyball');
  if (process.env.MONEYBALL_STATS === '0') cfg.stats = false;
  if (process.env.MONEYBALL_MODE) cfg.mode = process.env.MONEYBALL_MODE;
  return cfg;
}

export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
export const cheaper = (tier) => TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
