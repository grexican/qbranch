// Mine transcripts for the work agents keep doing by hand:
//   repeats    the same command shape run in many sessions          -> script candidate
//   sequences  the same 2-4 step run of shapes in many sessions      -> runbook / script candidate
//   lessons    a failing shape followed by a different, working one -> lesson (runbook entry, or a guard hook)
import fs from 'node:fs';
import path from 'node:path';
import { sessions } from '@qbranch/core';
import { escapeRisk, inlineScript } from './guard.mjs';

const SHELL = /^(Bash|PowerShell|run_shell_command|Shell)$/;
const ERR = /exit code [1-9]|\berror[: ]|not found|not recognized|cannot find|command not found|failed|denied|ENOENT|Exception|No such file/i;

const CD = /^(cd|Set-Location|pushd|export|set)\b/i;
// wrappers that do not change what runs: token-saving proxies, timeouts, env prefixes
const WRAPPER = /^(rtk proxy|rtk|timeout\s+\S+|time|sudo|env|command)\s+/;

// For an interpreter the script is the program: `node tools/a.mjs` and `node tools/b.mjs` are different tools.
const INTERP = /^(node|bun|deno|tsx|ts-node|python3?|py|bash|sh|zsh|pwsh|powershell|ruby|perl|php)$/i;
const SCRIPT = /\.(m?[jt]s|c[jt]s|py|sh|ps1|rb|pl|php)$/i;
/** A script argument kept by name: its last two path segments ("tools/cu/x.mjs" -> "cu/x.mjs"), stable across clones. */
const scriptName = (t) => t.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
/** The script token of a shape whose program is an interpreter, or null. */
export const scriptOf = (s) => { const t = s.split(' '); return INTERP.test(t[0]) ? t.slice(1).find(x => SCRIPT.test(x)) || null : null; };

/** A command's shape: the first real command (leading cd / Set-Location / env assignments and wrappers stripped), args generalized. */
export function shape(cmd) {
  let parts = cmd.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  while (parts.length > 1 && CD.test(parts[0])) parts = parts.slice(1);
  let first = (parts[0] || '').replace(/^(\w+=\S+\s+)+/, '');
  while (WRAPPER.test(first)) first = first.replace(WRAPPER, '');
  const tokens = first
    .replace(/"[^"]*"|'[^']*'/g, 'S')
    .replace(/\b[0-9a-f]{7,}\b|\b\d+(\.\d+)*\b/g, 'N')
    .split(/\s+/).filter(Boolean);
  let script = !INTERP.test(tokens[0] || '');
  return tokens.map((t, i) => {
    if (i > 0 && !script && !t.startsWith('-') && SCRIPT.test(t)) { script = true; return scriptName(t); }
    return /[\\/]/.test(t) ? 'P' : t;
  }).slice(0, 4).join(' ');
}
/** The directory-change keyword a command starts with (cd, Set-Location, ...), or ''. */
export const lead = (cmd) => (cmd.trim().match(CD)?.[1] || '');

// For runners the program is the subcommand: `npx tsc` and `npx vitest` are different programs.
const RUNNERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'dotnet', 'git', 'gh', 'docker', 'cargo', 'go', 'uv', 'uvx', 'az', 'kubectl']);
/** The head of a shape: the program (python3, npx tsc, npm run lint, dotnet test ...), flags skipped. */
export function head(s) {
  const t = s.split(' ');
  const script = scriptOf(s);
  if (script) return `${t[0]} ${script}`;
  if (!RUNNERS.has(t[0])) return t[0];
  const rest = t.slice(1).filter(x => !x.startsWith('-'));
  return [t[0], ...(/^(run|exec|x)$/.test(rest[0] || '') ? rest.slice(0, 2) : rest.slice(0, 1))].join(' ');
}

// Looking around is not a procedure. Reads and searches are excluded everywhere (a grep with no match "fails" by
// design). Throwaway inline scripts are excluded from sequences and repeats, but kept for lessons: `python3 -` failing
// and `py -` working is exactly a lesson. Everything still counts toward lesson recurrence.
const READ = /^(grep|rg|sed|cat|head|tail|ls|dir|echo|sleep|find|wc|pwd|which|where|type|less|awk|sort|uniq|printf|true|test|diff|jq|stat|file|mkdir|rm|cp|mv|touch|P|Get-Content|Select-String|Get-ChildItem|Start-Sleep|Write-Output|Write-Host|Test-Path|New-Item)(\s|$)|^git (status|log|diff|show|branch|fetch|rev-parse|remote|ls-files)(\s|$)/i;
const INLINE = /^(python3?|py|node) (-|-e|-c)(\s|$)/i;
export const read = (s) => READ.test(s);
export const inspect = (s) => READ.test(s) || INLINE.test(s);

