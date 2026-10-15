// Project root + config. Two library spaces:
//   shared   <project>/.headjack/library   committed with the repo: the team's skills
//   personal ~/.headjack/library            yours, in every project
// Plus extra sources indexed in place (never moved): team ones in headjack.config.json, personal ones in ~/.headjack/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot as coreRoot, expandPath as expand, readJson } from '@qbranch/core';

export const projectRoot = (start) => coreRoot(['headjack.config.json'], start);
export const homeDir = () => process.env.HEADJACK_HOME || path.join(os.homedir(), '.headjack');

export const DEFAULTS = {
  sources: [],          // extra directories indexed in place (scanned recursively for SKILL.md)
  strong: 0.35,         // cosine similarity a top-3 hit needs to count as a strong match
  suggestMax: 4,        // max skills the hook names per prompt
  external: true,       // fall through to the public registry (skills.sh) when nothing local is strong
  stats: '.headjack-stats.json', // usage stats file at the project root; false disables
};

export const configFile = (scope, root) => (scope === 'personal' ? path.join(homeDir(), 'config.json') : path.join(root, 'headjack.config.json'));

export function loadConfig(root = projectRoot()) {
  const personal = readJson(configFile('personal', root));
  const shared = readJson(configFile('shared', root));
  const cfg = { ...DEFAULTS, ...personal, ...shared, root };
  cfg.dataDir = path.join(root, '.headjack');
  cfg.sharedDir = path.join(root, '.headjack', 'library');
  cfg.personalDir = path.join(homeDir(), 'library');
  cfg.libraryDir = cfg.sharedDir; // default destination
  cfg.sourceDirs = [
    { dir: cfg.sharedDir, label: 'shared', scope: 'shared' },
    { dir: cfg.personalDir, label: 'personal', scope: 'personal' },
    ...(shared.sources || []).map(s => ({ dir: expand(s, root), label: path.basename(s), scope: 'shared' })),
    ...(personal.sources || []).map(s => ({ dir: expand(s, homeDir()), label: path.basename(s), scope: 'personal' })),
  ];
  if (process.env.HEADJACK_STATS === '0') cfg.stats = false;
  return cfg;
}

/** Add or remove an in-place source in the shared (project) or personal config file. */
export function editSources(cfg, scope, dir, remove = false) {
  const f = configFile(scope, cfg.root);
  const j = readJson(f);
  const abs = path.resolve(dir);
  const val = scope === 'shared' && abs.startsWith(cfg.root) ? path.relative(cfg.root, abs).replace(/\\/g, '/') : abs;
  j.sources = (j.sources || []).filter(s => expand(s, scope === 'personal' ? homeDir() : cfg.root) !== abs);
  if (!remove) j.sources.push(val);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  return { file: f, sources: j.sources };
}
