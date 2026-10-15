#!/usr/bin/env node
// headjack CLI. Agents use `find` and `get` (through the find-skill / load-skill root skills); humans build the library.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, editSources } from '../src/config.mjs';
import { db, reindex, search, isStrong, load, renderSkill, wasSuggested, parseSkill } from '../src/library.mjs';
import { searchRegistry, searchRegistryByGap, acquire } from '../src/registry.mjs';
import { upsert, skillStat, summarize } from '../src/stats.mjs';
import { suggest } from '../src/suggest.mjs';
import { record, history, origin, sourceOf, skillHash } from '../src/ledger.mjs';
import { runHook } from '@qbranch/core/hooks';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => { const i = rest.indexOf(f); if (i < 0) return false; rest.splice(i, 1); return true; };
const opt = (f, d) => { const i = rest.indexOf(f); if (i < 0) return d; const v = rest[i + 1]; rest.splice(i, 2); return v; };
const cfg = loadConfig();
const ROOT_SKILLS = new Set(['find-skill', 'load-skill']);
const rel = (p) => (p.startsWith(cfg.root) ? path.relative(cfg.root, p) : p.replace(os.homedir(), '~'));
const spaceDir = (space) => (space === 'personal' ? cfg.personalDir : cfg.sharedDir);

const HELP = `headjack: skills, loaded the moment you need them ("I know kung fu.")

Two library spaces. Neither is preloaded; both are indexed and searched on demand:
  shared    .headjack/library in this repo (commit it: the team's skills)
  personal  ~/.headjack/library (yours, in every project)

Build the library
  headjack init                          set up .headjack/ in this project
  headjack adopt [--from project|user|<dir>] [--to shared|personal] [--dry-run]
                                         move existing preloaded skills into a library space
                                         (default: project .claude/skills -> shared, ~/.claude/skills -> personal)
  headjack add <dir | owner/repo/skill> [--personal]   add one skill (copy a folder, or fetch from GitHub)
  headjack new <name> [--personal]       scaffold a new skill
  headjack bundle <name> <skill> <skill>...  one trigger, an ordered set of skills (--description, --personal)
  headjack move <id> --to shared|personal   promote a personal skill to the team, or take one back
  headjack source add|remove <dir> [--personal]   index a folder in place (never moved), e.g. a team skills repo
  headjack source list
  headjack list                          everything in the library, by space
  headjack history [<name>] [--json]     every skill that entered or left the library, from where (the ledger)
  headjack release <id>... | --all [--to origin|project|user|<dir>] [--dry-run]
                                         move skills back out, by default to exactly where they came from
  headjack index                         rebuild the index

Use it (agents do this through the root skills and the hook)
  headjack find <what you need>          search; falls through to the public registry when nothing is strong
  headjack find --external <terms>       search the public registry (skills.sh) directly
  headjack get <id>                      load a skill
  headjack get --acquire <owner/repo/skill> [--personal]   fetch a registry skill into the library, then load it

Measure it
  headjack stats [--json]                usage + efficacy (from .headjack-stats.json)

Plumbing
  headjack hook                          UserPromptSubmit hook (hook JSON on stdin; --platform to force a shape)
  headjack mcp                           MCP server (headjack_find / headjack_get / headjack_acquire)`;

function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) throw new Error(`${rel(to)} already exists`);
  try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); } // cross-device
}