/** Is `fix` a workaround for `failed`? Same program, or the same arguments under a different program (python3 -> py). */
export function related(failed, fix) {
  if (head(failed) === head(fix)) return true;
  const tail = (s) => s.split(' ').slice(1).join(' ');
  if (tail(failed) && tail(failed) === tail(fix)) return true; // same call, different program
  if ((scriptOf(failed) || scriptOf(fix)) && scriptOf(failed) !== scriptOf(fix)) return false; // another script is another tool, not a fix

  const args = (s) => s.split(' ').slice(1).filter(t => !/^([SPN]|N>&N|\||-\w)$/.test(t));
  const a = args(failed), b = new Set(args(fix));
  return a.length > 0 && a.filter(t => b.has(t)).length / a.length >= 0.5;
}

/** Shell calls of one session, in order: [{ shape, cmd, err }] */
export function shellCalls(session) {
  const seq = [], byId = new Map();
  for (const e of session.events()) {
    if (e.t === 'tool' && SHELL.test(e.name) && e.input?.command) {
      const c = { shape: shape(e.input.command), lead: lead(e.input.command), tool: e.name, cmd: e.input.command.slice(0, 300), err: false };
      byId.set(e.id, c); seq.push(c);
    } else if (e.t === 'result' && byId.has(e.id)) {
      byId.get(e.id).err = e.isError || ERR.test((e.text || '').slice(0, 600));
    }
  }
  return seq;
}

// ---------- tool switches and rtk retries ----------
// Some fixes are not another shell command: an inline script that kept failing is written with the Write tool and run
// as a file, a `sed -i` becomes an Edit. The command shape hides the cause (a heredoc looks the same with or without the
// backslashes that broke it), so these group by the risky construct, not the shape.
const EDIT = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const SCRIPT_FILE = /\.(m?[jt]s|c[jt]s|py|sh|ps1|rb|pl|php|sql)$/i;

/** Shell calls and file edits of one session, in order: [{ kind: 'shell', tool, cmd, err } | { kind: 'edit', tool, file }] */
export function trail(session) {
  const seq = [], byId = new Map();
  for (const e of session.events()) {
    if (e.t === 'tool' && SHELL.test(e.name) && e.input?.command) { const c = { kind: 'shell', tool: e.name, cmd: e.input.command, err: false }; byId.set(e.id, c); seq.push(c); }
    else if (e.t === 'tool' && EDIT.test(e.name)) seq.push({ kind: 'edit', tool: e.name, file: String(e.input?.file_path || e.input?.notebook_path || e.input?.path || '') });
    else if (e.t === 'result' && byId.has(e.id)) byId.get(e.id).err = e.isError || ERR.test((e.text || '').slice(0, 600));
  }
  return seq;
}

