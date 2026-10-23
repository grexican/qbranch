// groundhog.config.json at the project root (all keys optional).
import path from 'node:path';
import { projectRoot as coreRoot, readJson } from '@qbranch/core';

export const projectRoot = (start) => coreRoot(['groundhog.config.json', 'groundhog.lessons.json'], start);

export const DEFAULTS = {
  days: 30,
  minSessions: 5,      // a command shape run by hand in this many sessions is a script candidate
  minRecoveries: 3,    // the same error -> workaround seen this many times is a lesson candidate
  minSequence: 3,      // a multi-step sequence repeated in this many sessions is a runbook/script candidate
  guard: 'deny-once',  // accepted lessons on matching commands: off | remind | deny-once
  escapeGuard: 'auto', // inline scripts whose doubled backslashes Git Bash collapses: auto (Windows only) | on | off
  lessons: 'groundhog.lessons.json', // the ledger (commit it: it is the team's memory)
  stats: '.groundhog-stats.json',
};

export function loadConfig(root = projectRoot()) {
  const cfg = { ...DEFAULTS, ...readJson(path.join(root, 'groundhog.config.json')), root };
  cfg.dataDir = path.join(root, '.groundhog');
  if (process.env.GROUNDHOG_STATS === '0') cfg.stats = false;
  return cfg;
}
