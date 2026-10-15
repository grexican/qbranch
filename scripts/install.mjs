#!/usr/bin/env node
// Install the tools into a project for any agent platform, without a plugin marketplace. Idempotent: re-running
// replaces this script's own entries and leaves everything else in the config files alone. --uninstall removes them.
//
//   node scripts/install.mjs [tools...|all] --platform claude|cursor|codex|gemini|copilot|windsurf
//        [--project <dir>] [--runtime node|binary] [--bin <name>] [--uninstall] [--dry-run]
//
// Skills go to .claude/skills (Claude Code) or .agents/skills (read by Cursor, Codex, Gemini, Copilot, Windsurf).
// runtime node   : hooks run the bundles in this checkout (<package>/dist/<tool>.mjs) with node
// Each tool repo ships this script bundled as dist/install.mjs: `node dist/install.mjs --platform cursor --project .`
// runtime binary : hooks run the native multi-call binary (`<bin> <tool> ...`), for machines without Node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, PLATFORMS, hookEntries, mcpServers, renderHooks, renderMcp } from './platforms.mjs';

const MARK = '.utility-belt'; // marker file inside every skill folder we install

// The source is either the monorepo (packages/<tool>/...) or one tool's own repo (its root is the package).
const standalone = (source) => { try { return JSON.parse(fs.readFileSync(path.join(source, '.claude-plugin', 'plugin.json'), 'utf8')).name; } catch { return null; } };
const pkgDir = (source, tool) => (standalone(source) === tool ? source : path.join(source, 'packages', tool));

export function plan({ tools, platform, project, runtime = 'node', bin = 'belt', source }) {
  const skillsDir = path.join(project, platform === 'claude' ? '.claude/skills' : '.agents/skills');
  const notes = [];
  const cmdFor = (tool) => (args) => {
    if (runtime === 'binary') return { sh: `${bin} ${tool} ${args}`, ps: `${bin} ${tool} ${args}` };
    const f = path.join(pkgDir(source, tool), 'dist', `${tool}.mjs`).split(path.sep).join('/');
    return { sh: `node "${f}" ${args}`, ps: `node "${f}" ${args}` };
  };
  const mcpCmd = (tool) => (args) => (runtime === 'binary' ? { command: bin, args: [tool, ...args] }
    : { command: 'node', args: [path.join(pkgDir(source, tool), 'dist', `${tool}.mjs`).split(path.sep).join('/'), ...args] });

  const skills = [];
  const hookSets = [], mcpSets = [];
  for (const tool of tools) {
    const pkg = pkgDir(source, tool);
    for (const d of fs.readdirSync(path.join(pkg, 'skills'))) skills.push({ from: path.join(pkg, 'skills', d), to: path.join(skillsDir, d), tool });
    const h = renderHooks(platform, hookEntries(pkg), cmdFor(tool));
    if (h) hookSets.push({ tool, h });
    const m = renderMcp(platform, mcpServers(pkg), mcpCmd(tool));
    if (m) mcpSets.push({ tool, m });
  }
  return { skills, hookSets, mcpSets, notes, skillsDir };
}

const ours = (tool) => (s) => JSON.stringify(s).includes(`${tool}.mjs`) || new RegExp(`\\b${tool} hook\\b`).test(JSON.stringify(s));
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

/** Merge a rendered hooks object into an existing config's hooks (dropping our previous entries first). */
function mergeHooks(existing, tool, rendered, wrap) {
  const cur = existing.hooks || {};
  for (const ev of Object.keys(cur)) { cur[ev] = cur[ev].filter(e => !ours(tool)(e)); if (!cur[ev].length) delete cur[ev]; }
  if (rendered) for (const [ev, list] of Object.entries(rendered.hooks)) cur[ev] = [...(cur[ev] || []), ...list];
  existing.hooks = cur;
  if (wrap && rendered?.version) existing.version = rendered.version;
  return existing;
}