async function main() {
  switch (cmd) {
    case 'init': {
      fs.mkdirSync(cfg.sharedDir, { recursive: true });
      fs.mkdirSync(cfg.personalDir, { recursive: true });
      const gi = path.join(cfg.dataDir, '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'index.db*\n');
      const r = await reindex(cfg);
      const preloaded = fs.existsSync(path.join(cfg.root, '.claude/skills')) ? fs.readdirSync(path.join(cfg.root, '.claude/skills')).filter(n => !ROOT_SKILLS.has(n)).length : 0;
      return console.log(`headjack ready in ${cfg.root}\n  shared library:   ${rel(cfg.sharedDir)}\n  personal library: ${rel(cfg.personalDir)}\n  indexed: ${r.total} skills\n  stats:   ${cfg.stats || 'off'}` +
        (preloaded ? `\n\n${preloaded} skills are still preloaded from .claude/skills. Move them in with: headjack adopt` : ''));
    }

    case 'adopt': {
      const dry = flag('--dry-run');
      const fromArg = opt('--from', 'project');
      const from = fromArg === 'project' ? path.join(cfg.root, '.claude', 'skills') : fromArg === 'user' ? path.join(os.homedir(), '.claude', 'skills') : path.resolve(fromArg);
      const to = opt('--to', fromArg === 'user' ? 'personal' : 'shared');
      if (!fs.existsSync(from)) return console.log(`nothing to adopt: ${rel(from)} does not exist`);
      const moved = [];
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (!e.isDirectory() || ROOT_SKILLS.has(e.name) || !fs.existsSync(path.join(from, e.name, 'SKILL.md'))) continue;
        moved.push(e.name);
        if (dry) continue;
        const src = path.join(from, e.name), dest = path.join(spaceDir(to), e.name);
        const hash = skillHash(src), source = sourceOf(src, `path:${src}`);
        moveDir(src, dest);
        record(cfg, to, { action: 'adopt', name: e.name, from: src, to: dest, source, hash });
      }
      if (!dry) await reindex(cfg);
      return console.log(`${dry ? 'would move' : 'moved'} ${moved.length} skills from ${rel(from)} to the ${to} library (${rel(spaceDir(to))})${moved.length ? ':\n  ' + moved.join('\n  ') : ''}`);
    }

    case 'add': {
      const personal = flag('--personal'); const src = rest[0];
      if (!src) return console.log('usage: headjack add <dir | owner/repo/skill> [--personal]');
      if (fs.existsSync(src)) {
        const parsed = parseSkill(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'));
        if (!parsed) throw new Error(`${src}/SKILL.md has no name/description frontmatter`);
        const dest = path.join(spaceDir(personal ? 'personal' : 'shared'), parsed.name);
        if (fs.existsSync(dest)) throw new Error(`${rel(dest)} already exists`);
        fs.cpSync(src, dest, { recursive: true });
        record(cfg, personal ? 'personal' : 'shared', { action: 'add', name: parsed.name, from: path.resolve(src), to: dest, source: sourceOf(src, `path:${path.resolve(src)}`), hash: skillHash(dest) });
        await reindex(cfg);
        return console.log(`added ${personal ? 'personal' : 'shared'}/${parsed.name} -> ${rel(dest)}`);
      }
      const s = await acquire(cfg, src, { dest: spaceDir(personal ? 'personal' : 'shared') });
      return console.log(s.error || `added ${s.id} -> ${rel(s.dir)}\nIt came from a public registry: read it (and any scripts) before relying on it.`);
    }

    case 'new': {
      const personal = flag('--personal'); const name = rest[0];
      if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return console.log('usage: headjack new <kebab-case-name> [--personal]');
      const dir = path.join(spaceDir(personal ? 'personal' : 'shared'), name);
      if (fs.existsSync(dir)) throw new Error(`${rel(dir)} already exists`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: <What this skill does, then "Use when ..." with the words a request would contain. This line is what search matches on.>\n---\n\n# ${name}\n\n<Instructions the agent follows when this skill is loaded.>\n`);
      record(cfg, personal ? 'personal' : 'shared', { action: 'new', name, to: dir, source: 'scaffold', hash: skillHash(dir) });
      return console.log(`created ${rel(path.join(dir, 'SKILL.md'))}: fill in the description (it drives search) and the instructions`);
    }

    case 'bundle': {
      const personal = flag('--personal'); const desc = opt('--description');
      const [name, ...members] = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--description');
      if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || members.length < 2)
        return console.log('usage: headjack bundle <kebab-case-name> <skill> <skill> [...] [--description "..."] [--personal]');
      await reindex(cfg);
      const missing = members.filter(m => load(cfg, m).error);
      if (missing.length) throw new Error(`not in the library: ${missing.join(', ')} (headjack list)`);
      const dir = path.join(spaceDir(personal ? 'personal' : 'shared'), name);
      if (fs.existsSync(dir)) throw new Error(`${rel(dir)} already exists`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc || `<What this bundle does, then "Use when ..." with the words a request would contain.>`}\nbundle: ${members.join(', ')}\n---\n\n# ${name}\n\nLoads ${members.length} skills in order: ${members.join(' → ')}. <How they fit together: when to move from one to the next.>\n`);
      record(cfg, personal ? 'personal' : 'shared', { action: 'bundle', name, to: dir, source: `bundle:${members.join(',')}`, hash: skillHash(dir) });
      return console.log(`created ${rel(path.join(dir, 'SKILL.md'))}: ${members.join(' → ')}${desc ? '' : '. Fill in the description (it drives search).'}`);
    }

    case 'move': {
      const to = opt('--to'); const id = rest[0];
      if (!id || !['shared', 'personal'].includes(to)) return console.log('usage: headjack move <id> --to shared|personal');
      await reindex(cfg);
      const s = load(cfg, id);
      if (s.error) throw new Error(s.error);
      const dest = path.join(spaceDir(to), path.basename(s.dir));
      const fromSpace = s.source;
      moveDir(s.dir, dest);
      record(cfg, fromSpace, { action: 'move-out', name: s.name, from: s.dir, to: dest, hash: skillHash(dest) });
      record(cfg, to, { action: 'move-in', name: s.name, from: s.dir, to: dest, source: (origin(cfg, fromSpace, s.name) && `path:${origin(cfg, fromSpace, s.name).dir}`) || `space:${fromSpace}`, hash: skillHash(dest) });
      await reindex(cfg);
      return console.log(`moved ${s.id} -> ${to}/${s.name} (${rel(dest)})`);
    }

    case 'release': {
      // The exit door: move skills out of the library back to where agents preload them. By default each one goes back
      // to the exact folder it was adopted from (per the ledger); --to project|user|<dir> overrides.
      const dry = flag('--dry-run'); const all = flag('--all'); const toArg = opt('--to', 'origin');
      await reindex(cfg);
      const rows = all ? db(cfg).prepare("select id from skills where source in ('shared', 'personal')").all().map(r => r.id) : rest;
      if (!rows.length) return console.log('usage: headjack release <id>... | --all  [--to origin|project|user|<dir>] [--dry-run]');
      const out = [];
      for (const ref of rows) {
        const s = load(cfg, ref);
        if (s.error) { out.push(`skip ${ref}: ${s.error}`); continue; }
        if (!['shared', 'personal'].includes(s.source)) { out.push(`skip ${s.id}: indexed in place from a source folder (nothing to move; headjack source remove it instead)`); continue; }
        const o = origin(cfg, s.source, s.name);
        const base = toArg === 'origin' ? (o ? path.dirname(o.dir) : path.join(s.source === 'personal' ? os.homedir() : cfg.root, '.claude', 'skills'))
          : toArg === 'project' ? path.join(cfg.root, '.claude', 'skills') : toArg === 'user' ? path.join(os.homedir(), '.claude', 'skills') : path.resolve(toArg);
        const dest = path.join(base, path.basename(s.dir));
        if (fs.existsSync(dest)) { out.push(`skip ${s.id}: ${rel(dest)} already exists`); continue; }
        const edited = o?.hash && o.hash !== skillHash(s.dir) ? ' (edited since it was adopted)' : '';
        out.push(`${dry ? 'would release' : 'released'} ${s.id} -> ${rel(dest)}${edited}`);
        if (dry) continue;
        moveDir(s.dir, dest);
        record(cfg, s.source, { action: 'release', name: s.name, from: s.dir, to: dest, hash: skillHash(dest) });
      }
      if (!dry) await reindex(cfg);
      console.log(out.join('\n'));
      if (all && !dry) console.log('\nThe library is empty. To leave headjack entirely, also uninstall the plugin (e.g. `claude plugin uninstall headjack@qbranch`). The ledger stays, so nothing about what happened is lost.');
      return;
    }

    case 'history': {
      const h = history(cfg, { name: rest[0] });
      if (flag('--json')) return console.log(JSON.stringify(h, null, 2));
      if (!h.length) return console.log(rest[0] ? `no history for ${rest[0]}` : 'no history yet');
      return console.log(h.map(e => `${e.at.slice(0, 16).replace('T', ' ')}  ${e.action.padEnd(8)} ${e.space}/${e.name}${e.from ? `  from ${rel(e.from)}` : ''}${e.to && e.action === 'release' ? `  to ${rel(e.to)}` : ''}${e.source && !e.source.startsWith('path:') ? `  [${e.source}]` : ''}`).join('\n'));
    }

    case 'source': {
      const personal = flag('--personal'); const [sub, dir] = rest;
      if (sub === 'list' || !sub) return console.log(cfg.sourceDirs.map(s => `${s.scope.padEnd(8)} ${s.label.padEnd(14)} ${rel(s.dir)}${fs.existsSync(s.dir) ? '' : '  (missing)'}`).join('\n'));
      if (!['add', 'remove'].includes(sub) || !dir) return console.log('usage: headjack source add|remove <dir> [--personal] | headjack source list');
      if (sub === 'add' && !fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
      const r = editSources(cfg, personal ? 'personal' : 'shared', dir, sub === 'remove');
      await reindex(loadConfig(cfg.root));
      return console.log(`${sub === 'add' ? 'indexing' : 'stopped indexing'} ${dir} (${personal ? 'personal' : 'shared'} source, saved in ${rel(r.file)})`);
    }

    case 'list': {
      await reindex(cfg);
      const rows = db(cfg).prepare('select id, source, tier, description from skills order by source, id').all();
      if (!rows.length) return console.log('the library is empty: headjack adopt, headjack add, or headjack new');
      let cur;
      for (const r of rows) {
        if (r.source !== cur) { cur = r.source; console.log(`\n${cur}`); }
        console.log(`  ${r.id}${r.tier === 'external' ? '  [registry, unvetted]' : ''}\n    ${r.description.slice(0, 110)}`);
      }
      return;
    }

    case 'index': { const r = await reindex(cfg); return console.log(`indexed ${r.total} skills (${r.updated} new or changed)`); }

    case 'find': {
      const ext = flag('--external'); const q = rest.join(' ');
      if (!q) return console.log('usage: headjack find <what you need>');
      if (ext) {
        const r = await searchRegistry(q, 6);
        upsert(cfg, (s) => { s.totals.external_searches++; });
        return console.log(r.map(s => `- ${s.id}  (${s.installs} installs)`).join('\n') + '\n\nFetch one with: headjack get --acquire <id>');
      }
      await reindex(cfg);
      const local = await search(cfg, q, 6);
      const strong = isStrong(cfg, local, q);
      let out = local.map(s => `- ${s.id}${s.similarity == null ? '' : `  [sim ${s.similarity}]`}\n  ${s.description.slice(0, 280)}`).join('\n') || '(library is empty)';
      let ext2 = [];
      if (!strong && cfg.external) {
        try { ext2 = await searchRegistryByGap(cfg, q); } catch {}
        out += '\n\nNo strong match in the library. Public registry candidates (best match first; unvetted):\n' +
          (ext2.length ? ext2.map(s => `- ${s.id}  (${s.installs} installs)`).join('\n') + '\nFetch one with: headjack get --acquire <id>' : '(none found)');
      }
      upsert(cfg, (s) => { s.totals.searches++; if (!strong) { s.totals.weak_searches++; s.gaps.push({ at: new Date().toISOString(), q: q.slice(0, 140), registry: ext2.map(e => e.id).slice(0, 3) }); } });
      return console.log(out);
    }

    case 'get': {
      const acq = flag('--acquire'); const personal = flag('--personal'); const id = rest.join(' ');
      if (!id) return console.log('usage: headjack get <id>');
      const s = acq ? await acquire(cfg, id, { dest: spaceDir(personal ? 'personal' : 'shared') }) : (await reindex(cfg), load(cfg, id));
      if (!s.error) upsert(cfg, (st, day) => {
        st.totals.loads++; day.loaded++; if (acq) st.totals.acquires++;
        for (const x of [s, ...(s.members || []).filter(m => !m.error)]) {
          const k = skillStat(st, x.id); k.loaded++; k.last_loaded = new Date().toISOString();
        }
        if (wasSuggested(cfg, s.id)) st.totals.suggested_then_loaded++;
      });
      return console.log(renderSkill(s));
    }

    case 'stats': {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats || '.headjack-stats.json'), 'utf8')); } catch { return console.log('no stats yet'); }
      return console.log(flag('--json') ? JSON.stringify(s, null, 2) : summarize(s));
    }

    case 'hook': return runHook(async (h) => ({ context: await suggest(cfg, h.prompt) }), rest);

    case 'mcp': return import('../src/mcp.mjs');
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`headjack: ${e.message}`); process.exitCode = cmd === 'hook' ? 0 : 1; });
