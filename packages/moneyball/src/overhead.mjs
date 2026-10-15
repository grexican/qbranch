// The startup tax: what every session and every subagent pays before it does any work (system prompt, instruction
// files, skills listing, MCP tool schemas, memory). Measured from transcripts, attributed to components with cheap
// one-turn probes, and listed statically from disk (no spend).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessions, costOf, modelId, readJson, parseFrontmatter } from '@qbranch/core';

export const tok = (s) => Math.ceil((s || '').length / 4); // ~4 chars per token: estimates only, labelled as such
const promptTokens = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const MCP_TOOL = /^mcp__(.+?)__/; // MCP tool names are mcp__<server>__<tool>; calls per server judge "unused"
const dist = (xs) => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9), mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0 });

// ---------- 1. measure (transcripts) ----------
/**
 * Startup cost of a session = its first request's prompt (input + cache write + cache read: the whole fixed prompt,
 * whichever way it was billed), minus the first user message (the task itself, estimated). Priced at that request's
 * own rates. Total spend covers every request in the window, so share = tax / everything. Also counts MCP tool calls
 * per server, which is what marks a server as unused.
 */
export function measureOverhead({ root, days = 30 }) {
  const rows = [], mcpCalls = {}; let totalUsd = 0;
  for (const s of sessions({ root, days })) {
    let first = null, firstText = null;
    for (const e of s.events()) {
      if (e.t === 'user' && firstText === null) firstText = e.text;
      const mm = e.t === 'tool' && MCP_TOOL.exec(e.name); if (mm) mcpCalls[mm[1]] = (mcpCalls[mm[1]] || 0) + 1;
      if (e.t === 'usage') { first ??= e; totalUsd += costOf(e.model, e.usage); }
    }
    if (!first) continue;
    const u = first.usage, all = promptTokens(u);
    const fixed = Math.max(0, all - tok(firstText));
    const inUsd = costOf(first.model, { input_tokens: u.input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens });
    rows.push({ kind: s.kind, model: modelId(first.model), tokens: fixed, usd: all ? inUsd * fixed / all : 0 });
  }
  const pick = (k) => rows.filter(r => r.kind === k);
  const byModel = {};
  for (const r of rows) (byModel[r.model] ||= []).push(r.tokens);
  const startupUsd = rows.reduce((a, r) => a + r.usd, 0);
  return {
    days, sessions: dist(pick('main').map(r => r.tokens)), subagents: dist(pick('subagent').map(r => r.tokens)),
    byModel: Object.fromEntries(Object.entries(byModel).map(([m, xs]) => [m, dist(xs)])),
    startupUsd, totalUsd, share: totalUsd ? startupUsd / totalUsd : 0, mcpCalls,
  };
}

