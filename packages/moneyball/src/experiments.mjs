// Safe experiments on the startup context. Variants are derived from what is on disk, written to
// .moneyball/experiments/<id>/ (manifest.json, files/, patch.diff), and tested with the replay harness
// (@qbranch/core/replay) inside sandboxes. The live files are never edited: the human reviews patch.diff and applies it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tok, mcpKey, claudeProbe } from './overhead.mjs';

const expDir = (cfg) => path.join(cfg.dataDir, 'experiments');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const slug = (s) => s.toLowerCase().replace(/^[\d.\s]+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
const posix = (p) => p.split(path.sep).join('/');

/** Split markdown into a preamble and its `## ` sections (heading line included). Lines keep their own
 * terminators (LF or CRLF), so concatenating any subset of sections is byte-faithful. */
export function sections(md) {
  const out = [{ title: null, text: '' }];
  let fence = false;
  for (const l of md.split(/(?<=\n)/)) {
    if (/^(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^## /.test(l)) out.push({ title: l.slice(3).trim(), text: '' });
    out.at(-1).text += l;
  }
  return out;
}

/**
 * Candidate variants. Each is { id, kind, description, estTokensSaved, ops }, where ops are
 * { op: 'write', path, content } or { op: 'remove', path } relative to the project root.
 *   condensed: optional text of a model-written CLAUDE.md (see bin: `experiments --condense`)
 *   usage:     MCP tool calls per server from transcripts (unused servers become drop candidates)
 */
export function deriveVariants(root, { condensed = null, usage = null } = {}) {
  const out = [];
  const claudeMd = read(path.join(root, 'CLAUDE.md'));
  if (claudeMd != null) {
    const secs = sections(claudeMd);
    secs.forEach((s, i) => {
      if (!s.title) return;
      const content = secs.filter((_, j) => j !== i).map(x => x.text).join('');
      out.push({ id: `drop-${slug(s.title)}`, kind: 'drop-section', description: `CLAUDE.md without section "${s.title}"`, estTokensSaved: tok(s.text), ops: [{ op: 'write', path: 'CLAUDE.md', content }] });
    });
    if (condensed) out.push({ id: 'condensed', kind: 'condensed', description: 'model-written condensed CLAUDE.md', estTokensSaved: tok(claudeMd) - tok(condensed), ops: [{ op: 'write', path: 'CLAUDE.md', content: condensed }] });
  }
  const instr = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules'].filter(p => fs.existsSync(path.join(root, p)));
  if (instr.length) out.push({ id: 'fresh-start', kind: 'fresh-start', description: 'no project instruction files (CLAUDE.md, CLAUDE.local.md, rules)',
    estTokensSaved: instr.reduce((a, p) => a + sizeOf(path.join(root, p)), 0), ops: instr.map(p => ({ op: 'remove', path: p })) });
  const skills = path.join(root, '.claude', 'skills');
  if (isDir(skills) && fs.readdirSync(skills).length) out.push({ id: 'no-project-skills', kind: 'trim-skills',
    description: 'no project skills in the startup listing (load them just in time instead, e.g. headjack)', estTokensSaved: null, ops: [{ op: 'remove', path: '.claude/skills' }] });
  const mcpFile = path.join(root, '.mcp.json');
  const mcp = JSON.parse(read(mcpFile) || '{}');
  if (usage && mcp.mcpServers) {
    const unused = Object.keys(mcp.mcpServers).filter(n => !usage[mcpKey(n)]);
    const drop = (names) => JSON.stringify({ ...mcp, mcpServers: Object.fromEntries(Object.entries(mcp.mcpServers).filter(([n]) => !names.includes(n))) }, null, 2) + '\n';
    for (const n of unused) out.push({ id: `drop-mcp-${slug(n)}`, kind: 'drop-mcp', description: `drop MCP server "${n}" (0 tool calls in the window)`, estTokensSaved: null, ops: [{ op: 'write', path: '.mcp.json', content: drop([n]) }] });
    if (unused.length > 1) out.push({ id: 'drop-unused-mcp', kind: 'drop-mcp', description: `drop all ${unused.length} unused MCP servers`, estTokensSaved: null, ops: [{ op: 'write', path: '.mcp.json', content: drop(unused) }] });
  }
  return out;
}
const sizeOf = (p) => (isDir(p) ? walk(p).reduce((a, f) => a + tok(read(f)), 0) : tok(read(p)));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

/** Apply a variant's ops inside a sandbox dir (a copy of the project). Never called on the live tree. */
export function applyVariant(dir, v) {
  for (const o of v.ops) {
    const p = path.join(dir, o.path);
    if (o.op === 'remove') fs.rmSync(p, { recursive: true, force: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o.content); }
  }
}

// ---------- reviewable patch ----------
/** Minimal unified diff (LCS over lines, 3 lines of context). Instruction files are small, so O(n*m) is fine. */
export function unifiedDiff(a, b, name) {
  // a trailing newline ends the last line rather than starting an empty one; its absence gets git's marker
  const lines = (t) => (t == null || t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n'));
  const A = lines(a), B = lines(b), eolA = !a || a.endsWith('\n'), eolB = !b || b.endsWith('\n');
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0; // [sign, text, no-newline-at-eof marker after it]
  const mark = (s, ai, bj) => (s !== '+' && ai === n - 1 && !eolA) || (s !== '-' && bj === m - 1 && !eolB);
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i], mark(' ', i, j)]); i++; j++; }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', A[i], mark('-', i, -1)]); i++; }
    else { ops.push(['+', B[j], mark('+', -1, j)]); j++; }
  }
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter(k => k >= 0);
  if (!changed.length) return '';
  const hunks = [];
  for (const k of changed) {
    const last = hunks.at(-1);
    if (last && k - last[1] <= 6) last[1] = k; else hunks.push([k, k]);
  }
  const head = [`--- ${a == null ? '/dev/null' : `a/${name}`}`, `+++ ${b == null ? '/dev/null' : `b/${name}`}`];
  for (const [s0, e0] of hunks) {
    const s = Math.max(0, s0 - 3), e = Math.min(ops.length - 1, e0 + 3), seg = ops.slice(s, e + 1);
    const aStart = seg.filter(o => o[0] !== '+').length ? countBefore(ops, s, '+') + 1 : countBefore(ops, s, '+');
    const bStart = seg.filter(o => o[0] !== '-').length ? countBefore(ops, s, '-') + 1 : countBefore(ops, s, '-');
    head.push(`@@ -${aStart},${seg.filter(o => o[0] !== '+').length} +${bStart},${seg.filter(o => o[0] !== '-').length} @@`, ...seg.flatMap(o => (o[2] ? [o[0] + o[1], '\\ No newline at end of file'] : [o[0] + o[1]])));
  }
  return head.join('\n') + '\n';
}
// lines of the old (skip '+') or new (skip '-') file that come before op index s
const countBefore = (ops, s, skip) => ops.slice(0, s).filter(o => o[0] !== skip).length;

