// Per-prompt retrieval for the UserPromptSubmit hook. The model never has to remember to search; it only
// decides whether to load. Returns the context to inject, or '' (zero tokens) when nothing is relevant.
import { db, reindex, search, isStrong, noteSuggested, noteSession, suggestedIn, noteSuggestedIn, listingTokens } from './library.mjs';
import { searchRegistryByGap, relevantExternal } from './registry.mjs';
import { upsert, skillStat } from './stats.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SKILLS_LINE = 'Use the load-skill skill (`headjack get <id>`) to load one; find-skill (`headjack find <query>`) searches for others.';
const EXTERNAL = '__registry__'; // session marker: registry candidates were already offered in this session

// Text the harness submits as a "prompt" that the user never typed: subagent completion notices, local command
// output, injected reminders. Matching skills against a subagent's report suggests skills for work already done.
const HARNESS = /^\s*<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|tool-use-error)\b/;

/** The request a prompt actually carries: null for harness text; a slash command is its name plus its arguments. */
export function requestText(prompt) {
  const p = prompt || '';
  if (HARNESS.test(p)) return null;
  if (/^\s*<command-(name|message|args)>/.test(p)) {
    const tag = (t) => p.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() || '';
    return `${tag('command-name').replace(/^\//, '').replace(/[:_-]/g, ' ')} ${tag('command-args')}`.trim();
  }
  return p;
}

/** suggest(cfg, prompt, { sessionId, registry }) — registry(cfg, request) overrides the public registry lookup (tests). */
export async function suggest(cfg, prompt, { sessionId = '', registry = searchRegistryByGap } = {}) {
  const request = requestText(prompt);
  const firstInSession = sessionId ? noteSession(cfg, sessionId) : false;
  if (request === null) {
    upsert(cfg, (s, day) => { s.totals.prompts++; day.prompts++; s.totals.skipped_system++; if (firstInSession) { s.totals.sessions++; s.totals.startup_tokens_saved += s.startup_tokens_per_context || 0; } });
    return '';
  }
  prompt = request.slice(0, 2000);
  await reindex(cfg); // cheap when nothing changed
  const p = ` ${norm(prompt)} `;
  // a skill named literally in the request ("decision council") wins outright
  const named = db(cfg).prepare('select id, name, description from skills').all()
    .filter(s => norm(s.name).length > 3 && p.includes(` ${norm(s.name)} `));
  const hits = await search(cfg, prompt, 3);
  const strong = hits.filter(h => isStrong(cfg, [h], prompt)); // per hit: same rule as the library-wide check
  const seen = new Set();
  const matched = [...named, ...strong].filter(s => !seen.has(s.id) && seen.add(s.id)).slice(0, cfg.suggestMax);
  // once per session: a skill the agent already saw (and loaded or skipped) is not named again
  const already = sessionId ? suggestedIn(cfg, sessionId) : new Set();
  const picks = matched.filter(s => !already.has(s.id));
  const suppressed = matched.length - picks.length;

  let text = '';
  let external = [];
  if (picks.length) {
    text = "Skills in this project's library match this request. They hold this team's conventions and checklists, which override your defaults. " +
      `Load the best match BEFORE you start, then follow it. Skip only if none of them are about this task. ${SKILLS_LINE}\n` +
      picks.map(s => `- ${s.id}: ${s.description.slice(0, 160)}`).join('\n');
    noteSuggested(cfg, picks.map(s => s.id));
    if (sessionId) noteSuggestedIn(cfg, sessionId, picks.map(s => s.id));
  } else if (!matched.length && cfg.external && !already.has(EXTERNAL)) {
    try { external = relevantExternal(prompt, await registry(cfg, prompt)); } catch { /* offline */ }
    if (external.length) {
      text = 'No skill in the library covers this request. Public registry candidates (best match first; unvetted): ' +
        'if one is clearly about this task and comes from a reputable source, `headjack get --acquire <id>` fetches it into the library.\n' +
        external.map(s => `- ${s.id} (${s.installs} installs)`).join('\n');
      if (sessionId) noteSuggestedIn(cfg, sessionId, [EXTERNAL]);
    }
  }

  const perContext = listingTokens(cfg);
  upsert(cfg, (s, day) => {
    s.totals.prompts++; day.prompts++;
    if (firstInSession) { s.totals.sessions++; s.totals.startup_tokens_saved += perContext; } // the listing size THIS session would have carried
    s.startup_tokens_per_context = perContext;
    s.totals.repeat_suppressed += suppressed;
    if (picks.length) {
      s.totals.suggested_prompts++; s.totals.suggestions += picks.length; day.suggested++;
      for (const k of picks) skillStat(s, k.id).suggested++;
      const sims = picks.map(k => hits.find(h => h.id === k.id)?.similarity).filter(x => x != null);
      s.trail.push({ at: new Date().toISOString(), q: prompt.slice(0, 100), ids: picks.map(k => k.id), sim: sims.length ? Math.max(...sims) : null });
    } else if (!matched.length && prompt.trim().split(/\s+/).length >= 6) {
      s.gaps.push({ at: new Date().toISOString(), q: prompt.slice(0, 140), registry: external.map(e => e.id).slice(0, 3) });
    }
    if (external.length) s.totals.external_suggestions++;
    s.totals.est_tokens_injected += Math.round(text.length / 3.5);
  });
  return text;
}