// ---------- 2a. static contributors (no spend) ----------
const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const home = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Instruction files Claude Code auto-loads: CLAUDE.md up the tree, CLAUDE.local.md, user CLAUDE.md, and their @imports. */
export function instructionFiles(root) {
  const out = [], seen = new Set();
  const add = (file, kind, depth = 0) => {
    const f = path.resolve(file);
    if (seen.has(f) || !exists(f)?.isFile()) return;
    seen.add(f); const text = read(f);
    out.push({ kind, path: f, tokens: tok(text) });
    if (depth >= 4) return;
    for (const m of text.matchAll(/(?:^|\s)@((?:~[\\/]|\.{1,2}[\\/]|[\w-])[^\s`]*)/gm)) {
      const p = m[1].replace(/^~(?=[\\/])/, os.homedir());
      add(path.resolve(path.dirname(f), p), 'import', depth + 1);
    }
  };
  for (let d = path.resolve(root); ; d = path.dirname(d)) {
    for (const n of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) add(path.join(d, n), d === path.resolve(root) ? 'project' : 'ancestor');
    if (path.dirname(d) === d) break;
  }
  add(path.join(home(), 'CLAUDE.md'), 'user');
  return out;
}

const walk = (dir, test, acc = []) => {
  for (const e of (exists(dir)?.isDirectory() ? fs.readdirSync(dir, { withFileTypes: true }) : [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, acc); else if (test(p)) acc.push(p);
  }
  return acc;
};
// What a listing shows per entry: name + description (skills, commands, agents)
const listingTokens = (file) => { const { meta } = parseFrontmatter(read(file)); return tok(`- ${meta.name || path.basename(file)}: ${meta.description || ''}`); };

function enabledPlugins(root) {
  const on = {};
  for (const f of [path.join(home(), 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]) Object.assign(on, readJson(f, {}).enabledPlugins || {});
  const installed = readJson(path.join(home(), 'plugins', 'installed_plugins.json'), {}).plugins || {};
  return Object.entries(on).filter(([, v]) => v).map(([id]) => {
    const inst = (installed[id] || []).find(i => !i.projectPath || path.resolve(i.projectPath) === path.resolve(root)) || (installed[id] || [])[0];
    return { id, dir: inst?.installPath };
  });
}

/** MCP servers configured for this project: .mcp.json plus the user/project entries in ~/.claude.json. */
export function mcpServers(root) {
  const servers = {};
  for (const n of Object.keys(readJson(path.join(root, '.mcp.json'), {}).mcpServers || {})) servers[n] = '.mcp.json';
  const user = readJson(process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'), {});
  for (const n of Object.keys(user.mcpServers || {})) servers[n] ??= 'user';
  const proj = Object.entries(user.projects || {}).find(([p]) => path.resolve(p) === path.resolve(root))?.[1];
  for (const n of Object.keys(proj?.mcpServers || {})) servers[n] ??= 'local';
  return servers;
}

export const mcpKey = (name) => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** Everything on disk that feeds the startup prompt, with estimated tokens. Spends nothing. */
export function staticContributors(root, usage = null) {
  const rows = instructionFiles(root).map(f => ({ ...f, label: f.path }));
  for (const [kind, dir] of [['rules', path.join(root, '.claude', 'rules')], ['rules', path.join(home(), 'rules')]]) {
    for (const f of walk(dir, p => p.endsWith('.md'))) rows.push({ kind, label: f, tokens: tok(read(f)) });
  }
  const listing = (kind, label, files) => files.length && rows.push({ kind, label, count: files.length, tokens: files.reduce((a, f) => a + listingTokens(f), 0) });
  const skillFiles = (d) => walk(d, p => path.basename(p) === 'SKILL.md');
  const mdFiles = (d) => walk(d, p => p.endsWith('.md'));
  listing('skills', path.join(root, '.claude', 'skills'), skillFiles(path.join(root, '.claude', 'skills')));
  listing('skills', path.join(home(), 'skills'), skillFiles(path.join(home(), 'skills')));
  listing('commands', path.join(root, '.claude', 'commands'), mdFiles(path.join(root, '.claude', 'commands')));
  listing('commands', path.join(home(), 'commands'), mdFiles(path.join(home(), 'commands')));
  listing('agents', path.join(root, '.claude', 'agents'), mdFiles(path.join(root, '.claude', 'agents')));
  listing('agents', path.join(home(), 'agents'), mdFiles(path.join(home(), 'agents')));
  for (const p of enabledPlugins(root)) {
    if (!p.dir || !exists(p.dir)) { rows.push({ kind: 'plugin', label: `${p.id} (enabled, not installed)`, tokens: 0 }); continue; }
    // plugin.json may relocate components ("skills": "./.claude/skills/"); default to the conventional folders
    const manifest = readJson(path.join(p.dir, '.claude-plugin', 'plugin.json'), {});
    const dirs = (k) => [manifest[k] ?? k].flat().map(d => path.join(p.dir, d));
    const files = [...dirs('skills').flatMap(skillFiles), ...dirs('commands').flatMap(mdFiles), ...dirs('agents').flatMap(mdFiles)];
    rows.push({ kind: 'plugin', label: p.id, count: files.length, tokens: files.reduce((a, f) => a + listingTokens(f), 0) });
  }
  const configured = mcpServers(root);
  for (const [name, from] of Object.entries(configured)) {
    rows.push({ kind: 'mcp', label: `${name} (${from})`, server: name, tokens: null, calls: usage ? usage[mcpKey(name)] || 0 : undefined });
  }
  // servers that only show up in transcripts (connectors, plugin-provided servers): schema size needs a probe
  const known = new Set(Object.keys(configured).map(mcpKey));
  for (const [key, calls] of Object.entries(usage || {})) if (!known.has(key)) rows.push({ kind: 'mcp', label: `${key} (seen in transcripts)`, server: key, tokens: null, calls });
  return rows;
}

// ---------- 2b. probes (spend, opt-in) ----------
// One-turn `claude -p` runs that toggle one component at a time; the difference in prompt tokens is that component.
// Probes run in a sandbox that holds copies of the project's startup files only (never the live tree), so instruction
// files can be removed without touching anything real. Ancestor CLAUDE.md files are not in the sandbox: they are
// covered by the static listing.
const STARTUP = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', ...['CLAUDE.md', 'settings.json', 'settings.local.json', 'rules', 'skills', 'commands', 'agents', 'output-styles'].map(n => path.join('.claude', n))];
const INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md'), path.join('.claude', 'rules')];

export function sandbox(root, { instructions = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyball-probe-'));
  const copy = (rel) => { const src = path.join(root, rel); if (exists(src)) fs.cpSync(src, path.join(dir, rel), { recursive: true }); };
  for (const rel of STARTUP) if (instructions || !INSTRUCTIONS.includes(rel)) copy(rel);
  // @imported files that live inside the project come along, so the instruction file resolves the same way
  if (instructions) for (const f of instructionFiles(root)) {
    const rel = path.relative(root, f.path);
    if (f.kind === 'import' && !rel.startsWith('..') && !path.isAbsolute(rel)) copy(rel);
  }
  return dir;
}

export function probeSet(root) {
  const off = Object.fromEntries(enabledPlugins(root).map(p => [p.id, false]));
  const NO_MCP = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return [
    { id: 'full', label: 'everything (sandboxed project)' },
    { id: 'instructions', label: 'project instruction files (CLAUDE.md, rules, imports)', instructions: false },
    { id: 'mcp', label: 'MCP tool schemas', args: NO_MCP },
    { id: 'skills', label: 'skills + slash commands listing', args: ['--disable-slash-commands'] },
    { id: 'plugins', label: 'enabled plugins', settings: { enabledPlugins: off } },
    { id: 'hooks', label: 'hook-injected context', settings: { disableAllHooks: true } },
    { id: 'user', label: 'user-level settings (user plugins, user MCP, user hooks)', args: ['--setting-sources', 'project,local'] },
    { id: 'floor', label: 'all of the above off: system prompt + built-in tools', instructions: false,
      args: [...NO_MCP, '--disable-slash-commands', '--setting-sources', 'project,local'], settings: { enabledPlugins: off, disableAllHooks: true } },
  ];
}

/** Default runner: one `claude -p` turn, JSON out, no session written. Returns the parsed result. */
export function claudeProbe(args, cwd, input = null) {
  const opts = { cwd, encoding: 'utf8', timeout: 180_000, windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input == null ? {} : { input }) };
  let out;
  try { out = execFileSync('claude', args, opts); }
  catch (e) {
    // npm installs on Windows ship claude.cmd, which only runs through a shell (and then needs quoted args)
    if (e.code !== 'ENOENT' || process.platform !== 'win32') throw e;
    out = execFileSync('claude.cmd', args.map(a => (/[\s"{}&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)), { ...opts, shell: true });
  }
  // the result is the last JSON line; the CLI may print warnings (themselves JSON-ish) before it
  return JSON.parse(out.trim().split('\n').reverse().find(l => l.startsWith('{')) || '{}');
}

/**
 * Run the probes within a hard budget and difference them against `full`. Stops before a probe that would likely
 * overrun the budget (estimated from the dearest probe so far). run(args, cwd) is injectable for tests.
 */
export async function attribute(root, { budget, model = 'haiku', run = claudeProbe, probes = probeSet(root) } = {}) {
  if (!(budget > 0)) throw new Error('probes spend money: pass --budget <usd>');
  const results = {}; let spent = 0, dearest = 0;
  for (const p of probes) {
    if (spent + Math.max(dearest, 0.01) > budget) { results[p.id] = { skipped: 'budget' }; continue; }
    const dir = sandbox(root, { instructions: p.instructions !== false });
    try {
      const args = ['-p', 'Reply with just OK. Do not use any tools.', '--output-format', 'json', '--model', model, '--no-session-persistence',
        '--max-budget-usd', (budget - spent).toFixed(4), ...(p.args || []), ...(p.settings ? ['--settings', JSON.stringify(p.settings)] : [])];
      const r = await run(args, dir);
      const u = r.usage?.iterations?.[0] || r.usage || {};
      const cost = Number(r.total_cost_usd) || 0;
      spent += cost; dearest = Math.max(dearest, cost);
      if (r.is_error || !promptTokens(u)) throw new Error(`probe failed: ${String(r.result || r.subtype || 'no usage in output').slice(0, 120)}`);
      results[p.id] = { tokens: promptTokens(u), cost };
    } catch (e) { results[p.id] = { error: String(e.message || e).slice(0, 200) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const full = results.full?.tokens;
  const parts = probes.filter(p => p.id !== 'full').map(p => {
    const r = results[p.id];
    const tokens = full != null && r?.tokens != null ? (p.id === 'floor' ? r.tokens : full - r.tokens) : null;
    return { id: p.id, label: p.label, tokens, ...(r?.skipped || r?.error ? { note: r.skipped || r.error } : {}) };
  });
  return { model, full: full ?? null, parts, spent };
}
