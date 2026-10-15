// Per-prompt retrieval for the UserPromptSubmit hook. The model never has to remember to search; it only
// decides whether to load. Returns the context to inject, or '' (zero tokens) when nothing is relevant.
import { db, reindex, search, isStrong, noteSuggested } from './library.mjs';
import { searchRegistryByGap } from './registry.mjs';
import { upsert, skillStat } from './stats.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SKILLS_LINE = 'Use the load-skill skill (`headjack get <id>`) to load one; find-skill (`headjack find <query>`) searches for others.';

export async function suggest(cfg, prompt) {
  prompt = (prompt || '').slice(0, 2000);
  await reindex(cfg); // cheap when nothing changed
  const p = ` ${norm(prompt)} `;
  // a skill named literally in the request ("decision council") wins outright
  const named = db(cfg).prepare('select id, name, description from skills').all()
    .filter(s => norm(s.name).length > 3 && p.includes(` ${norm(s.name)} `));
  const hits = await search(cfg, prompt, 3);
  const strong = hits.filter(h => isStrong(cfg, [h], prompt)); // per hit: same rule as the library-wide check
  const seen = new Set();
  const picks = [...named, ...strong].filter(s => !seen.has(s.id) && seen.add(s.id)).slice(0, cfg.suggestMax);

  let text = '';
  let external = [];
  if (picks.length) {
    text = "Skills in this project's library match this request. They hold this team's conventions and checklists, which override your defaults. " +
      `Load the best match BEFORE you start, then follow it. Skip only if none of them are about this task. ${SKILLS_LINE}\n` +
      picks.map(s => `- ${s.id}: ${s.description.slice(0, 160)}`).join('\n');
    noteSuggested(cfg, picks.map(s => s.id));
  } else if (cfg.external) {
    try { external = await searchRegistryByGap(cfg, prompt); } catch { /* offline */ }
    if (external.length) text = 'No skill in the library covers this request. Public registry candidates (best match first; unvetted): ' +
      'if one is clearly about this task and comes from a reputable source, `headjack get --acquire <id>` fetches it into the library.\n' +
      external.map(s => `- ${s.id} (${s.installs} installs)`).join('\n');
  }

  upsert(cfg, (s, day) => {
    s.totals.prompts++; day.prompts++;
    if (picks.length) {
      s.totals.suggested_prompts++; s.totals.suggestions += picks.length; day.suggested++;
      for (const k of picks) skillStat(s, k.id).suggested++;
    } else if (prompt.trim().split(/\s+/).length >= 6) {
      s.gaps.push({ at: new Date().toISOString(), q: prompt.slice(0, 140), registry: external.map(e => e.id).slice(0, 3) });
    }
    s.totals.est_tokens_injected += Math.round(text.length / 3.5);
  });
  return text;
}