/** The file a heredoc command writes (cat > f <<EOF, tee f <<EOF), or null. */
export function heredocFile(cmd) {
  const m = cmd.match(/\b(?:cat|tee)\s+(?:-a\s+)?>{0,2}\s*("[^"]+"|'[^']+'|[^\s<>|;&]+)\s*<</) || cmd.match(/<<-?\s*['"]?\w+['"]?\s*>{1,2}\s*("[^"]+"|'[^']+'|[^\s<>|;&]+)/);
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** The risky construct a shell command uses, or null. Ordered: the most specific cause first. */
export function riskKind(cmd) {
  const esc = escapeRisk(cmd);
  if (esc) return `inline-backslash-${esc}`;
  const s = inlineScript(cmd);
  if (s) return s.kind === 'heredoc' ? 'heredoc-script' : 'inline-eval';
  if (/\b(sed\s+(-\S*\s+)*-\S*i|perl\s+-\S*p\S*i|perl\s+-\S*i\S*p)/.test(cmd)) return 'sed-in-place';
  if (/(^|[;&|]\s*)(echo|printf)\b[^|]*?>{1,2}\s*[^\s&|]/.test(cmd)) return 'echo-to-file';
  return null;
}
const base = (f) => (f ? f.split(/[\\/]/).pop() : '');

/**
 * Tool-switch recoveries in one trail: a failing risky shell construct, then within a few steps a Write/Edit of a file
 * that is then run and works (for scripts), or simply the Edit/Write (for sed -i / echo > file).
 * Returns [{ tool, kind, fromExample, toExample }].
 */
export function toolSwitches(seq) {
  const out = [];
  const blamed = new Set(); // a risky construct already counted: its later failures (the run, retries) are the same incident
  for (let i = 0; i < seq.length; i++) {
    const c = seq[i];
    if (c.kind !== 'shell' || !c.err) continue;
    let kind = riskKind(c.cmd), from = c;
    if (!kind) { // the failing call ran a file a heredoc wrote a step or two earlier: blame the heredoc
      const prev = seq.slice(Math.max(0, i - 3), i).reverse().find(p => p.kind === 'shell' && heredocFile(p.cmd) && c.cmd.includes(base(heredocFile(p.cmd))));
      if (prev) { kind = riskKind(prev.cmd); from = prev; }
    }
    if (!kind || blamed.has(from)) continue;
    const ahead = seq.slice(i + 1, i + 7);
    let fixAt = -1, toExample = null; // fixAt: index in `ahead` of the step that completed the recovery
    if (kind === 'sed-in-place' || kind === 'echo-to-file') {
      // the same file, now through the Edit/Write tool
      fixAt = ahead.findIndex(x => x.kind === 'edit' && base(x.file) && from.cmd.includes(base(x.file)));
      if (fixAt >= 0) toExample = `${ahead[fixAt].tool} ${base(ahead[fixAt].file)}`;
    } else {
      // a script: written fresh with the Write tool, then executed by an interpreter (a grep that names it is not a run)
      const ed = ahead.findIndex(x => x.kind === 'edit' && x.tool === 'Write' && SCRIPT_FILE.test(x.file));
      if (ed >= 0) {
        const edit = ahead[ed], name = base(edit.file);
        const runs = (cmd) => cmd.split(/&&|;|\|\|/).some(part => { const t = part.trim().split(/\s+/); return /^(node|nodejs|bun|deno|tsx|ts-node|python3?|py|bash|sh|pwsh|powershell|ruby|perl|php)$/i.test(t[0] || '') && part.includes(name); });
        const r = ahead.slice(ed + 1, ed + 5).findIndex(x => x.kind === 'shell' && runs(x.cmd));
        const run = r >= 0 ? ahead[ed + 1 + r] : null;
        if (run && !run.err) { fixAt = ed + 1 + r; toExample = `${edit.tool} ${name}, then: ${run.cmd.split('\n')[0]}`; }
      }
    }
    if (fixAt < 0) continue;
    out.push({ tool: c.tool, kind, fromExample: from.cmd, toExample });
    blamed.add(from);
    i += 1 + fixAt; // one incident, one count: resume after the step that fixed it
  }
  return out;
}

// rtk (a token-saving proxy) rewrites and filters command output. When an agent reruns the same command as
// `rtk proxy <cmd>`, the filtered output was not enough: that command shape wants raw output.
const RTK_PROXY = /^\s*rtk\s+proxy\s+/;
// the command itself: cd prefixes, rtk/rtk proxy and the output post-processing (| tail, | grep, 2>&1) removed, since
// a retry for raw output usually changes how the output is cut
const strip = (cmd) => cmd.trim().replace(/^(cd\s+[^;&]+(?:&&|;)\s*)+/, '').replace(RTK_PROXY, '').replace(/^rtk\s+(?!proxy\b)/, '')
  .split(/\s\|\s?|\s\|\|/)[0].replace(/\s*\d?>&\d\s*/g, ' ').replace(/\s+/g, ' ').trim();
/** rtk raw-output retries in one trail: [{ tool, shape, example }]. */
export function rtkRetries(seq) {
  const shells = seq.filter(x => x.kind === 'shell');
  const out = [];
  const used = new Set(); // one retry is one event, however many filtered copies came before it
  shells.forEach((c, i) => {
    const own = c.cmd.trim().replace(/^(cd\s+[^;&]+(?:&&|;)\s*)+/, '');
    if (RTK_PROXY.test(own)) return; // already raw
    const inner = strip(c.cmd);
    const retry = shells.slice(i + 1, i + 4).find(n => RTK_PROXY.test(n.cmd.trim().replace(/^(cd\s+[^;&]+(?:&&|;)\s*)+/, '')) && strip(n.cmd) === inner);
    if (retry && !used.has(retry)) { used.add(retry); out.push({ tool: c.tool, shape: shape(inner), example: retry.cmd.split('\n')[0].slice(0, 200) }); }
  });
  return out;
}

export function mine(cfg, { days = cfg.days, allProjects = false } = {}) {
  const shapes = new Map(), seqs = new Map(), recov = new Map(), switches = new Map(), rtk = new Map();
  let nSessions = 0, nCalls = 0;
  const calls = []; // flat, for lesson recurrence checks (not persisted)
  const bump = (m, k, sid, init) => { const e = m.get(k) || m.set(k, { ...init(), sessions: new Set() }).get(k); e.sessions.add(sid); return e; };
  for (const s of sessions({ root: allProjects ? null : cfg.root, days })) {
    const tr = trail(s);
    // the shell calls, shaped (one pass over the transcript serves both views)
    const seq = tr.filter(x => x.kind === 'shell').map(x => ({ shape: shape(x.cmd), lead: lead(x.cmd), tool: x.tool, cmd: x.cmd.slice(0, 300), err: x.err }));
    if (!seq.length) continue;
    nSessions++; nCalls += seq.length;
    const sid = s.parent ? `${s.parent}/${s.id}` : s.id;
    for (const c of seq) calls.push({ cmd: c.cmd, err: c.err, mtime: s.mtime });
    // lessons: a failing call, then a related working one (reads/searches excluded, inline scripts kept)
    const tried = seq.filter(c => !read(c.shape));
    tried.forEach((c, i) => {
      const next = tried[i + 1];
      if (!c.err || !next || next.err) return;
      let from = c.shape, to = next.shape;
      if (from === to) {
        if (!c.lead || !next.lead || c.lead === next.lead) return;           // a plain retry
        from = `${c.lead} P`; to = `${next.lead} P`;                          // same call, different cd: Set-Location -> cd
      } else if (!related(from, to)) return;
      const r = bump(recov, `${c.tool}: ${from} => ${to}`, sid, () => ({ count: 0, tool: c.tool, from, to, fromExample: c.cmd, toExample: next.cmd, mtimes: [] }));
      r.count++; r.mtimes.push(s.mtime);
    });
    for (const w of toolSwitches(tr)) {
      const e = bump(switches, `${w.tool}: ${w.kind}`, sid, () => ({ count: 0, tool: w.tool, kind: w.kind, fromExample: w.fromExample.slice(0, 300), toExample: w.toExample.slice(0, 200), mtimes: [] }));
      e.count++; e.mtimes.push(s.mtime);
    }
    for (const k of rtkRetries(tr)) {
      const e = bump(rtk, `${k.tool}: ${k.shape}`, sid, () => ({ count: 0, tool: k.tool, shape: k.shape, example: k.example }));
      e.count++;
    }
    const work = seq.filter(c => !inspect(c.shape));
    work.forEach((c, i, seq) => {
      const e = bump(shapes, c.shape, sid, () => ({ count: 0, errors: 0, example: c.cmd }));
      e.count++; if (c.err) e.errors++;
      for (let n = 2; n <= 4 && i + n <= seq.length; n++) {
        const run = seq.slice(i, i + n).map(x => x.shape);
        if (new Set(run).size < n) continue; // a retry loop is not a procedure
        bump(seqs, run.join('  >  '), sid, () => ({ steps: run, examples: seq.slice(i, i + n).map(x => x.cmd) }));
      }
    });
  }
  const flat = (m) => [...m.values()].map(e => ({ ...e, sessions: e.sessions.size }));
  const repeats = flat(new Map([...shapes].map(([k, v]) => [k, { shape: k, ...v }]))).filter(e => e.sessions >= cfg.minSessions).sort((a, b) => b.sessions - a.sessions);
  const friction = repeats.filter(e => e.count >= 20 && e.errors / e.count >= 0.25).sort((a, b) => b.errors / b.count - a.errors / a.count);
  // A lesson recurs across sessions and points one way. A -> B and B -> A both common is flailing (quoting, trial and
  // error), not a fix; one session's retries are not a pattern.
  const pair = (e) => `${e.tool}: ${e.from} => ${e.to}`;
  const byPair = new Map(flat(recov).map(e => [pair(e), e]));
  const lessons = [...byPair.values()].filter(e => {
    const back = byPair.get(`${e.tool}: ${e.to} => ${e.from}`);
    return e.count >= cfg.minRecoveries && e.sessions >= 2 && !(back && back.count * 2 >= e.count);
  }).sort((a, b) => b.sessions - a.sessions || b.count - a.count);
  // keep only maximal sequences: drop a sequence when a longer one containing it is as common
  let sequences = flat(seqs).filter(e => e.sessions >= cfg.minSequence).sort((a, b) => b.steps.length - a.steps.length || b.sessions - a.sessions);
  sequences = sequences.filter((e, i) => !sequences.slice(0, i).some(l => l.steps.length > e.steps.length && l.sessions >= e.sessions && l.steps.join('\n').includes(e.steps.join('\n'))))
    .sort((a, b) => b.sessions * b.steps.length - a.sessions * a.steps.length).slice(0, 50);
  // gated on distinct sessions: one bad afternoon of retries is not a habit (count is kept for display)
  const recurring = (m) => flat(m).filter(e => e.sessions >= Math.max(2, cfg.minRecoveries)).sort((a, b) => b.sessions - a.sessions || b.count - a.count);
  const index = { scanned: new Date().toISOString(), days, sessions: nSessions, calls: nCalls, repeats: repeats.slice(0, 100), friction, lessons: lessons.slice(0, 100), sequences,
    switches: recurring(switches).slice(0, 30), rtk: recurring(rtk).slice(0, 30) };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (!fs.existsSync(path.join(cfg.dataDir, '.gitignore'))) fs.writeFileSync(path.join(cfg.dataDir, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(cfg.dataDir, 'index.json'), JSON.stringify(index, null, 2));
  return { ...index, allCalls: calls };
}