const binary = (f) => { try { return fs.readFileSync(f).subarray(0, 8000).includes(0); } catch { return false; } };
/** The patch a human reviews and applies (`git apply`). Binary files can't ride in a text patch: they are listed in
 * the header (git apply ignores text before the first diff) for the human to delete by hand. */
export function patchFor(root, v) {
  const parts = [], manual = [];
  for (const o of v.ops) {
    const p = path.join(root, o.path);
    if (o.op === 'write') parts.push(unifiedDiff(read(p), o.content, o.path));
    else for (const f of isDir(p) ? walk(p) : [p]) {
      const rel = posix(path.relative(root, f));
      if (binary(f)) manual.push(rel); else parts.push(unifiedDiff(read(f), null, rel));
    }
  }
  const head = manual.length ? `moneyball: also delete these binary files by hand:\n${manual.map(f => `  ${f}`).join('\n')}\n\n` : '';
  return head + parts.filter(Boolean).join('');
}

/** Write variants to .moneyball/experiments/<id>/{manifest.json, patch.diff}; replaces the previous set. */
export function writeVariants(cfg, variants) {
  const dir = expDir(cfg);
  if (isDir(dir)) for (const d of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, d, 'manifest.json'))) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  for (const v of variants) {
    const vd = path.join(dir, v.id);
    fs.mkdirSync(vd, { recursive: true });
    const gi = path.join(cfg.dataDir, '.gitignore'); // tool state never shows up in the user's repo
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({ ...v, created: new Date().toISOString(), root: cfg.root }, null, 2) + '\n');
    fs.writeFileSync(path.join(vd, 'patch.diff'), patchFor(cfg.root, v));
  }
  return dir;
}

export function loadVariants(cfg) {
  const dir = expDir(cfg);
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).map(d => read(path.join(dir, d, 'manifest.json'))).filter(Boolean).map(t => JSON.parse(t));
}

/**
 * A model-written condensed CLAUDE.md, for the `condensed` variant. Runs in an empty temp dir so the project's own
 * startup context is not loaded. run(args, cwd, input) is injectable for tests.
 */