export function apply(p, { platform, project, tools, uninstall = false, dryRun = false }) {
  const log = [];
  const write = (f, obj) => { log.push(`write ${path.relative(project, f)}`); if (!dryRun) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n'); } };

  // skills
  for (const s of p.skills) {
    if (fs.existsSync(s.to) && !fs.existsSync(path.join(s.to, MARK))) { log.push(`skip ${path.relative(project, s.to)} (exists, not ours)`); continue; }
    if (!dryRun && fs.existsSync(s.to)) fs.rmSync(s.to, { recursive: true });
    if (uninstall) { log.push(`remove ${path.relative(project, s.to)}`); continue; }
    log.push(`copy skill ${path.relative(project, s.to)}`);
    if (!dryRun) { fs.cpSync(s.from, s.to, { recursive: true }); fs.writeFileSync(path.join(s.to, MARK), `installed by utility-belt (${s.tool})\n`); }
  }

  // hooks
  const hookFile = {
    claude: '.claude/settings.json', cursor: '.cursor/hooks.json', codex: '.codex/hooks.json',
    gemini: '.gemini/settings.json', windsurf: '.devin/hooks.json',
  }[platform];
  for (const tool of tools) {
    const set = p.hookSets.find(x => x.tool === tool);
    if (platform === 'copilot') {
      const f = path.join(project, '.github/hooks', `${tool}.json`);
      if (uninstall) { if (fs.existsSync(f)) { log.push(`remove ${path.relative(project, f)}`); if (!dryRun) fs.rmSync(f); } }
      else if (set) write(f, set.h);
      continue;
    }
    const f = path.join(project, hookFile);
    if (!set && !fs.existsSync(f)) continue;
    write(f, mergeHooks(readJ(f), tool, uninstall ? null : set?.h, platform === 'cursor'));
  }

  // MCP
  for (const { tool, m } of p.mcpSets) {
    if (platform === 'windsurf') { p.notes.push(`Windsurf MCP is user-global: add to mcp_config.json:\n${JSON.stringify(m, null, 2)}`); continue; }
    if (platform === 'codex') {
      const f = path.join(project, '.codex/config.toml');
      const begin = `# >>> utility-belt ${tool}`, end = `# <<< utility-belt ${tool}`;
      const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const stripped = cur.replace(new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`), '\n').replace(/^\n+/, '');
      write(f, uninstall ? stripped : `${stripped}${stripped && !stripped.endsWith('\n') ? '\n' : ''}${begin}\n${m.toml}${end}\n`);
      continue;
    }
    const f = path.join(project, { claude: '.mcp.json', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', copilot: '.mcp.json' }[platform]);
    const cur = readJ(f);
    cur.mcpServers ||= {};
    for (const [name, def] of Object.entries(m.mcpServers)) { if (uninstall) delete cur.mcpServers[name]; else cur.mcpServers[name] = def; }
    write(f, cur);
  }
  return log;
}

export async function main(argv = process.argv.slice(2), defaults = {}) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const valued = new Set(['--platform', '--project', '--runtime', '--bin', '--source']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const source = path.resolve(opt('--source', defaults.source || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const only = standalone(source);
  const tools = only ? [only] : !positional.length || positional.includes('all') ? TOOLS : positional;
  const platform = opt('--platform');
  if (!PLATFORMS.includes(platform)) throw new Error(`--platform must be one of: ${PLATFORMS.join(', ')}`);
  for (const t of tools) if (!TOOLS.includes(t)) throw new Error(`unknown tool ${t} (${TOOLS.join(', ')})`);
  const project = path.resolve(opt('--project', process.cwd()));
  const p = plan({ tools, platform, project, runtime: opt('--runtime', defaults.runtime || 'node'), bin: opt('--bin', defaults.bin || 'belt'), source });
  const log = apply(p, { platform, project, tools, uninstall: argv.includes('--uninstall'), dryRun: argv.includes('--dry-run') });
  console.log(`${argv.includes('--uninstall') ? 'uninstall' : 'install'} ${tools.join(', ')} for ${platform} in ${project}${argv.includes('--dry-run') ? ' (dry run)' : ''}`);
  for (const l of log) console.log(`  ${l}`);
  for (const n of p.notes) console.log(`\nnote: ${n}`);
  if (platform === 'cursor' && tools.includes('headjack')) console.log('\nnote: Cursor hooks cannot inject context at prompt time; headjack works there through its skills only.');
}

if (!globalThis.__BELT__ && import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`install: ${e.message}`); process.exitCode = 1; });
}
