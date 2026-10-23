// The routing hook. PreToolUse on the subagent tool: look the dispatch up in the routes table that `moneyball scan`
// writes, then (by mode) say nothing, suggest, rewrite the model, or route a share of mechanical work one tier down
// so the cheaper tier earns its evidence. Lexical lookup only: the hook must stay fast.
// SessionStart: kick off a background incremental scan when the last one is stale.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, selfCommand } from '@qbranch/core';
import { lexKey } from './store.mjs';
import { upsert } from './stats.mjs';

const SUBAGENT_TOOLS = /^(Agent|Task)$/;
const SEEN_CAP = 50; // class keys tracked in stats.seen
const routesFile = (cfg) => path.join(cfg.dataDir, 'routes.json');

export function writeRoutes(cfg, routes) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(routesFile(cfg), JSON.stringify({ updated: new Date().toISOString(), routes }, null, 2));
}

export function preToolUse(cfg, h, rand = Math.random) {
  if (!SUBAGENT_TOOLS.test(h.tool) || cfg.mode === 'off') return null; // off means off: no routing, no stats writes
  const input = h.input || {};
  const explicit = !!input.model;
  const key = lexKey(input.subagent_type || 'general-purpose', input.description || '');
  const r = readJson(routesFile(cfg), { routes: {} }).routes[key];
  // why: the reason this dispatch was (or was not) acted on, so "0 suggestions" is explained instead of guessed at
  let decision = null, kind = null, why;
  if (!r) why = 'no_class';
  else if (explicit && cfg.respectExplicit) why = 'explicit_pinned';
  else if (cfg.mode === 'report') why = 'mode_report';
  else if (r.action === 'graduate' && cfg.mode === 'suggest') {
    kind = 'suggest';
    decision = { context: `moneyball: "${input.description}" is a measured task class that succeeds on ${r.to} (graduated from ${r.from}). Prefer model "${r.to}" for this dispatch.` };
  } else if (r.action === 'graduate' && (cfg.mode === 'enforce' || cfg.mode === 'explore')) {
    kind = 'rewrite';
    decision = { updatedInput: { ...input, model: r.to } };
  } else if (r.action === 'explore' && cfg.mode !== 'explore') why = 'explore_needs_explore_mode';
  else if (r.action === 'explore' && rand() < cfg.exploreRate) {
    kind = 'explore';
    decision = { updatedInput: { ...input, model: r.to } };
  } else why = r.action === 'explore' ? 'explore_not_sampled' : 'mode_unknown';
  why ??= 'acted';
  upsert(cfg, (s, day) => {
    s.totals.dispatches_seen++; day.dispatches++;
    if (explicit) s.totals.explicit_model++;
    if (r) s.totals.matched_class++;
    if (kind === 'suggest') s.totals.suggestions++;
    if (kind === 'rewrite') { s.totals.rewrites++; day.rewrites++; }
    if (kind === 'explore') { s.totals.explored++; day.explored++; }
    s.skips[why] = (s.skips[why] || 0) + 1;
    if (s.seen[key] || Object.keys(s.seen).length < SEEN_CAP) {
      const k = (s.seen[key] ??= { n: 0, action: null, to: null, why: {} });
      k.n++; k.why[why] = (k.why[why] || 0) + 1;
      k.action = r?.action ?? null; k.to = r?.to ?? null;
    }
  });
  return decision;
}

const STALE_MS = 6 * 3600e3;
export async function sessionStart(cfg, script, now = Date.now()) {
  const last = readJson(routesFile(cfg), {}).updated;
  if (last && now - Date.parse(last) < STALE_MS) return null;
  try {
    const [file, pre] = await selfCommand('moneyball', script);
    spawn(file, [...pre, 'scan', '--quiet'], { cwd: cfg.root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* scanning is best-effort */ }
  return null;
}