export async function condense(root, { budget, model = 'sonnet', run = claudeProbe }) {
  if (!(budget > 0)) throw new Error('condensing calls a model: pass --budget <usd>');
  const src = read(path.join(root, 'CLAUDE.md'));
  if (src == null) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyball-condense-'));
  try {
    const r = await run(['-p', CONDENSE, '--output-format', 'json', '--model', model, '--no-session-persistence', '--max-budget-usd', String(budget)], dir, src);
    return { text: String(r.result || '').trim() + '\n', cost: Number(r.total_cost_usd) || 0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const CONDENSE = 'The text on stdin is a CLAUDE.md instruction file. Rewrite it as short as possible for a current frontier '
  + 'coding model. Keep every rule, path, command, name and fact the model could not infer from the repository itself. '
  + 'Drop restatements, motivation, and generic advice a strong model already follows. Keep markdown headings. '
  + 'Output only the new file, with no commentary and no code fence.';

// ---------- tune: replay recurring tasks under each variant ----------
/**
 * replay: the @qbranch/core/replay module ({ harvestTasks, compareVariants }), injected so tests use a fake.
 * A variant is recommended only when it saves startup tokens, has no regressions, and keeps >= bar (90%) of the
 * baseline's pass rate and mean score over at least minRuns task runs: the same bar as model graduation.
 */
export async function tune(cfg, { budget, replay, days = cfg.days, limit = 20, repeats = 1, only = null, concurrency = 1, perRunUsd, timeoutMs, judgeModel = 'sonnet' }) {
  if (!(budget > 0)) throw new Error('tune spends money: pass --budget <usd>');
  const variants = loadVariants(cfg).filter(v => !only || only.includes(v.id));
  if (!variants.length) throw new Error('no experiments yet: run `moneyball experiments` first');
  const tasks = await replay.harvestTasks({ root: cfg.root, days, limit, filter: (t) => t.readOnly });
  if (!tasks.length) throw new Error('no read-only recurring tasks found to replay');
  // A/A control: the unchanged setup runs twice. Whatever separates two identical setups is noise, and no variant can
  // be judged on a difference smaller than that.
  const setups = { baseline: async () => {}, 'baseline-again': async () => {} };
  for (const v of variants) setups[v.id] = async (dir) => applyVariant(dir, v);
  // Without a judge, a task whose only hard check is "it finished" scores 1.0 however poor the answer: judge rubric tasks
  // against what the original run delivered, so a trimmed setup that loses quality shows up as a lower score.
  const judge = judgeModel && replay.claudeJudge ? replay.claudeJudge({ model: judgeModel, budgetUsd: 0.5 }) : undefined;
  const report = await replay.compareVariants({ tasks, variants: setups, repeats, budgetUsd: budget, concurrency, perRunUsd, timeoutMs, judge });
  const base = report.perVariant.baseline || {};
  const aa = report.perVariant['baseline-again'] || {};
  const noise = !aa.runs ? null : {
    passDelta: Math.abs((base.passRate ?? 0) - (aa.passRate ?? 0)),
    scoreDelta: Math.abs((base.meanScore ?? 0) - (aa.meanScore ?? 0)),
    regressions: (report.regressions || []).filter(x => x.variant === 'baseline-again').length,
  };
  // the experiment can resolve a loss of (1 - bar) only if two identical setups agree more closely than that
  const tolerance = (k) => (1 - cfg.bar) * (base[k] ?? 0);
  const tooNoisy = !!noise && (noise.passDelta > tolerance('passRate') || noise.scoreDelta > tolerance('meanScore'));
  const rows = variants.map(v => {
    const r = report.perVariant[v.id];
    if (!r) return { id: v.id, skipped: 'not run (budget)' };
    if (!r.runs) return { id: v.id, skipped: 'inconclusive: every replay ran out of budget or time (raise --budget)' };
    const runs = Math.min(r.runs, base.runs || 0); // only scored runs count as evidence; cut-off ones are inconclusive
    const regressions = (report.regressions || []).filter(x => (x.variant ?? x.name) === v.id);
    const saved = (base.startupTokens ?? 0) - (r.startupTokens ?? 0);
    const keeps = (k) => (base[k] ?? 0) === 0 || (r[k] ?? 0) >= cfg.bar * base[k];
    const chance = noise?.regressions ?? 0;
    const beyond = regressions.length - chance; // regressions the A/A control also produced are noise
    const why = runs < cfg.minRuns ? `only ${runs} task runs (< ${cfg.minRuns})` : saved <= 0 ? 'saves no startup tokens'
      : beyond > 0 ? `${regressions.length} regression(s)${chance ? `, ${chance} expected from noise` : ''}`
      : !keeps('passRate') ? 'pass rate below the bar' : !keeps('meanScore') ? 'mean score below the bar'
      : tooNoisy ? `inconclusive: two identical setups differed by ${Math.round(noise.passDelta * 100)} pts pass / ${noise.scoreDelta.toFixed(2)} score, more than the ${Math.round((1 - cfg.bar) * 100)}% bar can resolve (add --repeats)`
      : null;
    return { id: v.id, description: v.description, passRate: r.passRate, meanScore: r.meanScore, costUsd: r.costUsd, startupTokensSaved: saved,
      regressions: regressions.length, recommend: !why, why: why || `keeps ${Math.round((r.passRate / (base.passRate || 1)) * 100)}% of baseline outcomes, saves ${saved} tokens per startup`,
      patch: path.join(expDir(cfg), v.id, 'patch.diff') };
  });
  const result = { at: new Date().toISOString(), tasks: tasks.length, repeats, budget, baseline: base, aa, noise, tooNoisy, inconclusive: (report.inconclusive || []).length,
    spent: Object.values(report.perVariant).reduce((a, r) => a + (r.costUsd || 0), 0), variants: rows };
  fs.writeFileSync(path.join(expDir(cfg), 'last-tune.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
