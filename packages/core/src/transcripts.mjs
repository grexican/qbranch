// Read agent session transcripts from disk into a normalized event stream. Platform readers register below;
// Claude Code is implemented (main sessions + subagents). Every reader yields the same shape:
//   session: { platform, id, file, kind: 'main'|'subagent', parent?, meta: {agentType, description}, mtime }
//   events:  { t:'usage', model, usage, id } | { t:'tool', name, input, id } | { t:'result', id, isError, text } | { t:'user', text }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- pricing ($ per million tokens: input, output, cache write, cache read) ----------
export const PRICES = {
  'claude-fable-5-1': [10, 50, 12.5, 0.25], 'claude-fable-5': [10, 50, 12.5, 0.25],
  'claude-opus-5-5': [4, 20, 5, 0.2], 'claude-opus-5': [5, 25, 6.25, 0.25], 'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2], 'claude-sonnet-5': [2, 10, 2.5, 0.2], 'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01], 'claude-haiku-4-5': [1, 5, 1.25, 0.1],
};
export const modelId = (m) => (m || '').replace(/-\d{8}$/, '');
/** Tier of a model id: haiku | sonnet | opus | fable | other */
export const tierOf = (m) => (/haiku/.test(m) ? 'haiku' : /sonnet/.test(m) ? 'sonnet' : /opus/.test(m) ? 'opus' : /fable|mythos/.test(m) ? 'fable' : 'other');
export function costOf(model, u, prices = PRICES) {
  const p = prices[modelId(model)]; if (!p || !u) return 0;
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6;
}

// ---------- Claude Code ----------
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const encodeProject = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

function claudeProjectDirs(root) {
  const base = path.join(claudeHome(), 'projects');
  if (!fs.existsSync(base)) return [];
  if (!root) return fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.statSync(d).isDirectory());
  const enc = encodeProject(root);
  // exact project dir, plus worktree / subdir dirs that start with it (e.g. <proj>--claude-worktrees-x)
  return fs.readdirSync(base).filter(d => d === enc || d.startsWith(enc + '-')).map(d => path.join(base, d));
}

function* claudeEvents(file) {
  const seen = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'assistant' && m.message) {
      if (m.message.usage) seen.set(m.message.id || m.uuid, { t: 'usage', model: m.message.model, usage: m.message.usage, id: m.message.id });
      for (const b of m.message.content || []) if (b.type === 'tool_use') yield { t: 'tool', name: b.name, input: b.input || {}, id: b.id };
    } else if (m.type === 'user' && m.message) {
      const c = m.message.content;
      if (typeof c === 'string') { if (!c.startsWith('<')) yield { t: 'user', text: c }; continue; }
      for (const b of c || []) {
        if (b.type === 'tool_result') yield { t: 'result', id: b.tool_use_id, isError: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '') };
        else if (b.type === 'text' && !b.text.startsWith('<')) yield { t: 'user', text: b.text };
      }
    }
  }
  yield* seen.values(); // streamed assistant messages repeat; usage is emitted once per message id, last copy wins
}

function* claudeSessions({ root, days }) {
  const since = Date.now() - days * 864e5;
  for (const pdir of claudeProjectDirs(root)) {
    for (const f of fs.readdirSync(pdir)) {
      const fp = path.join(pdir, f);
      if (f.endsWith('.jsonl')) {
        const mtime = fs.statSync(fp).mtimeMs;
        if (mtime > since) yield { platform: 'claude-code', id: f.replace('.jsonl', ''), file: fp, kind: 'main', meta: {}, mtime, events: () => claudeEvents(fp) };
      }
      const sdir = path.join(fp, 'subagents');
      if (fs.existsSync(sdir) && fs.statSync(sdir).isDirectory()) {
        for (const sf of fs.readdirSync(sdir).filter(x => x.endsWith('.jsonl'))) {
          const sp = path.join(sdir, sf); const mtime = fs.statSync(sp).mtimeMs;
          if (mtime <= since) continue;
          const metaF = sp.replace(/\.jsonl$/, '.meta.json');
          let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaF, 'utf8')); } catch {}
          yield { platform: 'claude-code', id: sf.replace('.jsonl', ''), parent: f, file: sp, kind: 'subagent', meta, mtime, events: () => claudeEvents(sp) };
        }
      }
    }
  }
}

const READERS = { 'claude-code': claudeSessions };
export const registerReader = (platform, fn) => { READERS[platform] = fn; };

/** All sessions for a project (root=null: every project) in the last `days`, across registered platforms. */
export function* sessions({ root = null, days = 30, platforms = Object.keys(READERS) } = {}) {
  for (const p of platforms) if (READERS[p]) yield* READERS[p]({ root, days });
}
