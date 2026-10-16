// Verify that benchmark runs are isolated from the user's own Claude Code setup.
//   node bench/headjack/src/verify-isolation.mjs --model haiku --auth-from-home
// For the none, native (25 skills) and headjack arms, one run through src/tap.mjs; on the request the model received:
//   - no text from the user's ~/.claude/CLAUDE.md (compared locally; nothing of it is stored),
//   - the skill listing holds only Claude Code's built-ins plus the arm's own skills (no ~/.claude/skills, no plugins),
//   - no MCP tools,
//   - no new transcript under ~/.claude/projects (runs write to their temp CLAUDE_CONFIG_DIR).
// Writes results/isolation-<agent>-<model>.json with booleans and counts only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESULTS } from './paths.mjs';
import { agent as getAgent } from './agents/index.mjs';
import { fetchFiller, RESERVED } from './filler.mjs';
import { composeLibrary, materialize } from './library.mjs';
import { armTemplate } from './arms.mjs';
import { makeSandbox } from '../../../packages/core/src/replay.mjs';
import { startTap, requestText } from './tap.mjs';
import { parseListing } from './listing.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const model = opt('--model', 'haiku');
const adapter = getAgent(opt('--agent', 'claude'));
const authFromHome = argv.includes('--auth-from-home');

const userMd = (() => { try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'utf8'); } catch { return ''; } })();
const probes = userMd.split('\n').map(l => l.trim()).filter(l => l.length > 24).slice(0, 8);
const userSkills = (() => { try { return fs.readdirSync(path.join(os.homedir(), '.claude', 'skills')); } catch { return []; } })();
const projects = path.join(os.homedir(), '.claude', 'projects');
const projCount = () => { try { return fs.readdirSync(projects).filter(d => /hjbench|qbranch-replay/.test(d)).length; } catch { return 0; } };

const filler = await fetchFiller({});
const lib = composeLibrary({ shard: 1, size: 25, seed: 'hjbench-v1', filler });
const dir = materialize(lib, { shard: 1, size: 25, seed: 'hjbench-v1' });
const before = projCount();
const out = { agent: adapter.meta(), model, date: new Date().toISOString(), arms: {} };
for (const arm of ['none', 'native', 'headjack']) {
  const tpl = await armTemplate(arm, { libDir: arm === 'none' ? null : dir, key: arm === 'none' ? 'none' : 's1-n25' });
  const tap = await startTap();
  const sb = makeSandbox(tpl.dir, { mode: 'copy' });
  try {
    const r = await adapter.run({ prompt: 'Reply with OK.', dir: sb.dir, model, settings: tpl.settings(), env: { ...tpl.env(), ANTHROPIC_BASE_URL: tap.url }, authFromHome, timeoutMs: 180_000, budgetUsd: 0.5 });
    const body = tap.bodies.filter(b => (b.messages || []).length).pop();
    const text = body ? requestText(body) : '';
    const listed = [...parseListing(text).keys()];
    const allowed = new Set([...RESERVED, ...(arm === 'native' ? lib.map(s => s.name) : [])]);
    out.arms[arm] = {
      ran: r.ok, captured: !!body,
      userClaudeMdLeaked: probes.some(p => text.includes(p)),
      userSkillsListed: listed.filter(n => userSkills.includes(n) && !allowed.has(n)).length,
      unexpectedSkills: listed.filter(n => !allowed.has(n)),
      mcpTools: (body?.tools || []).filter(t => /^mcp__/.test(t.name)).length,
    };
  } finally { sb.cleanup(); await tap.close(); }
}
out.newTranscriptDirsUnderHome = projCount() - before;
out.isolated = Object.values(out.arms).every(a => a.ran && a.captured && !a.userClaudeMdLeaked && !a.userSkillsListed && !a.unexpectedSkills.length && !a.mcpTools) && out.newTranscriptDirsUnderHome === 0;
fs.mkdirSync(RESULTS, { recursive: true });
fs.writeFileSync(path.join(RESULTS, `isolation-${adapter.meta().agent}-${model}.json`), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
